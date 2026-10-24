import { randomUUID } from "node:crypto";

export const DEFAULT_JOB_LEASE_MS = 2 * 60_000;
export const DEFAULT_MAX_JOB_ATTEMPTS = 3;
export const JOB_FAILURE_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const ACTIVE_COLLECTION_JOB_STATUSES = new Set(["queued", "running", "paused"]);

const COLLECTION_JOB_PRIORITY = {
  post_follow_up: 0,
  creator: 1,
  source_watch: 1,
  following_import: 1,
  creator_backfill: 2,
  event_track: 3,
  early_search: 4,
  chinese_hot: 5,
  root_trace: 6,
  trend: 7,
  term_backfill: 8,
  industry: 9
};

const QUERY_SCOPED_JOB_TYPES = new Set(["industry", "term_backfill", "early_search", "chinese_hot"]);
const URGENT_COLLECTION_JOB_TYPES = new Set(["post_follow_up", "creator", "following_import"]);
const DISCOVERY_COLLECTION_JOB_TYPES = new Set(["industry", "term_backfill", "early_search", "chinese_hot", "event_track", "root_trace", "trend"]);
const COLLECTION_AGING_INTERVAL_MS = 15 * 60_000;

export function collectionJobKey(job = {}) {
  const identity = job.postId || job.eventId || job.sourceId || job.trendingKeywordId || job.sourcePostId || job.targetId || "";
  const query = QUERY_SCOPED_JOB_TYPES.has(job.targetType) || !identity ? String(job.query || "").trim().toLocaleLowerCase() : "";
  return [job.targetType || "unknown", job.platform || "x", identity, query].map(value => String(value)).join("\u001f");
}

export function enqueueCollectionJob(jobs = [], job = {}) {
  const key = collectionJobKey(job);
  const existing = jobs.find(value => ACTIVE_COLLECTION_JOB_STATUSES.has(value.status) && collectionJobKey(value) === key);
  if (existing) return { job: existing, created: false };
  jobs.push(job);
  return { job, created: true };
}

export function compareCollectionJobs(a = {}, b = {}, now = Date.now()) {
  const urgentRank = job => URGENT_COLLECTION_JOB_TYPES.has(job.targetType) ? 0 : 1;
  const ageCredit = job => {
    const requestedAt = Date.parse(job.requestedAt || "");
    return Number.isFinite(requestedAt) ? Math.max(0, now - requestedAt) / COLLECTION_AGING_INTERVAL_MS : 0;
  };
  return Number(Boolean(b.queueBoostAt)) - Number(Boolean(a.queueBoostAt))
    || urgentRank(a) - urgentRank(b)
    || ((COLLECTION_JOB_PRIORITY[a.targetType] ?? 10) - ageCredit(a)) - ((COLLECTION_JOB_PRIORITY[b.targetType] ?? 10) - ageCredit(b))
    || String(a.requestedAt || "").localeCompare(String(b.requestedAt || ""));
}

export function selectCollectionJobs(jobs = [], limit = 1, now = Date.now()) {
  const sorted = [...jobs].sort((a, b) => compareCollectionJobs(a, b, now));
  const count = Math.max(0, Number(limit) || 0);
  if (count < 2 || sorted.length < 2) return sorted.slice(0, count);
  const selected = [sorted[0]];
  const firstIsDiscovery = DISCOVERY_COLLECTION_JOB_TYPES.has(sorted[0].targetType);
  const reserved = sorted.find(job => !selected.includes(job) && DISCOVERY_COLLECTION_JOB_TYPES.has(job.targetType) !== firstIsDiscovery);
  if (reserved) selected.push(reserved);
  for (const job of sorted) {
    if (selected.length >= count) break;
    if (!selected.includes(job)) selected.push(job);
  }
  return selected;
}

function terminalTime(job = {}) {
  return Date.parse(job.finishedAt || job.startedAt || job.requestedAt || "");
}

export function collectionRetryState(jobs = [], successDelayMs = 0, now = Date.now()) {
  const history = jobs
    .filter(job => ["complete", "failed"].includes(job.status) && Number.isFinite(terminalTime(job)))
    .sort((a, b) => terminalTime(b) - terminalTime(a));
  const latest = history[0];
  if (!latest) return { due: true, delayMs: 0, consecutiveFailures: 0, nextAt: null };

  let consecutiveFailures = 0;
  if (latest.status === "failed") {
    for (const job of history) {
      if (job.status !== "failed") break;
      consecutiveFailures += 1;
    }
  }
  const delayMs = consecutiveFailures
    ? JOB_FAILURE_BACKOFF_MS[Math.min(consecutiveFailures - 1, JOB_FAILURE_BACKOFF_MS.length - 1)]
    : Math.max(0, Number(successDelayMs) || 0);
  const nextAtMs = terminalTime(latest) + delayMs;
  return {
    due: now >= nextAtMs,
    delayMs,
    consecutiveFailures,
    nextAt: new Date(nextAtMs).toISOString()
  };
}

export function recoverExpiredLeases(jobs = [], now = Date.now()) {
  let recovered = 0;
  let exhausted = 0;

  for (const job of jobs) {
    if (job.status !== "running") continue;
    const leaseExpiresAt = job.leaseExpiresAt
      ? Date.parse(job.leaseExpiresAt)
      : Date.parse(job.startedAt) + DEFAULT_JOB_LEASE_MS;
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > now) continue;

    job.leaseExpiresAt = null;
    job.leaseNonce = null;
    job.leaseNodeId = null;
    if (Number(job.attempts || 0) >= Number(job.maxAttempts || DEFAULT_MAX_JOB_ATTEMPTS)) {
      job.status = "failed";
      job.finishedAt = new Date(now).toISOString();
      job.error = "采集任务租约连续超时";
      exhausted += 1;
    } else {
      job.status = "queued";
      job.startedAt = null;
      job.executorProvider = null;
      job.providerRole = null;
      job.error = "上次采集未在租约时间内回传，已重新排队";
      recovered += 1;
    }
  }

  return { recovered, exhausted };
}

export function leaseJob(job, now = Date.now(), leaseMs = DEFAULT_JOB_LEASE_MS, nodeId = "legacy-node") {
  job.status = "running";
  job.startedAt = new Date(now).toISOString();
  job.leaseExpiresAt = new Date(now + leaseMs).toISOString();
  job.leaseNonce = randomUUID();
  job.leaseNodeId = String(nodeId || "legacy-node");
  job.attempts = Number(job.attempts || 0) + 1;
  job.maxAttempts = Number(job.maxAttempts || DEFAULT_MAX_JOB_ATTEMPTS);
  return job;
}

export function validateJobLease(job, input = {}, now = Date.now()) {
  if (!job) return { ok: false, code: "JOB_NOT_FOUND", error: "采集任务不存在" };
  if (job.resultHash) return { ok: true, duplicate: true };
  if (job.status !== "running") return { ok: false, code: "LEASE_INACTIVE", error: "任务当前没有有效租约" };
  if (!job.leaseNonce || String(input.leaseNonce || "") !== String(job.leaseNonce)) {
    return { ok: false, code: "LEASE_MISMATCH", error: "任务租约代次不匹配" };
  }
  if (!job.leaseNodeId || String(input.nodeId || "") !== String(job.leaseNodeId)) {
    return { ok: false, code: "NODE_MISMATCH", error: "采集节点与任务租约不匹配" };
  }
  if (!Number.isFinite(Date.parse(job.leaseExpiresAt)) || Date.parse(job.leaseExpiresAt) <= now) {
    return { ok: false, code: "LEASE_EXPIRED", error: "任务租约已过期，迟到结果已拒绝" };
  }
  return { ok: true, duplicate: false };
}

export function finishJobLease(job) {
  job.leaseExpiresAt = null;
  job.leaseNonce = null;
  job.leaseNodeId = null;
  return job;
}
