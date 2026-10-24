import { createHash } from "node:crypto";

const GRADE_RANK = { ordinary: 0, candidate: 0, low_quality: 0, T1: 1, T2: 2, T3: 3 };
const FORMULA_VERSION = "rm-tier-v1";
const HOUR = 3_600_000;

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function platformOf(post) {
  if (post.platform) return post.platform;
  return String(post.source || "").startsWith("douyin") ? "douyin" : "x";
}

function handleOf(post) {
  return String(post.platformAuthorId || post.handle || post.author || "").replace(/^@/, "").toLowerCase();
}

export function coreMetric(platform, post) {
  if (!["x", "douyin"].includes(platform)) return null;
  const likes = Number(post?.likes);
  return Number.isFinite(likes) && likes >= 0 ? likes : null;
}

export function tierOf(followers) {
  const count = Number(followers);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count < 10_000) return { tier: "C", label: "素人", douyinMBase: 0.30 };
  if (count < 100_000) return { tier: "B", label: "腰部", douyinMBase: 0.15 };
  if (count < 1_000_000) return { tier: "A", label: "中部", douyinMBase: 0.08 };
  return { tier: "S", label: "头部", douyinMBase: 0.04 };
}

export function baselineFor(target, posts, options = {}) {
  const platform = platformOf(target);
  const targetPublishedAt = timeOf(target.publishedAt);
  const freezeAt = timeOf(options.freezeAt) ?? Date.now();
  if (targetPublishedAt === null) return { ready: false, reason: "missing_published_at", baseline: null, samples: [] };
  const targetHandle = handleOf(target);
  const snapshotsByPost = options.snapshotsByPost instanceof Map ? options.snapshotsByPost : new Map();
  const valueAtFreeze = post => {
    const key = `${platform}:${post.id}`;
    const snapshot = (snapshotsByPost.get(key) || [])
      .filter(item => {
        const capturedAt = timeOf(item.capturedAt);
        return capturedAt !== null && capturedAt <= freezeAt && coreMetric(platform, item) !== null;
      })
      .sort((a, b) => timeOf(b.capturedAt) - timeOf(a.capturedAt))[0];
    if (snapshot) return { value: coreMetric(platform, snapshot), capturedAt: snapshot.capturedAt };
    const capturedAt = timeOf(post.capturedAt);
    if (capturedAt !== null && capturedAt <= freezeAt && coreMetric(platform, post) !== null) {
      return { value: coreMetric(platform, post), capturedAt: post.capturedAt };
    }
    return null;
  };
  const samples = posts
    .filter(post => String(post.id) !== String(target.id))
    .filter(post => platformOf(post) === platform && handleOf(post) === targetHandle)
    .filter(post => {
      const publishedAt = timeOf(post.publishedAt);
      if (publishedAt === null || publishedAt >= targetPublishedAt || publishedAt > freezeAt) return false;
      if (post.isAd || post.contentType === "repost" || post.isPureRepost || post.dataConfidence === "invalid") return false;
      return valueAtFreeze(post) !== null;
    })
    .sort((a, b) => timeOf(b.publishedAt) - timeOf(a.publishedAt))
    .slice(0, Number(options.window || 20))
    .map(post => {
      const frozen = valueAtFreeze(post);
      return {
        postId: String(post.id),
        publishedAt: post.publishedAt,
        capturedAt: frozen.capturedAt,
        value: frozen.value
      };
    });
  if (samples.length < Number(options.minimum || 5)) {
    return { ready: false, reason: "insufficient_history", baseline: samples.length ? Math.max(median(samples.map(item => item.value)), 1) : null, samples };
  }
  return { ready: true, reason: null, baseline: Math.max(median(samples.map(item => item.value)), 1), samples };
}

export function gradeWork(r, m, mBase) {
  if (![r, m, mBase].every(value => Number.isFinite(Number(value)))) return { grade: "candidate", label: "候选" };
  if (r >= 8 && m >= 3 * mBase) return { grade: "T3", label: "现象级" };
  if (r >= 4 && m >= 1.5 * mBase) return { grade: "T2", label: "爆款" };
  if (r >= 2 && m >= mBase) return { grade: "T1", label: "小爆" };
  if (r >= 2 && m < mBase) return { grade: "low_quality", label: "低质异常" };
  return { grade: "ordinary", label: "普通" };
}

export function calibrateXThresholds(samples, now = Date.now()) {
  const grouped = { C: [], B: [], A: [], S: [] };
  for (const sample of samples) {
    const tier = tierOf(sample.followers)?.tier;
    const likes = Number(sample.likes);
    const followers = Number(sample.followers);
    const publishedAt = timeOf(sample.publishedAt);
    if (!tier || !Number.isFinite(likes) || likes < 0 || !publishedAt || publishedAt > now) continue;
    if (sample.isAd || sample.isPureRepost || sample.contentType === "repost") continue;
    grouped[tier].push({ ...sample, m: likes / followers, publishedAt });
  }
  const output = {};
  for (const [tier, values] of Object.entries(grouped)) {
    values.sort((a, b) => a.m - b.m);
    const trim = Math.floor(values.length * 0.01);
    const trimmed = trim ? values.slice(trim, values.length - trim) : values;
    const creators = new Set(values.map(value => String(value.creatorId || value.handle || ""))).size;
    const earliest = values.length ? Math.min(...values.map(value => value.publishedAt)) : now;
    const days = (now - earliest) / (24 * HOUR);
    const ready = days >= 14 && values.length >= 200 && creators >= 20;
    output[tier] = {
      ready,
      mBase: ready ? percentile(trimmed.map(value => value.m), 0.75) : null,
      sampleCount: values.length,
      creatorCount: creators,
      days: Number(days.toFixed(2))
    };
  }
  return output;
}

export function ratePost(target, context = {}) {
  const platform = platformOf(target);
  const frozenEvidence = context.frozenEvidence || null;
  const followers = Number(frozenEvidence?.followers ?? context.frozenFollowers ?? context.followers);
  const tier = tierOf(followers);
  const baseline = frozenEvidence
    ? { ready: true, reason: null, baseline: Number(frozenEvidence.baseline), samples: frozenEvidence.samples || [] }
    : baselineFor(target, context.posts || [], {
        freezeAt: context.freezeAt,
        window: 20,
        minimum: 5,
        snapshotsByPost: context.snapshotsByPost
      });
  const likes = coreMetric(platform, target);
  const previousGrade = context.previousGrade || "ordinary";
  if (likes === null) return candidate("missing_likes", { platform, tier, baseline, likes, followers });
  if (!tier) return candidate("missing_followers", { platform, tier, baseline, likes, followers });
  if (!baseline.ready) return candidate(baseline.reason, { platform, tier, baseline, likes, followers });
  const threshold = frozenEvidence
    ? { ready: true, mBase: Number(frozenEvidence.mBase), version: frozenEvidence.thresholdVersion }
    : platform === "douyin"
      ? { ready: true, mBase: tier.douyinMBase, version: "douyin-fixed-v1" }
      : context.xThresholds?.[tier.tier];
  if (!threshold?.ready || !Number.isFinite(Number(threshold.mBase))) {
    return candidate("x_threshold_uncalibrated", {
      platform, tier, baseline, likes, followers,
      r: likes / baseline.baseline
    });
  }
  const r = likes / baseline.baseline;
  const m = likes / followers;
  const computed = gradeWork(r, m, Number(threshold.mBase));
  const grade = GRADE_RANK[previousGrade] > GRADE_RANK[computed.grade] ? previousGrade : computed.grade;
  const label = grade === previousGrade && grade !== computed.grade
    ? ({ T1: "小爆", T2: "爆款", T3: "现象级" }[grade] || computed.label)
    : computed.label;
  const evidence = {
    formulaVersion: FORMULA_VERSION,
    platform,
    postId: String(target.id),
    likes,
    followers,
    tier: tier.tier,
    baseline: baseline.baseline,
    samples: baseline.samples,
    r,
    m,
    mBase: Number(threshold.mBase),
    thresholdVersion: threshold.version || "x-calibrated",
    computedGrade: computed.grade,
    retainedGrade: grade,
    frozenAt: context.freezeAt || new Date().toISOString()
  };
  const formal = ["T1", "T2", "T3"].includes(grade);
  return {
    ready: true,
    reason: null,
    grade,
    label,
    computedGrade: computed.grade,
    r,
    m,
    mBase: Number(threshold.mBase),
    tier: tier.tier,
    tierLabel: tier.label,
    baseline: baseline.baseline,
    evidence: formal ? { ...evidence, evidenceHash: sha256(evidence) } : null
  };
}

function candidate(reason, values) {
  return {
    ready: false,
    reason,
    grade: "candidate",
    label: "候选",
    r: values.r ?? (values.likes !== null && values.baseline?.baseline ? values.likes / values.baseline.baseline : null),
    m: values.likes !== null && values.followers > 0 ? values.likes / values.followers : null,
    mBase: null,
    tier: values.tier?.tier || null,
    tierLabel: values.tier?.label || null,
    baseline: values.baseline?.baseline || null,
    sampleCount: values.baseline?.samples?.length || 0,
    evidence: null
  };
}

function nearest(values, target, toleranceMs) {
  return values
    .map(value => ({ value, distance: Math.abs(value.time - target) }))
    .filter(item => item.distance <= toleranceMs)
    .sort((a, b) => a.distance - b.distance || b.value.time - a.value.time)[0]?.value || null;
}

export function momentumStatus(snapshots, options = {}) {
  const toleranceMs = Number(options.toleranceMinutes || 45) * 60_000;
  const intervalMinutes = Number(options.intervalMinutes || 60);
  const values = snapshots
    .map(snapshot => ({ ...snapshot, time: timeOf(snapshot.capturedAt), likes: Number(snapshot.likes) }))
    .filter(value => value.time !== null && Number.isFinite(value.likes))
    .sort((a, b) => a.time - b.time);
  if (!values.length) return { status: "observing", label: "观察中", reason: "no_snapshots", evidence: null, coolingStreak: 0 };
  const current = values.at(-1);
  const now = Number(options.now || Date.now());
  if (now - current.time > (intervalMinutes + 15) * 60_000) {
    return { status: "insufficient", label: "数据不足", reason: "stale_snapshot", evidence: null, coolingStreak: 0 };
  }
  const at2 = nearest(values, current.time - 2 * HOUR, toleranceMs);
  const at4 = nearest(values, current.time - 4 * HOUR, toleranceMs);
  if (!at2 || !at4 || !(at4.time < at2.time && at2.time < current.time)) {
    return { status: "observing", label: "观察中", reason: "missing_window", evidence: null, coolingStreak: 0 };
  }
  const recentDelta = current.likes - at2.likes;
  const previousDelta = at2.likes - at4.likes;
  if (recentDelta < 0 || previousDelta < 0) {
    return { status: "anomaly", label: "数据异常", reason: "negative_growth", evidence: { current, at2, at4 }, coolingStreak: 0 };
  }
  const recentHours = (current.time - at2.time) / HOUR;
  const previousHours = (at2.time - at4.time) / HOUR;
  const recentVelocity = recentDelta / recentHours;
  const previousVelocity = previousDelta / previousHours;
  const growth = at2.likes > 0 ? recentDelta / at2.likes : (recentDelta > 0 ? Infinity : 0);
  const ratio = previousVelocity > 0 ? recentVelocity / previousVelocity : (recentVelocity > 0 ? Infinity : 0);
  const evidence = { current, at2, at4, recentDelta, previousDelta, recentVelocity, previousVelocity, ratio, growth };

  const zeroRiseMinimum = Math.max(10, at2.likes * 0.10);
  const zeroBurstMinimum = Math.max(20, at2.likes * 0.20);
  if ((previousVelocity > 0 && ratio >= 2 && growth >= 0.20) || (previousVelocity === 0 && recentDelta >= zeroBurstMinimum)) {
    return { status: "burst", label: "爆发", reason: "velocity_burst", evidence, coolingStreak: 0 };
  }
  if ((previousVelocity > 0 && ratio >= 1.25 && growth >= 0.10) || (previousVelocity === 0 && recentDelta >= zeroRiseMinimum)) {
    return { status: "rising", label: "升温", reason: "velocity_rising", evidence, coolingStreak: 0 };
  }
  const coolingStreak = ratio < 0.5 ? Number(options.previousCoolingStreak || 0) + 1 : 0;
  if (coolingStreak >= 2) return { status: "cooling", label: "冷却", reason: "velocity_decline", evidence, coolingStreak };
  return { status: "steady", label: "平稳", reason: "velocity_steady", evidence, coolingStreak };
}

export { FORMULA_VERSION, median, percentile };
