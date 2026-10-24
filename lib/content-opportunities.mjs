import { aiIndustryPost, buildHeatMap } from "./heat-map.mjs";
import { contentShape } from "./analyzer.mjs";

const WINDOW_HOURS = { "2h": 2, "24h": 24, "7d": 168, all: Infinity };
const SHAPE_KEYS = { "故事": "story", "列表": "list", "观点": "opinion", "教程": "tutorial" };
const HEAT_LABELS = { burst: "爆发", rising: "升温", candidate: "候选待复采", cooling: "冷却" };
const PROVENANCE_LABELS = {
  mother: "母帖",
  direct: "独立发布",
  derivative: "明确加工",
  inferred_derivative: "疑似加工",
  tracing: "来源追溯中"
};

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const timeOf = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const postTime = post => timeOf(post?.publishedAt || post?.capturedAt);
const publicInteractions = post => ["likes", "replies", "reposts", "bookmarks"]
  .reduce((sum, key) => sum + Math.max(0, Number(post?.[key]) || 0), 0);
const isChinese = value => /[\u3400-\u9fff]/u.test(String(value || ""));
const unique = values => [...new Set(values.filter(Boolean).map(String))];
const GENERIC_TOPICS = new Set(["ai", "大模型", "模型", "工具", "科技", "代码", "智能", "人工智能", "aigc"]);

function snapshotIndex(snapshots = []) {
  const index = new Map();
  for (const snapshot of snapshots) {
    const key = String(snapshot.postId);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(snapshot);
  }
  for (const values of index.values()) values.sort((a, b) => timeOf(a.capturedAt) - timeOf(b.capturedAt));
  return index;
}

function provenanceRole(post, postsById) {
  if ((post?.rootSourceForPostIds || []).length) return "mother";
  const rootId = String(post?.provenance?.rootPostId || "");
  if (rootId && postsById.has(rootId)) {
    return post?.provenance?.status === "confirmed" ? "derivative" : "inferred_derivative";
  }
  if (post?.provenance?.status === "searching") return "tracing";
  return "direct";
}

function languageRole(post, role) {
  if (!isChinese(post?.text)) return "en_source";
  if (["derivative", "inferred_derivative"].includes(role)) return "zh_relay";
  return "zh_original";
}

function actualHeat(post, snapshots = [], trendingKeywords = []) {
  const confidence = Number(post?.analysis?.confidence || 0);
  const url = post?.url || post?.sourceUrl || "";
  const latest = snapshots.at(-1);
  const first = [...snapshots].reverse().find(item => timeOf(latest?.capturedAt) - timeOf(item.capturedAt) >= 10 * 60_000);
  const metrics = latest || post || {};
  const interactions = publicInteractions(metrics);
  const aiRelevant = aiIndustryPost(post, trendingKeywords);
  const eligible = aiRelevant && confidence >= .75 && Boolean(url) && Number(metrics.views) > 0 && interactions > 0;

  if (!eligible) {
    return {
      status: null,
      candidate: false,
      eligible: false,
      snapshotCount: snapshots.length,
      reason: !aiRelevant ? "未形成可验证的 AI 行业内容信号" : confidence < .75 ? "AI 相关性或分析置信度不足" : "缺少可复核的公开指标或原帖链接"
    };
  }

  if (!first || !latest || first === latest) {
    const candidate = Number(metrics.views) >= 1000 && Number(metrics.likes) >= 5 && interactions >= 8;
    return {
      status: null,
      candidate,
      eligible: true,
      snapshotCount: snapshots.length,
      reason: candidate ? "有效增长快照不足，等待下一次复采确认" : "增长证据积累中"
    };
  }

  const elapsedHours = Math.max((timeOf(latest.capturedAt) - timeOf(first.capturedAt)) / 3_600_000, 1 / 6);
  const deltaViews = Math.max(0, Number(latest.views || 0) - Number(first.views || 0));
  const deltaReplies = Math.max(0, Number(latest.replies || 0) - Number(first.replies || 0));
  const viewVelocity = deltaViews / elapsedHours;
  const replyVelocity = deltaReplies / elapsedHours;
  const growthRatio = Number(first.views) > 0 ? deltaViews / Number(first.views) : 0;
  const burstTriggers = [
    viewVelocity >= 3000 ? `曝光速度 ${Math.round(viewVelocity)}/小时` : "",
    replyVelocity >= 12 ? `回复速度 ${replyVelocity.toFixed(1)}/小时` : "",
    growthRatio >= .75 && viewVelocity >= 1000 ? `增长 ${Math.round(growthRatio * 100)}%` : ""
  ].filter(Boolean);
  const risingTriggers = [
    viewVelocity >= 500 ? `曝光速度 ${Math.round(viewVelocity)}/小时` : "",
    replyVelocity >= 3 ? `回复速度 ${replyVelocity.toFixed(1)}/小时` : "",
    growthRatio >= .2 && viewVelocity >= 100 ? `增长 ${Math.round(growthRatio * 100)}%` : ""
  ].filter(Boolean);
  const status = burstTriggers.length ? "burst" : risingTriggers.length ? "rising" : null;
  const cooling = !status && post?.analysis?.level === "冷却";

  return {
    status: cooling ? "cooling" : status,
    candidate: false,
    eligible: true,
    snapshotCount: snapshots.length,
    snapshotIds: snapshots.map(item => item.id),
    firstSnapshotAt: first.capturedAt,
    latestSnapshotAt: latest.capturedAt,
    elapsedHours,
    viewVelocity,
    replyVelocity,
    growthRatio,
    triggers: status === "burst" ? burstTriggers : status === "rising" ? risingTriggers : [],
    reason: status
      ? `${status === "burst" ? "爆发" : "升温"}判定：${(status === "burst" ? burstTriggers : risingTriggers).join("、")}`
      : cooling ? "连续快照未达到升温线，内容已进入冷却观察" : "连续快照尚未达到升温标准"
  };
}

function topicIds(post, trendingKeywords = []) {
  const postId = String(post?.id);
  return unique([
    ...(post?.topics || []).map(value => `text:${String(value).toLowerCase()}`),
    ...trendingKeywords
      .filter(item => (item.sourcePostIds || []).some(id => String(id) === postId))
      .map(item => item.id)
  ]);
}

function circleEvidence(post, inWindow, trendingKeywords) {
  const ownTopics = new Set(topicIds(post, trendingKeywords).filter(id => {
    const normalized = String(id).replace(/^text:/, "").toLowerCase();
    return !GENERIC_TOPICS.has(normalized);
  }));
  const rootId = String(post?.provenance?.rootPostId || post?.id || "");
  const related = inWindow.filter(candidate => {
    if (String(candidate.id) === String(post.id)) return false;
    const candidateRoot = String(candidate?.provenance?.rootPostId || candidate?.id || "");
    if (candidateRoot === rootId) return true;
    return ownTopics.size > 0 && topicIds(candidate, trendingKeywords).some(id => ownTopics.has(id));
  });
  const chinese = related.filter(item => isChinese(item.text));
  const creators = unique(chinese.map(item => String(item.handle || item.author || "").toLowerCase()));
  const sorted = [...chinese].sort((a, b) => postTime(a) - postTime(b));
  const fastest = [...chinese].sort((a, b) =>
    Number(b.analysis?.velocity?.viewVelocity || 0) - Number(a.analysis?.velocity?.viewVelocity || 0)
  )[0];
  return {
    postCount: chinese.length,
    creatorCount: creators.length,
    firstPostId: sorted[0]?.id || null,
    firstCreator: sorted[0]?.author || sorted[0]?.handle || null,
    fastestPostId: fastest?.id || null,
    fastestCreator: fastest?.author || fastest?.handle || null,
    adoptionStatus: creators.length >= 4 ? "中文圈集中跟进" : creators.length >= 2 ? "中文圈已确认" : creators.length === 1 ? "中文首发信号" : "尚未进入中文圈",
    relatedPostIds: related.map(item => String(item.id))
  };
}

function contentTitle(post, supplied) {
  const current = String(supplied || "").trim();
  const text = String(post?.text || "").replace(/\s+/g, " ");
  const rules = [
    [/特斯拉.{0,42}(利润|现金流|烧AI)|利润.{0,28}(AI|机器人)/iu, "AI投入拖累利润"],
    [/Anthropic.{0,80}(虚假账户|蒸馏|抄袭)|Claude.{0,50}(蒸馏|抄袭)/iu, "Claude蒸馏争议"],
    [/AI.?Agent.{0,35}(交易|策略|实盘)|交易大赛.{0,30}(Agent|智能体)/iu, "Agent实盘交易"],
    [/DeepSeek.{0,24}(融资|募资).{0,18}(暂停|中止|暂缓)|暂停.{0,20}DeepSeek.{0,16}(融资|募资)/iu, "DeepSeek暂停融资"],
    [/(Claude|Codex|GPT-?[\d.]+).{0,20}免费订阅|免费订阅.{0,20}(Claude|Codex|GPT-?[\d.]+)/iu, "AI产品免费订阅"],
    [/Codex.{0,24}视频.{0,16}(制作|工作流)|视频.{0,20}Codex.{0,14}(制作|工作流)/iu, "Codex视频工作流"],
    [/AI.?交易|交易辅助|交易机器人/iu, "AI交易工具实测"],
    [/系统提示词.{0,20}(删除|精简)|精简.{0,20}系统提示词/iu, "系统提示词精简"],
    [/融资.{0,20}(暂停|中止|暂缓)|暂停.{0,20}融资/iu, "AI公司暂停融资"],
    [/开源.{0,20}(模型|Agent|智能体|项目)/iu, "AI项目开源"],
    [/浏览器.{0,12}(控制|自动化)|browser.{0,12}(control|automation)/iu, "浏览器自动化"],
    [/桌面.{0,12}(控制|自动化)|desktop.{0,12}(control|automation)/iu, "桌面自动化"],
    [/机器人/iu, "机器人商业化"],
    [/视频.{0,10}(生成|制作)|video generation/iu, "AI视频生成"],
    [/语音.{0,10}(生成|合成|交互)|voice/iu, "AI语音能力"],
    [/版权|侵权|copyright/iu, "AI版权争议"],
    [/监管|合规|国安|security/iu, "AI合规风险"],
    [/教程|步骤|工作流|workflow|guide/iu, "AI工作流教程"],
    [/评测|实测|benchmark|review/iu, "AI能力实测"],
    [/发布|推出|上线|launch|release/iu, "AI产品新发布"]
  ];
  const matched = rules.find(([pattern]) => pattern.test(text));
  if (matched) return matched[1];
  const genericCurrent = !current ||
    GENERIC_TOPICS.has(current.toLowerCase()) ||
    current === "内容待提炼" ||
    /(?:进展|表示|动态|新品发布|开源发布|发布|融资|教程|智能体)$/u.test(current);
  if (!genericCurrent) return current;
  const clause = text
    .split(/[。！？；\n]/u)
    .map(value => value.replace(/^(今天|现在|目前|最新|刚刚|我发现|我觉得|这次|这个)+/u, "").trim())
    .find(value => value.length >= 6);
  return clause ? [...clause].slice(0, 18).join("") : "内容待提炼";
}

function summaryFor(post, title, shape) {
  const supplied = post?.analysis?.contentSummary || post?.analysis?.summary || post?.analysis?.changeSummary;
  if (supplied && String(supplied).trim() !== String(post.text || "").trim()) return String(supplied).trim();
  const topics = (post?.topics || []).slice(0, 2).join("、") || "AI 行业";
  const shapeLabel = shape?.label || "观点型";
  return `${post.author || post.handle || "该作者"}围绕${topics}发布${shapeLabel}内容，核心信号是“${title}”。`;
}

function opportunityWindow(status, publishedAt, now) {
  const ageHours = Math.max(0, (now - postTime({ publishedAt })) / 3_600_000);
  const duration = status === "burst" ? 12 : status === "rising" ? 24 : status === "candidate" ? 6 : 0;
  const remainingHours = Math.max(0, duration - ageHours);
  return {
    remainingHours,
    endsAt: duration ? new Date(postTime({ publishedAt }) + duration * 3_600_000).toISOString() : null,
    label: status === "burst" && remainingHours > 0
      ? "立即跟进"
      : status === "rising" && remainingHours > 0
        ? "今日可跟"
        : status === "candidate"
          ? "继续观察"
          : "窗口已收窄"
  };
}

function scoreOpportunity(post, status, heat, language, role, circle, window, shape) {
  const velocityScore = clamp((heat.viewVelocity || 0) / 30);
  const replyScore = clamp((heat.replyVelocity || 0) * 5);
  const growthScore = clamp((heat.growthRatio || 0) * 100);
  const heatScore = status === "burst"
    ? Math.max(88, velocityScore, replyScore, growthScore)
    : status === "rising"
      ? Math.max(68, velocityScore, replyScore, growthScore)
      : status === "candidate" ? 52 : 25;
  const chineseRelevance = clamp((language === "en_source" ? 45 : 72) + circle.creatorCount * 7);
  const windowScore = clamp(window.remainingHours / (status === "burst" ? 12 : status === "rising" ? 24 : 6) * 100);
  const sourceValue = ["mother", "direct"].includes(role) ? 90 : role === "derivative" ? 72 : 58;
  const reproducibility = clamp(Number(shape?.confidence || 0) * 100);
  const breakdown = {
    heat: Math.round(heatScore),
    chineseRelevance: Math.round(chineseRelevance),
    timing: Math.round(windowScore),
    sourceValue: Math.round(sourceValue),
    reproducibility: Math.round(reproducibility)
  };
  return {
    score: Math.round(
      breakdown.heat * .35 +
      breakdown.chineseRelevance * .25 +
      breakdown.timing * .2 +
      breakdown.sourceValue * .1 +
      breakdown.reproducibility * .1
    ),
    breakdown
  };
}

function nextRecaptureAt(status, publishedAt, now) {
  const ageHours = Math.max(0, (now - postTime({ publishedAt })) / 3_600_000);
  const minutes = status === "burst" ? (ageHours <= 6 ? 15 : 30)
    : status === "rising" ? (ageHours <= 12 ? 30 : 60)
      : status === "candidate" ? 30
        : status === "cooling" ? 720 : 180;
  return new Date(now + minutes * 60_000).toISOString();
}

function baseOpportunity(post, payload, heat, status, inWindow, trendingKeywords, postsById, now) {
  const role = provenanceRole(post, postsById);
  const language = languageRole(post, role);
  const circle = circleEvidence(post, inWindow, trendingKeywords);
  const shape = contentShape(post);
  const publishedAt = post.publishedAt || post.capturedAt;
  const window = opportunityWindow(status, publishedAt, now);
  const priority = scoreOpportunity(post, status, heat, language, role, circle, window, shape);
  const heatBase = { burst: 80, rising: 60, candidate: 40, cooling: 20 }[status] || 0;
  const heatScore = clamp(
    heatBase +
    clamp(Number(heat.viewVelocity || 0) / 3000 * 10, 0, 10) +
    clamp(Number(heat.replyVelocity || 0) / 12 * 5, 0, 5) +
    clamp(Number(heat.growthRatio || 0) / .75 * 5, 0, 5)
  );
  const baseline = Math.max(1, Number(post?.analysis?.baselineViews || post.views || 1));
  const reachMultiple = Number(post.views || 0) / baseline;
  const title = contentTitle(post, payload?.displayTitle || post?.analysis?.displayTitle || (post.topics || [])[0]);
  const shapeType = shape.type || "观点";
  const topics = unique((post.topics || []).slice(0, 2));
  const reasons = unique([
    ...(heat.triggers || []),
    circle.creatorCount ? `${circle.creatorCount} 位中文作者跟进` : "",
    reachMultiple >= 1.5 ? `达到作者基线 ${reachMultiple.toFixed(1)} 倍` : "",
    role === "mother" ? "已确认上游母帖" : "",
    language === "en_source" ? "英文行业源头" : ""
  ]);
  return {
    postId: String(post.id),
    author: post.author || post.handle || "未知作者",
    handle: post.handle || "",
    displayTitle: title,
    titleSource: payload?.titleSource || "analysis",
    summary: summaryFor(post, title, shape),
    text: post.text || "",
    url: post.url || post.sourceUrl || "",
    publishedAt,
    heatStatus: status,
    heatLabel: HEAT_LABELS[status],
    heatDecision: {
      status,
      statusLabel: HEAT_LABELS[status],
      reason: heat.reason,
      thresholdsTriggered: heat.triggers || [],
      snapshotCount: heat.snapshotCount,
      snapshotIds: heat.snapshotIds || [],
      firstSnapshotAt: heat.firstSnapshotAt || null,
      latestSnapshotAt: heat.latestSnapshotAt || null
    },
    heatEvidence: {
      viewVelocity: Math.round(Number(heat.viewVelocity || 0)),
      replyVelocity: Number(Number(heat.replyVelocity || 0).toFixed(1)),
      growthRatio: Number(Number(heat.growthRatio || 0).toFixed(3)),
      views: Number(post.views) || 0,
      likes: Number(post.likes) || 0,
      replies: Number(post.replies) || 0,
      reposts: Number(post.reposts) || 0
    },
    contentShape: { ...shape, type: shapeType, key: SHAPE_KEYS[shapeType] || "opinion" },
    topics,
    topicIds: topicIds(post, trendingKeywords),
    languageRole: language,
    provenanceRole: role,
    provenanceLabel: PROVENANCE_LABELS[role],
    rootPostId: post?.provenance?.rootPostId ? String(post.provenance.rootPostId) : null,
    followed: Boolean(post.followed),
    sourceCreator: role === "mother" || language === "en_source",
    chineseCircleEvidence: circle,
    authorBaseline: { views: baseline, reachMultiple: Number(reachMultiple.toFixed(2)) },
    opportunityPriority: priority.score,
    priorityBreakdown: priority.breakdown,
    heatScore: Math.round(heatScore),
    decisionStatus: window.label,
    opportunityWindowEndsAt: window.endsAt,
    opportunityWindowRemainingHours: Number(window.remainingHours.toFixed(1)),
    opportunityReasons: reasons.length ? reasons : [heat.reason],
    analysisConfidence: Number(post?.analysis?.confidence || 0),
    nextRecaptureAt: nextRecaptureAt(status, publishedAt, now)
  };
}

function matchesFilters(item, options) {
  const heat = String(options.heat || "").split(",").filter(Boolean);
  if (heat.length && !heat.includes(item.heatStatus)) return false;
  const shapes = String(options.shape || "").split(",").filter(Boolean);
  if (shapes.length && !shapes.includes(item.contentShape.key)) return false;
  const languages = String(options.language || "").split(",").filter(Boolean);
  if (languages.length && !languages.includes(item.languageRole)) return false;
  if (options.creator === "followed" && !item.followed) return false;
  if (options.creator === "unfollowed" && item.followed) return false;
  if (options.creator === "source" && !item.sourceCreator) return false;
  const provenance = String(options.provenance || "").split(",").filter(Boolean);
  if (provenance.length && !provenance.includes(item.provenanceRole)) return false;
  if (options.topic) {
    const query = String(options.topic).toLowerCase();
    if (!item.topicIds.some(id => String(id).toLowerCase() === query) &&
      !item.topics.some(topic => String(topic).toLowerCase() === query)) return false;
  }
  return true;
}

function sortItems(items, sort = "priority") {
  const heatRank = { burst: 4, rising: 3, candidate: 2, cooling: 1 };
  const sorters = {
    heat: (a, b) => b.heatScore - a.heatScore ||
      (heatRank[b.heatStatus] || 0) - (heatRank[a.heatStatus] || 0) ||
      b.heatEvidence.viewVelocity - a.heatEvidence.viewVelocity ||
      postTime(b) - postTime(a),
    priority: (a, b) => b.opportunityPriority - a.opportunityPriority,
    view_velocity: (a, b) => b.heatEvidence.viewVelocity - a.heatEvidence.viewVelocity,
    reply_velocity: (a, b) => b.heatEvidence.replyVelocity - a.heatEvidence.replyVelocity,
    latest: (a, b) => postTime(b) - postTime(a),
    anomaly: (a, b) => b.authorBaseline.reachMultiple - a.authorBaseline.reachMultiple,
    zh_adoption: (a, b) => b.chineseCircleEvidence.creatorCount - a.chineseCircleEvidence.creatorCount
  };
  return [...items].sort(sorters[sort] || sorters.priority);
}

export function buildContentOpportunities(posts = [], snapshots = [], options = {}) {
  const window = WINDOW_HOURS[options.window] ? options.window : "24h";
  const hours = WINDOW_HOURS[window];
  const now = Number(options.now || Date.now());
  const cutoff = Number.isFinite(hours) ? now - hours * 3_600_000 : -Infinity;
  const trendingKeywords = options.trendingKeywords || [];
  const inWindow = posts.filter(post => postTime(post) >= cutoff && postTime(post) <= now);
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  const snapshotsByPost = snapshotIndex(snapshots);
  const heatMap = buildHeatMap(posts, snapshots, {
    window: window === "all" ? "7d" : window,
    topic: options.topic || "",
    trendingKeywords,
    followedCreators: options.followedCreators || [],
    now
  });
  const payloads = new Map([
    ...(heatMap.focusPosts || []),
    ...(heatMap.relatedPosts || []),
    ...(heatMap.independentSignals || [])
  ].map(item => [String(item.postId), item]));

  const all = [];
  for (const post of inWindow) {
    const heat = actualHeat(post, snapshotsByPost.get(String(post.id)) || [], trendingKeywords);
    const status = heat.status || (heat.candidate ? "candidate" : null);
    if (!status) continue;
    all.push(baseOpportunity(post, payloads.get(String(post.id)), heat, status, inWindow, trendingKeywords, postsById, now));
  }

  const filtered = sortItems(all.filter(item => matchesFilters(item, options)), options.sort);
  const nowItems = filtered.filter(item => ["burst", "rising"].includes(item.heatStatus));
  const observeItems = filtered.filter(item => item.heatStatus === "candidate");
  const coolingItems = filtered.filter(item => item.heatStatus === "cooling");
  const topics = [...new Map(all.flatMap(item => item.topics.map(topic => [topic, topic])).filter(Boolean)).values()]
    .map(topic => ({ id: topic, label: topic, count: all.filter(item => item.topics.includes(topic)).length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));

  return {
    window,
    calculatedAt: new Date(now).toISOString(),
    standard: {
      aiConfidence: .75,
      minimumSnapshotsForHeat: 2,
      minimumSnapshotIntervalMinutes: 10,
      rising: { viewVelocity: 500, replyVelocity: 3, growthRatio: .2, growthViewVelocity: 100 },
      burst: { viewVelocity: 3000, replyVelocity: 12, growthRatio: .75, growthViewVelocity: 1000 },
      candidate: { views: 1000, likes: 5, interactions: 8 }
    },
    coverage: {
      requestedHours: Number.isFinite(hours) ? hours : null,
      scannedPosts: inWindow.length,
      qualifiedPosts: all.length,
      burstCount: all.filter(item => item.heatStatus === "burst").length,
      risingCount: all.filter(item => item.heatStatus === "rising").length,
      candidateCount: all.filter(item => item.heatStatus === "candidate").length,
      coolingCount: all.filter(item => item.heatStatus === "cooling").length,
      filteredCount: filtered.length
    },
    filters: {
      heat: options.heat || "",
      shape: options.shape || "",
      language: options.language || "",
      creator: options.creator || "",
      provenance: options.provenance || "",
      topic: options.topic || "",
      sort: options.sort || "priority"
    },
    topics,
    items: filtered,
    groups: { now: nowItems, observe: observeItems, cooling: coolingItems }
  };
}

function postBrief(post) {
  if (!post) return null;
  return {
    postId: String(post.id),
    author: post.author || post.handle,
    handle: post.handle || "",
    text: post.text || "",
    publishedAt: post.publishedAt || post.capturedAt,
    url: post.url || post.sourceUrl || ""
  };
}

export function buildContentIntelligence(posts = [], snapshots = [], postId, options = {}) {
  const opportunitySet = buildContentOpportunities(posts, snapshots, { ...options, heat: "", shape: "", language: "", creator: "", provenance: "", topic: "" });
  const item = opportunitySet.items.find(value => String(value.postId) === String(postId));
  if (!item) return null;
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  const post = postsById.get(String(postId));
  const root = item.rootPostId ? postsById.get(item.rootPostId) : null;
  const related = item.chineseCircleEvidence.relatedPostIds
    .map(id => postsById.get(String(id)))
    .filter(Boolean)
    .sort((a, b) => Number(b.analysis?.velocity?.viewVelocity || 0) - Number(a.analysis?.velocity?.viewVelocity || 0))
    .slice(0, 10);
  const history = snapshotIndex(snapshots).get(String(postId)) || [];
  const shape = item.contentShape.label;
  const title = item.displayTitle;
  const topicSummary = item.topics.length ? item.topics.join("、") : "AI 行业变化";
  const risks = unique([
    item.heatDecision.snapshotCount < 2 ? "单快照，尚不能确认增长趋势" : "",
    !root && item.provenanceRole === "tracing" ? "上游来源仍在追溯" : "",
    item.analysisConfidence < .75 ? "分析置信度不足" : "",
    item.chineseCircleEvidence.creatorCount < 2 ? "中文圈独立作者证据不足" : "",
    !post?.repliesCollected ? "尚未采集评论正文，不能判断评论区反应" : ""
  ]);
  const followUpAngles = [
    {
      type: "快速响应",
      title: `${title}速览`,
      value: "在热度窗口内说明发生了什么、关键数据和直接影响。",
      format: "短观点 / 6–9 条信息流",
      timing: item.decisionStatus,
      evidence: item.opportunityReasons.slice(0, 2),
      risk: "必须回到原始来源核对事实，避免只转述二手结论。"
    },
    {
      type: "差异化观点",
      title: `${title}意味着什么`,
      value: `结合中文使用场景解释其影响，不重复原帖的${shape}表达。`,
      format: "观点帖 / 图文分析",
      timing: item.opportunityWindowRemainingHours > 4 ? "4 小时内" : "尽快",
      evidence: [`中文圈状态：${item.chineseCircleEvidence.adoptionStatus}`],
      risk: "观点必须标明推断与事实的边界。"
    },
    {
      type: "教程或列表",
      title: `${title}实测清单`,
      value: "补充操作步骤、对比结果和可复现材料，把热点转换为长期搜索价值。",
      format: "教程型 / 列表型",
      timing: "完成验证后发布",
      evidence: [`当前内容形态：${shape}`],
      risk: "没有真实实测材料时不要伪装成教程。"
    }
  ];

  return {
    ...item,
    whatHappened: [
      `${item.author}围绕“${title}”发布${shape}内容，核心讨论落在${topicSummary}的具体变化与影响。`,
      `${item.heatDecision.reason}；${item.chineseCircleEvidence.adoptionStatus}，跟进前仍应核对原始来源与指标快照。`
    ],
    originalPost: postBrief(post),
    snapshotEvidence: history,
    provenanceChain: {
      role: item.provenanceRole,
      label: item.provenanceLabel,
      rootPost: postBrief(root),
      status: root ? "confirmed" : item.provenanceRole === "tracing" ? "searching" : "direct",
      relatedPosts: related.map(postBrief)
    },
    whyItSpreads: [
      { dimension: "增长证据", finding: item.heatDecision.reason, evidence: item.heatDecision.thresholdsTriggered },
      { dimension: "中文圈采用", finding: item.chineseCircleEvidence.adoptionStatus, evidence: [`${item.chineseCircleEvidence.creatorCount} 位作者`, `${item.chineseCircleEvidence.postCount} 条帖子`] },
      { dimension: "内容结构", finding: `${shape}：${item.contentShape.definition}，结构置信度 ${Math.round(item.contentShape.confidence * 100)}%`, evidence: item.contentShape.signals || [] },
      { dimension: "来源价值", finding: item.provenanceLabel, evidence: root ? [`母帖 ${root.author || root.handle}`] : ["暂未发现可确认的上游帖子"] }
    ],
    followUpAngles,
    replicaFramework: {
      hook: `先给出“${title}”的具体变化和一个可核验数据。`,
      evidence: "按原始来源、公开指标、中文圈反应的顺序组织。",
      turn: "补充一个与原帖不同的中文使用场景或反例。",
      cta: "邀请读者提供实测结果或补充来源。",
      boundary: "只复用选题和结构，不复制作者措辞、案例或结论。"
    },
    riskFlags: risks,
    comments: post?.repliesCollected ? { available: true } : { available: false, reason: "当前采集器未读取评论正文，因此不生成评论区结论。" }
  };
}

export function buildCollectorSchedule(state, opportunities, now = Date.now()) {
  const jobs = state.jobs || [];
  const completed = jobs.filter(job => job.status === "complete").sort((a, b) => timeOf(b.finishedAt) - timeOf(a.finishedAt));
  const lastSuccessful = completed[0]?.finishedAt || null;
  const lastCreator = completed.find(job => job.targetType === "creator")?.finishedAt || lastSuccessful;
  const lastIndustry = completed.find(job => ["industry", "trend", "chinese_hot"].includes(job.targetType))?.finishedAt || lastSuccessful;
  const nextFrom = (value, minutes) => new Date(Math.max(now, timeOf(value) + minutes * 60_000)).toISOString();
  const recaptures = (opportunities?.items || []).map(item => item.nextRecaptureAt).filter(Boolean).sort();
  const status = state.collector?.status || "waiting_extension";
  return {
    status,
    lastSuccessfulAt: lastSuccessful,
    lastError: ["error", "auth_required"].includes(status) ? state.collector?.lastError || null : null,
    nextCreatorDiscoveryAt: nextFrom(lastCreator, 30),
    nextIndustryDiscoveryAt: nextFrom(lastIndustry, 60),
    nextRecaptureAt: recaptures[0] || null,
    pendingRecaptures: (opportunities?.items || []).filter(item => ["burst", "rising", "candidate"].includes(item.heatStatus)).length,
    queuedJobs: jobs.filter(job => job.status === "queued").length,
    runningJobs: jobs.filter(job => job.status === "running").length,
    failedJobs: jobs.filter(job => job.status === "failed").length,
    uiRefreshSeconds: 60
  };
}
