export const COLLECTOR_PLATFORMS = ["x", "douyin"];
export const RISK_ERROR_CODES = new Set(["AUTH_REQUIRED", "CHALLENGE_REQUIRED", "RATE_LIMITED"]);
export const PROVIDER_QUOTA_ERROR_CODES = new Set(["6551_QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"]);
export const COLLECTOR_PHASES = new Set([
  "leased", "opening_page", "waiting_content", "scrolling", "detail_enrichment", "submitting", "complete", "failed", "idle", "paused"
]);

export function normalizeCollectorPhase(value) {
  return COLLECTOR_PHASES.has(String(value)) ? String(value) : "unknown";
}

export function ensureCollectorRuntime(state) {
  state.collectionSettings = { x: true, douyin: true, ...(state.collectionSettings || {}) };
  state.collector ||= { status: "waiting_extension", lastRunAt: null, lastError: null };
  state.collector.platforms ||= {};
  state.collector.schedule ||= null;
  for (const platform of COLLECTOR_PLATFORMS) {
    state.collector.platforms[platform] = {
      status: "waiting_extension",
      phase: "idle",
      currentJobId: null,
      lastProgressAt: null,
      lastSuccessAt: null,
      lastError: null,
      errorCode: null,
      providerBlockedUntil: null,
      providerBlockReason: null,
      pausedReason: null,
      ...(state.collector.platforms[platform] || {})
    };
    if (state.collectionSettings[platform] === false && !state.collector.platforms[platform].pausedReason) {
      state.collector.platforms[platform].status = "disabled";
      state.collector.platforms[platform].phase = "paused";
      state.collector.platforms[platform].pausedReason = "platform_disabled";
    }
  }
  return state.collector.platforms;
}

export function platformEnabled(state, platform) {
  ensureCollectorRuntime(state);
  const key = platform === "douyin" ? "douyin" : "x";
  return state.collectionSettings[key] !== false && !state.collector.platforms[key].pausedReason;
}

export function pausePlatformJobs(state, platform, reason) {
  ensureCollectorRuntime(state);
  const runtime = state.collector.platforms[platform];
  runtime.status = reason === "platform_disabled" ? "disabled" : "paused";
  runtime.pausedReason = reason;
  runtime.currentJobId = null;
  runtime.phase = "paused";
  let paused = 0;
  for (const job of state.jobs || []) {
    if ((job.platform || "x") !== platform || job.status !== "queued") continue;
    job.status = "paused";
    job.pausedReason = reason;
    paused += 1;
  }
  return paused;
}

export function resumePlatformJobs(state, platform, reason = null) {
  ensureCollectorRuntime(state);
  const runtime = state.collector.platforms[platform];
  runtime.status = "waiting_extension";
  runtime.pausedReason = null;
  runtime.errorCode = null;
  runtime.lastError = null;
  runtime.phase = "idle";
  let resumed = 0;
  for (const job of state.jobs || []) {
    if ((job.platform || "x") !== platform || job.status !== "paused") continue;
    if (reason && job.pausedReason !== reason) continue;
    job.status = "queued";
    job.pausedReason = null;
    job.executorProvider = null;
    job.providerRole = null;
    resumed += 1;
  }
  return resumed;
}

export function platformQueueSummary(state, platform, now = Date.now()) {
  ensureCollectorRuntime(state);
  const jobs = (state.jobs || []).filter(job => (job.platform || "x") === platform);
  const recent = jobs.filter(job => {
    const value = Date.parse(job.finishedAt || job.startedAt || job.requestedAt || "");
    return Number.isFinite(value) && value >= now - 3_600_000;
  });
  const complete = recent.filter(job => job.status === "complete").length;
  const failed = recent.filter(job => job.status === "failed").length;
  return {
    queued: jobs.filter(job => job.status === "queued").length,
    running: jobs.filter(job => job.status === "running").length,
    paused: jobs.filter(job => job.status === "paused").length,
    failed: jobs.filter(job => job.status === "failed").length,
    recentSuccessRate: complete + failed ? complete / (complete + failed) : null
  };
}

export function strangerBackfillAllowed(state, job, now = Date.now(), hourlyLimit = 20) {
  const sourceFor = value => (state.sourceRegistry || []).find(item => item.id === value.sourceId);
  const knownSource = value => {
    const source = sourceFor(value);
    return source && (["trusted", "long_term"].includes(source.status) || source.sourceType === "official");
  };
  if (!["creator_backfill", "source_watch"].includes(job.targetType)) return true;
  if (job.targetType === "source_watch" && knownSource(job)) return true;
  const platform = job.platform || "x";
  const recent = (state.jobs || []).filter(item =>
    (item.platform || "x") === platform &&
    ["creator_backfill", "source_watch"].includes(item.targetType) &&
    !(item.targetType === "source_watch" && knownSource(item)) &&
    Number.isFinite(Date.parse(item.startedAt)) &&
    Date.parse(item.startedAt) >= now - 3_600_000
  );
  return recent.length < hourlyLimit;
}

export function expireStaleJobs(state, now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60_000) {
  const expired = [];
  for (const job of state.jobs || []) {
    if (job.status !== "queued") continue;
    const createdAt = Date.parse(job.requestedAt || job.createdAt || "");
    if (!Number.isFinite(createdAt) || now - createdAt <= maxAgeMs) continue;
    job.status = "expired";
    job.phase = "expired";
    job.finishedAt = new Date(now).toISOString();
    job.lastProgressAt = job.finishedAt;
    job.statusReason = "超过 7 天有效采集窗口";
    job.error = null;
    expired.push(job.id);
  }
  return expired;
}
