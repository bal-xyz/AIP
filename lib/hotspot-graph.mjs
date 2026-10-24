import { buildEvents, eventKey, extractEventFields } from "./event-engine.mjs";

const HOUR = 3_600_000;
const WINDOWS = { "72h": 72 };
const GRADE_ORDER = { T3: 4, T2: 3, T1: 2, candidate: 1, low_quality: 0, ordinary: 0 };
const MOMENTUM_ORDER = { burst: 3, rising: 2, stable: 1, cooling: 0, insufficient: -1 };
const STAGE_ORDER = { burst: 6, hot: 5, spreading: 4, new: 3, pending: 2, cooling: 1, candidate: 0 };

const DIRECTION_RULES = [
  { id: "safety", label: "安全、故障与监管", actions: ["security", "outage"], pattern: /安全|漏洞|越狱|攻击|泄露|故障|宕机|监管|版权|security|vulnerability|jailbreak|outage|regulation/iu },
  { id: "business", label: "商业、价格与资本", actions: ["pricing", "funding"], pattern: /价格|定价|降价|免费|融资|收购|投资|pricing|price|funding|acquisition|investment/iu },
  { id: "embodied", label: "机器人与具身智能", pattern: /机器人|具身|robot|robotics|physical ai|world model/iu },
  { id: "media", label: "图像、视频与语音", pattern: /图像|视频|语音|音乐|image|video|audio|speech|sora|seedance|veo|dall-e/iu },
  { id: "coding", label: "人工智能编程", pattern: /编程|代码|开发者|coding|code|codex|copilot|cursor|ide|cli/iu },
  { id: "agents", label: "智能体与工作流", pattern: /智能体|工作流|工具调用|agent|agentic|workflow|computer use|operator/iu },
  { id: "infrastructure", label: "开源与基础设施", actions: ["open-source"], pattern: /开源|开放权重|芯片|算力|推理成本|基础设施|open.source|open weights|chip|gpu|inference|nvidia|hugging face/iu },
  { id: "models", label: "模型与能力", pattern: /模型|推理|多模态|上下文|benchmark|model|reasoning|multimodal|context|gpt|claude|gemini|grok|llama|deepseek|qwen|kimi/iu }
];

const FALLBACK_DIRECTION = { id: "applications", label: "产品与应用" };

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function platformOf(post) {
  return post.platform || (String(post.source || "").startsWith("douyin") ? "douyin" : "x");
}

function postKey(post) {
  return `${platformOf(post)}:${post.id}`;
}

function gradeOf(post) {
  return post.quality?.grade || post.qualityGrade || post.analysis?.qualityGrade || post.analysis?.grade || "ordinary";
}

function momentumOf(post) {
  return post.momentum?.status || post.momentumStatus || post.analysis?.momentumStatus || "insufficient";
}

function isFormalHotPost(post) {
  return ["T1", "T2", "T3"].includes(gradeOf(post));
}

function authorIdentity(post) {
  if (post.sourceFamilyId) return String(post.sourceFamilyId);
  return `${platformOf(post)}:${String(post.platformAuthorId || post.handle || post.author || "").replace(/^@/, "").toLowerCase()}`;
}

function rankPosts(a, b) {
  return (GRADE_ORDER[gradeOf(b)] || 0) - (GRADE_ORDER[gradeOf(a)] || 0) ||
    (MOMENTUM_ORDER[momentumOf(b)] || 0) - (MOMENTUM_ORDER[momentumOf(a)] || 0) ||
    timeOf(b.publishedAt || b.capturedAt) - timeOf(a.publishedAt || a.capturedAt);
}

function publicPost(post) {
  return {
    id: post.id,
    platform: platformOf(post),
    author: post.author || post.displayName || post.handle || "未知作者",
    displayName: post.displayName,
    handle: post.handle,
    text: post.text || "",
    url: post.url || post.sourceUrl || null,
    sourceUrl: post.sourceUrl || null,
    profileUrl: post.profileUrl || null,
    publishedAt: post.publishedAt || null,
    capturedAt: post.capturedAt || null,
    likes: Number.isFinite(Number(post.likes)) ? Number(post.likes) : null,
    bookmarks: post.bookmarks === null || post.bookmarks === undefined ? null : Number(post.bookmarks),
    replies: Number.isFinite(Number(post.replies)) ? Number(post.replies) : null,
    reposts: Number.isFinite(Number(post.reposts)) ? Number(post.reposts) : null,
    views: Number.isFinite(Number(post.views)) ? Number(post.views) : null,
    followers: Number.isFinite(Number(post.followers)) ? Number(post.followers) : null,
    followed: post.followed === true,
    sourceType: post.sourceType || null,
    quality: post.quality || { grade: gradeOf(post) },
    momentum: post.momentum || { status: momentumOf(post) },
    latestAnalysis: post.latestAnalysis || null
  };
}

function eventHeat(event) {
  const base = ({ burst: 96, hot: 82, spreading: 64, new: 42, pending: 28, cooling: 18, candidate: 12 })[event.stage] || 12;
  const spread = Math.min(8, Math.max(0, Number(event.authorCount || 0) - 2));
  return Math.min(100, base + spread);
}

function directionFor(event, posts) {
  const action = String(event.fields?.action || "");
  const text = `${event.title || ""} ${event.fields?.subject || ""} ${event.fields?.version || ""} ${event.fields?.change || ""} ${posts.map(post => post.text || "").join(" ")}`;
  return DIRECTION_RULES.find(rule => rule.actions?.includes(action) || rule.pattern?.test(text)) || FALLBACK_DIRECTION;
}

function eventPosts(event, postsByEvent) {
  return [...(postsByEvent.get(event.key)?.values() || [])].sort(rankPosts);
}

function buildPostBuckets(posts, now, hours) {
  const buckets = new Map();
  for (const post of posts) {
    const publishedAt = timeOf(post.publishedAt || post.capturedAt);
    if (!post.id || !publishedAt || publishedAt > now || now - publishedAt > hours * HOUR) continue;
    if (post.aiRelevant === false || post.isPureRepost || post.contentType === "repost") continue;
    const key = eventKey(extractEventFields(post));
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, new Map());
    buckets.get(key).set(postKey(post), post);
  }
  return buckets;
}

function progressFor(event, posts) {
  const t1 = posts.filter(post => gradeOf(post) === "T1").length;
  const t2 = posts.filter(post => gradeOf(post) === "T2").length;
  const t3 = posts.filter(post => gradeOf(post) === "T3").length;
  const hotGateMet = t1 >= 2 || t2 >= 1 || t3 >= 1;
  return {
    posts: event.postCount,
    postTarget: 8,
    authors: event.authorCount,
    authorTarget: 5,
    t1,
    t2,
    t3,
    hotGateMet,
    missingPosts: Math.max(0, 8 - event.postCount),
    missingAuthors: Math.max(0, 5 - event.authorCount),
    missingHotSignal: hotGateMet ? null : "还需两条 T1，或一条 T2/T3"
  };
}

function languageCounts(posts) {
  return posts.reduce((counts, post) => {
    const language = post.language || (/\p{Script=Han}/u.test(String(post.text || "")) ? "zh" : "en");
    counts[language] = (counts[language] || 0) + 1;
    return counts;
  }, {});
}

function platformCounts(posts) {
  return posts.reduce((counts, post) => {
    const platform = platformOf(post);
    counts[platform] = (counts[platform] || 0) + 1;
    return counts;
  }, {});
}

function clusterFor(event, posts) {
  const ranked = posts.map(publicPost);
  const direction = directionFor(event, posts);
  const first = posts.reduce((earliest, post) =>
    !earliest || timeOf(post.publishedAt || post.capturedAt) < timeOf(earliest.publishedAt || earliest.capturedAt) ? post : earliest
  , null);
  return {
    id: event.id,
    eventId: event.id,
    key: event.key,
    title: event.title,
    stage: event.stage,
    stageLabel: event.stageLabel,
    stageReason: event.stageReason,
    heat: eventHeat(event),
    formal: ["hot", "burst", "cooling"].includes(event.stage),
    directionId: direction.id,
    directionLabel: direction.label,
    postCount: event.postCount,
    authorCount: event.authorCount,
    languageCounts: languageCounts(posts),
    platformCounts: platformCounts(posts),
    firstSeenAt: event.firstSeenAt,
    lastSeenAt: event.lastSeenAt,
    earliestSource: event.earliestSource || (first ? {
      author: first.author,
      handle: first.handle,
      url: first.url || first.sourceUrl,
      platform: platformOf(first)
    } : null),
    acceleration: event.acceleration,
    coverage: event.coverage,
    progress: progressFor(event, posts),
    visiblePostKeys: ranked.map(postKey),
    hiddenPostCount: 0,
    posts: ranked
  };
}

function buildDirections(clusters) {
  const groups = new Map();
  for (const cluster of clusters) {
    const item = groups.get(cluster.directionId) || {
      id: cluster.directionId,
      label: cluster.directionLabel,
      eventIds: [],
      eventCount: 0,
      formalHotspotCount: 0,
      hotPostCount: 0,
      heat: 0,
      stage: "candidate"
    };
    item.eventIds.push(cluster.id);
    item.eventCount += 1;
    item.formalHotspotCount += cluster.formal ? 1 : 0;
    item.hotPostCount += cluster.posts.filter(isFormalHotPost).length;
    if (cluster.heat > item.heat) {
      item.heat = cluster.heat;
      item.stage = cluster.stage;
    }
    groups.set(cluster.directionId, item);
  }
  return [...groups.values()].sort((a, b) => b.heat - a.heat || b.eventCount - a.eventCount || a.label.localeCompare(b.label, "zh-CN"));
}

export function buildHotspotGraph(posts = [], options = {}) {
  const window = WINDOWS[options.window] ? options.window : "72h";
  const hours = WINDOWS[window];
  const now = Number(options.now || Date.now());
  const relevantPosts = posts.filter(post => post.aiRelevant !== false);
  const events = buildEvents(relevantPosts, {
    now,
    initialWindowHours: hours,
    previousEvents: options.previousEvents || [],
    coverageWindows: options.coverageWindows || [],
    coverageForPosts: options.coverageForPosts
  });
  const postsByEvent = buildPostBuckets(relevantPosts, now, hours);
  const allClusters = events
    .map(event => ({ event, posts: eventPosts(event, postsByEvent) }))
    .filter(item => item.posts.length >= 2)
    .map(item => clusterFor(item.event, item.posts))
    .sort((a, b) => Number(b.formal) - Number(a.formal) || STAGE_ORDER[b.stage] - STAGE_ORDER[a.stage] || b.heat - a.heat || timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt));
  const clusteredPostKeys = new Set(allClusters.flatMap(cluster => cluster.posts.map(postKey)));
  const standalones = relevantPosts
    .filter(post => {
      const publishedAt = timeOf(post.publishedAt || post.capturedAt);
      return post.id && publishedAt && now - publishedAt <= hours * HOUR && publishedAt <= now &&
        isFormalHotPost(post) && !clusteredPostKeys.has(postKey(post));
    })
    .sort(rankPosts)
    .map(post => {
      const fields = extractEventFields(post);
      const direction = directionFor({ fields, title: post.text || "" }, [post]);
      return { ...publicPost(post), directionId: direction.id, directionLabel: direction.label };
    });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  const uniqueRelevantPosts = [...new Map(relevantPosts.filter(post => post.id).map(post => [postKey(post), post])).values()];
  const todayPosts = uniqueRelevantPosts.filter(post => {
    const publishedAt = timeOf(post.publishedAt || post.capturedAt);
    return publishedAt >= todayStart && publishedAt <= now;
  });
  const todayPostKeys = new Set(todayPosts.map(postKey));
  const todayClusters = allClusters.filter(cluster => cluster.posts.some(post => todayPostKeys.has(postKey(post))));
  const persistentPostCount = uniqueRelevantPosts.filter(post => ["rising", "stable", "burst"].includes(momentumOf(post))).length;
  return {
    window,
    generatedAt: new Date(now).toISOString(),
    coverage: options.coverage || { complete: false, lastSuccessAt: null },
    summary: {
      directionCount: buildDirections(allClusters).length,
      clusterCount: allClusters.length,
      formalHotspotCount: allClusters.filter(cluster => cluster.formal).length,
      formingCount: allClusters.filter(cluster => !cluster.formal).length,
      hotPostCount: relevantPosts.filter(post => {
        const publishedAt = timeOf(post.publishedAt || post.capturedAt);
        return publishedAt && now - publishedAt <= hours * HOUR && publishedAt <= now && isFormalHotPost(post);
      }).length,
      todayPostCount: todayPosts.length,
      todayHotspotCount: todayClusters.filter(cluster => cluster.formal && timeOf(cluster.firstSeenAt) >= todayStart).length,
      todayFormingCount: todayClusters.filter(cluster => !cluster.formal).length,
      persistentPostCount
    },
    directions: buildDirections(allClusters),
    clusters: allClusters,
    hiddenClusterCount: 0,
    standalones
  };
}

export { DIRECTION_RULES, eventHeat, rankPosts };
