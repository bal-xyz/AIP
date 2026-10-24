import { buildEvents } from "./event-engine.mjs";
import { COLLECTOR_PLATFORMS, ensureCollectorRuntime, platformQueueSummary } from "./collector-runtime.mjs";
import { calibrateXThresholds, momentumStatus, ratePost } from "./grading.mjs";
import { ensureMonitoringRules, evaluateAIRelevance } from "./monitoring-terms.mjs";
import { payloadHash } from "./database.mjs";
import { evidenceConfidence } from "./evidence-confidence.mjs";

const HOUR = 3_600_000;
const GRADE_ORDER = { T3: 3, T2: 2, T1: 1, candidate: 0, low_quality: -1, ordinary: -2 };
const STAGE_ORDER = { burst: 5, hot: 4, spreading: 3, new: 2, pending: 1, cooling: 0, candidate: -1 };
const MOMENTUM_ORDER = { burst: 6, rising: 5, steady: 4, observing: 3, insufficient: 2, anomaly: 1, cooling: 0 };

function platformOf(item) {
  return item.platform || (String(item.source || "").startsWith("douyin") ? "douyin" : "x");
}

function handleKey(item) {
  return `${platformOf(item)}:${String(item.platformAuthorId || item.handle || "").replace(/^@/, "").toLowerCase()}`;
}

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function sourceType(state, post) {
  const key = String(post.handle || "").replace(/^@/, "").toLowerCase();
  const source = (state.sourceRegistry || []).find(item =>
    String(item.handle || "").replace(/^@/, "").toLowerCase() === key
  );
  return source?.sourceType || null;
}

function xThresholds(database) {
  const rows = database.db.prepare(`
    SELECT id, tier, m_base AS mBase, sample_count AS sampleCount,
           creator_count AS creatorCount, created_at AS createdAt
    FROM threshold_versions
    WHERE platform='x' AND active=1
    ORDER BY created_at DESC
  `).all();
  const output = {};
  for (const row of rows) {
    if (output[row.tier]) continue;
    output[row.tier] = { ready: true, version: row.id, ...row };
  }
  return output;
}

function ensureXThresholds(database, posts, creators, now) {
  const latestRows = database.db.prepare(`
    SELECT tier, created_at AS createdAt FROM threshold_versions
    WHERE platform='x' AND active=1 ORDER BY created_at DESC
  `).all();
  const latestByTier = new Map(latestRows.map(row => [row.tier, row]));
  const needsInitial = ["C", "B", "A", "S"].some(tier => !latestByTier.has(tier));
  const needsMonthly = latestRows.some(row => now - timeOf(row.createdAt) >= 30 * 24 * HOUR);
  if (!needsInitial && !needsMonthly) return;
  const recentStart = now - 30 * 24 * HOUR;
  const samples = posts
    .filter(post => platformOf(post) === "x")
    .filter(post => needsInitial || timeOf(post.publishedAt) >= recentStart)
    .map(post => {
      const creator = creators.get(handleKey(post));
      return { ...post, followers: post.followers ?? creator?.followers ?? creator?.followersApprox };
    });
  const calibration = calibrateXThresholds(samples, now);
  const createdAt = new Date(now).toISOString();
  const save = database.db.transaction(() => {
    for (const [tier, result] of Object.entries(calibration)) {
      const previous = latestByTier.get(tier);
      if (!result.ready || (previous && now - timeOf(previous.createdAt) < 30 * 24 * HOUR)) continue;
      database.db.prepare("UPDATE threshold_versions SET active=0 WHERE platform='x' AND tier=?").run(tier);
      database.db.prepare(`
        INSERT INTO threshold_versions(
          id, platform, tier, m_base, sample_count, creator_count,
          window_start, window_end, created_at, active
        ) VALUES(?, 'x', ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        `x-${tier}-${createdAt}`,
        tier,
        result.mBase,
        result.sampleCount,
        result.creatorCount,
        new Date(needsInitial ? Math.min(...samples.map(item => timeOf(item.publishedAt)).filter(Boolean)) : recentStart).toISOString(),
        createdAt,
        createdAt
      );
    }
  });
  save();
}

function persistGradeEvidence(database, post, quality) {
  if (!quality?.ready || !quality.evidence || !["T1", "T2", "T3"].includes(quality.grade)) return;
  const evidence = quality.evidence;
  const postKey = `${post.platform || "x"}:${post.id}`;
  database.db.prepare(`
    INSERT OR IGNORE INTO grade_evidence(
      post_key, grade, formula_version, threshold_version, baseline, followers,
      sample_payload, evidence_hash, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    postKey,
    quality.grade,
    evidence.formulaVersion,
    evidence.thresholdVersion,
    evidence.baseline,
    evidence.followers,
    JSON.stringify(evidence.samples || []),
    evidence.evidenceHash,
    evidence.frozenAt
  );
  const existingHistory = database.db.prepare("SELECT 1 FROM grade_history WHERE post_key=? AND grade=?").get(postKey, quality.grade);
  if (!existingHistory) {
    database.db.prepare(`
      INSERT INTO grade_history(id, post_key, grade, r_value, m_value, evidence_hash, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(`grade-${evidence.evidenceHash}`, postKey, quality.grade, quality.r, quality.m, evidence.evidenceHash, evidence.frozenAt);
  }
}

function coverageWindows(state, now, relatedPosts = null, windowCount = 2) {
  const collectorSeenAt = timeOf(state.collector?.lastRunAt);
  const nodeRecentlySeen = ["connected", "collecting"].includes(state.collector?.status) &&
    collectorSeenAt > 0 && now - collectorSeenAt <= 20 * 60_000;
  const output = [];
  const relatedPlatforms = relatedPosts ? new Set(relatedPosts.map(platformOf)) : null;
  const relatedHandles = relatedPosts ? new Set(relatedPosts.map(handleKey)) : null;
  const relatedQueryIds = relatedPosts ? new Set(relatedPosts.map(post => post.discovery?.queryId).filter(Boolean)) : null;
  const enabledPlatforms = new Set(COLLECTOR_PLATFORMS.filter(platform => state.collectionSettings?.[platform] !== false));
  for (let offset = Math.max(1, Number(windowCount) || 2); offset >= 1; offset -= 1) {
    const start = now - offset * 2 * HOUR;
    const end = start + 2 * HOUR;
    const jobs = (state.jobs || []).filter(job => {
      const requestedAt = timeOf(job.requestedAt);
      if (!(requestedAt >= start && requestedAt < end)) return false;
      const jobPlatform = job.platform || "x";
      if (!enabledPlatforms.has(jobPlatform)) return false;
      if (!relatedPosts) return true;
      if (!relatedPlatforms.has(jobPlatform)) return false;
      if (relatedQueryIds.has(job.id)) return true;
      const key = `${jobPlatform}:${String(job.platformAuthorId || job.handle || "").replace(/^@/, "").toLowerCase()}`;
      return relatedHandles.has(key) || ["industry", "trend", "early_search", "event_track", "chinese_hot"].includes(job.targetType);
    });
    const completed = jobs.filter(job => job.status === "complete").length;
    const failures = jobs.filter(job => job.status === "failed");
    const countStatus = status => jobs.filter(job => job.status === status).length;
    const failureReasons = Object.entries(failures.reduce((counts, job) => {
      const reason = String(job.lastError || job.error || job.errorCode || "未知失败").trim();
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => ({ reason, count }));
    output.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      nodeHealthy: nodeRecentlySeen,
      successRate: jobs.length ? completed / jobs.length : 0,
      authRequired: failures.some(job => job.errorCode === "AUTH_REQUIRED" || /登录/.test(job.error || "")),
      parserFailure: failures.some(job => job.errorCode === "SCRIPT_ERROR" || /解析|读取/.test(job.error || "")),
      scheduled: jobs.length,
      completed,
      queued: countStatus("queued"),
      running: countStatus("running"),
      failed: failures.length,
      paused: countStatus("paused"),
      failureReasons
    });
  }
  return output;
}

function metrics(post) {
  return {
    likes: Number.isFinite(Number(post.likes)) ? Number(post.likes) : null,
    replies: Number.isFinite(Number(post.replies)) ? Number(post.replies) : null,
    reposts: Number.isFinite(Number(post.reposts)) ? Number(post.reposts) : null,
    bookmarks: post.bookmarksAvailable && Number.isFinite(Number(post.bookmarks)) ? Number(post.bookmarks) : null,
    views: Number.isFinite(Number(post.views)) && Number(post.views) > 0 ? Number(post.views) : null
  };
}

function analysisMap(database, taskType = null) {
  const taskFilter = taskType ? "AND at.task_type=?" : "";
  const params = taskType ? [taskType] : [];
  const rows = database.db.prepare(`
    SELECT ar.payload, ar.provider, ar.model, ar.created_at AS createdAt,
           at.task_type AS taskType, at.entity_id AS entityId, at.version_key AS versionKey
    FROM analysis_results ar
    JOIN analysis_tasks at ON at.id=ar.task_id
    WHERE at.entity_type='post' ${taskFilter}
    ORDER BY ar.created_at DESC
  `).all(...params);
  const output = new Map();
  for (const row of rows) {
    if (output.has(String(row.entityId))) continue;
    try {
      output.set(String(row.entityId), {
        ...JSON.parse(row.payload),
        provider: row.provider,
        model: row.model,
        createdAt: row.createdAt,
        taskType: row.taskType,
        versionKey: row.versionKey
      });
    } catch {
      // An invalid historical result stays hidden; its task remains available in the audit tables.
    }
  }
  return output;
}

function analysisTaskMap(database, taskType = "l1") {
  const rows = database.db.prepare(`
    SELECT id, task_type AS taskType, entity_id AS entityId, version_key AS versionKey, status,
           status_reason AS statusReason, error, created_at AS createdAt,
           started_at AS startedAt, finished_at AS finishedAt
    FROM analysis_tasks
    WHERE entity_type='post' AND task_type=?
    ORDER BY COALESCE(finished_at, started_at, created_at) DESC
  `).all(taskType);
  const output = new Map();
  for (const row of rows) if (!output.has(String(row.entityId))) output.set(String(row.entityId), row);
  return output;
}

function transcriptMap(database) {
  const rows = database.db.prepare("SELECT * FROM transcripts ORDER BY updated_at DESC").all();
  const output = new Map();
  for (const row of rows) if (!output.has(String(row.post_key))) output.set(String(row.post_key), row);
  return output;
}

export function evidenceState(post, creator, authorPosts = [], snapshots = []) {
  const missing = [];
  const likes = Number(post.likes);
  const followers = Number(post.followers ?? creator?.followers ?? creator?.followersApprox);
  const hasText = String(post.text || "").trim().length > 0;
  if (!hasText) missing.push("正文");
  if (!Number.isFinite(likes) || likes < 0) missing.push("点赞数");
  if (!Number.isFinite(followers) || followers <= 0) missing.push("粉丝数");
  const targetTime = timeOf(post.publishedAt);
  const historySamples = authorPosts.filter(item => {
    const itemTime = timeOf(item.publishedAt);
    return String(item.id) !== String(post.id) && Number.isFinite(Number(item.likes)) && Number(item.likes) >= 0 && !item.isAd && !item.isPureRepost && item.contentType !== "repost" && item.dataConfidence !== "invalid" && (targetTime === 0 || (itemTime > 0 && itemTime < targetTime));
  });
  if (historySamples.length < 5) missing.push("历史基线");
  if (snapshots.length < 2) missing.push("连续快照");
  const invalid = post.dataConfidence === "invalid" || post.invalid === true;
  const completeness = invalid ? "invalid" : missing.length === 0 ? "complete" : (likes >= 0 && hasText ? "partial" : "pending");
  return { completeness, missingEvidence: missing, historySampleCount: historySamples.length, snapshotCount: snapshots.length };
}

function dedupePosts(posts) {
  const seen = new Map();
  for (const post of posts) {
    const key = `${platformOf(post)}:${String(post.id)}`;
    const previous = seen.get(key);
    if (!previous || timeOf(post.capturedAt || post.publishedAt) >= timeOf(previous.capturedAt || previous.publishedAt)) seen.set(key, post);
  }
  return [...seen.values()];
}

export function buildDashboard(state, database, options = {}) {
  const now = Number(options.now || Date.now());
  ensureCollectorRuntime(state);
  state.industries = ensureMonitoringRules(state.industries || []);
  const rules = state.industries;
  const creators = new Map((state.creators || []).map(creator => [handleKey(creator), creator]));
  const sourcePosts = dedupePosts(state.posts || []);
  const postsByAuthor = new Map();
  for (const post of sourcePosts) {
    const key = handleKey(post);
    if (!postsByAuthor.has(key)) postsByAuthor.set(key, []);
    postsByAuthor.get(key).push(post);
  }
  const snapshotsByPost = new Map();
  for (const snapshot of state.snapshots || []) {
    const key = `${platformOf(snapshot)}:${snapshot.postId}`;
    if (!snapshotsByPost.has(key)) snapshotsByPost.set(key, []);
    snapshotsByPost.get(key).push(snapshot);
  }
  const collectionJobsByPost = new Map();
  for (const job of state.jobs || []) {
    const postId = job.postId || job.targetId;
    if (!postId) continue;
    const previous = collectionJobsByPost.get(String(postId));
    const jobTime = timeOf(job.finishedAt || job.requestedAt);
    const previousTime = previous ? timeOf(previous.finishedAt || previous.requestedAt) : 0;
    if (!previous || jobTime >= previousTime) collectionJobsByPost.set(String(postId), job);
  }
  ensureXThresholds(database, sourcePosts, creators, now);
  const thresholds = xThresholds(database);
  const analyses = analysisMap(database, "l1");
  const deepAnalyses = analysisMap(database, "l2");
  const relevanceAnalyses = analysisMap(database, "relevance");
  const l1Tasks = analysisTaskMap(database, "l1");
  const l2Tasks = analysisTaskMap(database, "l2");
  const transcripts = transcriptMap(database);
  let changed = false;
  const posts = sourcePosts.map(post => {
    const platform = platformOf(post);
    const creator = creators.get(handleKey(post));
    const ruleRelevance = evaluateAIRelevance(post, rules);
    const relevanceVersionKey = payloadHash({ id: post.id, text: post.text, topics: post.topics || [], matchedRuleIds: ruleRelevance.matchedRuleIds || [], capturedAt: post.capturedAt });
    const modelRelevance = relevanceAnalyses.get(String(post.id));
    const relevance = modelRelevance?.versionKey === relevanceVersionKey && typeof modelRelevance.relevant === "boolean"
      ? { relevant: modelRelevance.relevant, confidence: Number(modelRelevance.confidence), reason: (modelRelevance.reasons || []).join("；"), caveats: modelRelevance.caveats || [], matchedRuleIds: ruleRelevance.matchedRuleIds || [], source: "model", analyzedAt: modelRelevance.createdAt }
      : ruleRelevance;
    const existingQuality = post.quality || null;
    const hasFormalFrozenEvidence = ["T1", "T2", "T3"].includes(existingQuality?.grade) && existingQuality?.evidence;
    const quality = ratePost({ ...post, platform }, {
      followers: post.followers ?? creator?.followers ?? creator?.followersApprox,
      posts: postsByAuthor.get(handleKey(post)) || [],
      xThresholds: thresholds,
      freezeAt: hasFormalFrozenEvidence ? existingQuality.evidence.frozenAt : new Date(now).toISOString(),
      frozenEvidence: hasFormalFrozenEvidence ? existingQuality.evidence : null,
      snapshotsByPost,
      previousGrade: existingQuality?.grade || "ordinary"
    });
    const postSnapshots = snapshotsByPost.get(`${platform}:${post.id}`) || [];
    const evidence = evidenceState(post, creator, postsByAuthor.get(handleKey(post)) || [], postSnapshots);
    const collectionJob = collectionJobsByPost.get(String(post.id));
    const collectionError = collectionJob?.error || collectionJob?.lastError || null;
    if (collectionJob?.status === "failed" && collectionError) {
      evidence.missingEvidence.push(`采集失败：${collectionError}`);
      evidence.completeness = "pending";
    }
    const task = l1Tasks.get(String(post.id));
    const result = analyses.get(String(post.id)) || null;
    const resultFresh = Boolean(result && (!task || result.versionKey === task.versionKey));
    const analysisState = resultFresh ? "complete" : task?.status === "running" ? "running" : ["queued", "waiting_model", "waiting_budget"].includes(task?.status) ? "queued" : task?.status === "failed" ? "failed" : "not_started";
    const deepTask = l2Tasks.get(String(post.id));
    const deepResult = deepAnalyses.get(String(post.id)) || null;
    const deepResultFresh = Boolean(deepResult && (!deepTask || deepResult.versionKey === deepTask.versionKey));
    const deepAnalysisState = deepResultFresh ? "complete" : deepTask?.status === "running" ? "running" : ["queued", "waiting_model", "waiting_budget"].includes(deepTask?.status) ? "queued" : deepTask?.status === "failed" ? "failed" : "not_started";
    const transcript = transcripts.get(`${platform}:${post.id}`) || null;
    const availableActions = [];
    if (analysisState !== "complete" && !["invalid"].includes(evidence.completeness)) availableActions.push("run_l1");
    if (evidence.missingEvidence.includes("粉丝数")) availableActions.push("collect_creator");
    if (evidence.missingEvidence.includes("历史基线")) availableActions.push("baseline_watch");
    if (evidence.missingEvidence.includes("连续快照")) availableActions.push("increase_recollect");
    // 逐字稿/媒体补证据只适用于确有视频媒介的非 X 作品；X 帖子没有视频音轨可供提取。
    if (evidence.missingEvidence.includes("正文") && platform !== "x" && (post.videoUrl || (Array.isArray(post.mediaUrls) && post.mediaUrls.length))) availableActions.push("extract_content");
    if (post.dataConfidence === "invalid" || post.collectionError || collectionJob?.status === "failed") availableActions.push("view_error");
    const momentum = momentumStatus(postSnapshots, {
      now,
      intervalMinutes: ["high", "最高"].includes(creator?.priority) ? 15 : 60,
      previousCoolingStreak: post.momentum?.coolingStreak || 0
    });
    const followed = Boolean(creator || post.followed);
    const next = {
      ...post,
      platform,
      followers: post.followers ?? creator?.followers ?? creator?.followersApprox ?? null,
      followed,
      sourceType: sourceType(state, post),
      aiRelevant: relevance.relevant === true,
      relevance,
      quality,
      momentum,
      metrics: metrics(post),
      metricHistory: postSnapshots
        .filter(snapshot => Number.isFinite(Number(snapshot.likes)))
        .sort((a, b) => timeOf(b.capturedAt) - timeOf(a.capturedAt))
        .slice(0, 8)
        .map(snapshot => ({ capturedAt: snapshot.capturedAt, likes: Number(snapshot.likes), bookmarks: Number.isFinite(Number(snapshot.bookmarks)) ? Number(snapshot.bookmarks) : null })),
      latestAnalysis: resultFresh ? result : null,
      deepAnalysis: deepResultFresh ? deepResult : null,
      deepAnalysisState,
      deepAnalysisTaskId: deepTask ? `analysis:${deepTask.id}` : null,
      deepAnalysisError: deepTask?.error || deepTask?.statusReason || null,
      transcriptStatus: transcript?.status || "not_requested",
      transcript: transcript?.status === "complete" ? transcript.transcript : null,
      transcriptUpdatedAt: transcript?.updated_at || null,
      transcriptError: transcript?.error || null,
      analysisConfidence: null,
      deepAnalysisConfidence: null,
      evidenceCompleteness: evidence.completeness,
      missingEvidence: evidence.missingEvidence,
      evidenceCounts: { historySamples: evidence.historySampleCount, snapshots: evidence.snapshotCount },
      analysisState,
      analysisCompletedAt: resultFresh ? result.createdAt : null,
      analysisTaskId: task ? `analysis:${task.id}` : null,
      analysisError: task?.error || task?.statusReason || null,
      availableActions
    };
    persistGradeEvidence(database, next, quality);
    if (JSON.stringify(post.quality) !== JSON.stringify(quality) || JSON.stringify(post.momentum) !== JSON.stringify(momentum)) changed = true;
    return next;
  });
  if (changed) state.posts = posts;

  const coverage = coverageWindows(state, now);
  const coverageHistory = coverageWindows(state, now, null, 36);
  const events = buildEvents(posts.filter(post => post.aiRelevant), {
    now,
    previousEvents: state.earlyEvents || [],
    coverageWindows: coverage,
    coverageForPosts: values => coverageWindows(state, now, values)
  });
  const eventByPost = new Map();
  for (const event of events) for (const postId of event.postIds || []) eventByPost.set(String(postId), event);
  for (const post of posts) {
    const confidence = evidenceConfidence(post, eventByPost.get(String(post.id)) || null);
    post.analysisConfidence = confidence;
    post.deepAnalysisConfidence = confidence;
  }
  state.earlyEvents = events;

  const pendingEvidence = posts
    .filter(post => post.aiRelevant && post.evidenceCompleteness !== "complete")
    .sort((a, b) => timeOf(b.publishedAt || b.capturedAt) - timeOf(a.publishedAt || a.capturedAt));
  const hotPosts = posts
    .filter(post => post.aiRelevant && ["T1", "T2", "T3"].includes(post.quality?.grade))
    .filter(post => post.evidenceCompleteness === "complete")
    .sort((a, b) => GRADE_ORDER[b.quality.grade] - GRADE_ORDER[a.quality.grade] || (MOMENTUM_ORDER[b.momentum?.status] || 0) - (MOMENTUM_ORDER[a.momentum?.status] || 0) || Number(b.analysisState === "complete") - Number(a.analysisState === "complete") || timeOf(b.publishedAt || b.capturedAt) - timeOf(a.publishedAt || a.capturedAt) || timeOf(b.capturedAt) - timeOf(a.capturedAt));
  const candidates = posts
    .filter(post => post.aiRelevant && !["T1", "T2", "T3"].includes(post.quality?.grade))
    .filter(post => post.evidenceCompleteness === "complete")
    .sort((a, b) => (MOMENTUM_ORDER[b.momentum?.status] || 0) - (MOMENTUM_ORDER[a.momentum?.status] || 0) || timeOf(b.publishedAt || b.capturedAt) - timeOf(a.publishedAt || a.capturedAt) || timeOf(b.capturedAt) - timeOf(a.capturedAt))
    .slice(0, 200);
  const followedPosts = posts
    .filter(post => post.followed)
    .sort((a, b) => timeOf(b.publishedAt || b.capturedAt) - timeOf(a.publishedAt || a.capturedAt));
  const activeEvents = events
    .filter(event => event.stage !== "candidate")
    .sort((a, b) => STAGE_ORDER[b.stage] - STAGE_ORDER[a.stage] || timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt));
  const collectorHealthy = coverage.some(item => item.nodeHealthy);
  const latestJob = [...(state.jobs || [])].sort((a, b) => timeOf(b.finishedAt || b.requestedAt) - timeOf(a.finishedAt || a.requestedAt))[0];
  const followedCreatorIds = new Set((state.creators || []).map(creator => String(creator.id || "")));
  const followedHandles = new Set((state.creators || []).map(creator => String(creator.handle || "").replace(/^@/, "").toLowerCase()).filter(Boolean));
  const followedPostIds = new Set(followedPosts.map(post => String(post.id || "")));
  const followedJobs = (state.jobs || []).filter(job =>
    (job.targetType === "creator" && (followedCreatorIds.has(String(job.targetId || "")) || followedHandles.has(String(job.handle || "").replace(/^@/, "").toLowerCase()))) ||
    (job.targetType === "post_follow_up" && followedPostIds.has(String(job.postId || job.targetId || "")))
  );

  const platformHealth = Object.fromEntries(COLLECTOR_PLATFORMS.map(platform => {
    const runtime = state.collector.platforms[platform];
    const lastSeen = timeOf(runtime.lastProgressAt || runtime.lastSuccessAt);
    return [platform, {
      ...runtime,
      enabled: state.collectionSettings?.[platform] !== false,
      healthy: !runtime.pausedReason && lastSeen > 0 && now - lastSeen <= 20 * 60_000,
      ...platformQueueSummary(state, platform, now)
    }];
  }));

  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      eventCount: activeEvents.length,
      hotPostCount: hotPosts.length,
      hotGradeCounts: Object.fromEntries(["T1", "T2", "T3"].map(grade => [grade, hotPosts.filter(post => post.quality?.grade === grade).length])),
      hotAnalysisCompleteCount: hotPosts.filter(post => post.analysisState === "complete").length,
      followedCreatorCount: state.creators.length,
      followedPostCount: followedPosts.length,
      candidateCount: candidates.length,
      pendingEvidenceCount: pendingEvidence.length,
      evidenceCompleteCount: posts.filter(post => post.aiRelevant && post.evidenceCompleteness === "complete").length,
      queuedJobs: state.jobs.filter(job => job.status === "queued").length,
      followedQueuedJobs: followedJobs.filter(job => job.status === "queued").length,
      followedRunningJobs: followedJobs.filter(job => job.status === "running").length,
      failedJobs: state.jobs.filter(job => job.status === "failed").length
    },
    events: activeEvents,
    hotPosts,
    followedPosts,
    candidates,
    pendingEvidence,
    creators: state.creators,
    monitoringRules: rules,
    health: {
      collectorStatus: state.collector?.status || "waiting_extension",
      collectorHealthy,
      lastSuccessAt: state.collector?.lastRunAt || latestJob?.finishedAt || null,
      lastError: state.collector?.lastError || null,
      adaptiveSchedule: state.collector?.schedule || null,
      coverageComplete: coverageHistory.every(item => item.nodeHealthy && item.successRate >= 0.8),
      coverageWindows: coverageHistory,
      backlog: state.jobs.filter(job => job.status === "queued").length,
      platforms: platformHealth
    }
  };
}
