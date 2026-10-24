import { detectPostLanguage, extractChangeCandidates } from "./trending.mjs";

const HOUR = 3_600_000;
const TOPIC_QUALITY_STANDARD = Object.freeze({
  minimumPosts: 5,
  minimumViews: 500,
  minimumLikes: 5,
  minimumInteractions: 8
});
const WINDOW_CONFIG = {
  "2h": { hours: 2, recentHours: .5, minPosts: 5, minCreators: 2, directionMinFamilies: 3, directionMinCreators: 2, directionMinDays: 1, directionMinQualityPosts: 5, coverageTarget: 8, creatorTarget: 4, heatTarget: 5, freshness: [.25, 1, 2] },
  "24h": { hours: 24, recentHours: 2, minPosts: 5, minCreators: 3, directionMinFamilies: 5, directionMinCreators: 3, directionMinDays: 1, directionMinQualityPosts: 5, coverageTarget: 10, creatorTarget: 6, heatTarget: 6, freshness: [.5, 2, 6] },
  "7d": { hours: 168, recentHours: 24, minPosts: 5, minCreators: 3, directionMinFamilies: 8, directionMinCreators: 4, directionMinDays: 2, directionMinQualityPosts: 5, coverageTarget: 25, creatorTarget: 15, heatTarget: 12, freshness: [6, 24, 72] }
};

const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const clamp = value => Math.max(0, Math.min(100, Math.round(value)));
const handleKey = post => String(post?.handle || post?.author || "").trim().toLowerCase();
const slug = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48);
const uniquePosts = posts => [...new Map(posts.filter(post => post?.id).map(post => [post.id, post])).values()];
const evidenceFamilyKey = post => String(
  post?.provenance?.rootPostId ||
  post?.rootPostId ||
  post?.referencedPostId ||
  post?.quotedPostId ||
  post?.id ||
  ""
);
const evidenceFamilyCount = posts => new Set(posts.map(evidenceFamilyKey).filter(Boolean)).size;
const evidenceDayCount = posts => new Set(posts
  .map(post => safeTime(post?.publishedAt || post?.capturedAt))
  .filter(Boolean)
  .map(time => new Date(time).toISOString().slice(0, 10))).size;
const postInteractionTotal = post => ["replies", "reposts", "likes", "bookmarks"]
  .reduce((sum, key) => sum + Math.max(0, Number(post?.[key]) || 0), 0);

// A post can be collected and stored without having usable public metrics yet.
// Such posts remain in raw coverage, but cannot create or strengthen a ranked topic.
export function hasRankableHeat(post) {
  return Number(post?.views) > 0 &&
    Number(post?.likes) > 0 &&
    postInteractionTotal(post) > 0;
}

export function isHighQualityTopicPost(post) {
  return hasRankableHeat(post) &&
    Number(post?.views) >= TOPIC_QUALITY_STANDARD.minimumViews &&
    Number(post?.likes) >= TOPIC_QUALITY_STANDARD.minimumLikes &&
    postInteractionTotal(post) >= TOPIC_QUALITY_STANDARD.minimumInteractions;
}

function freshnessScore(lastSeenAt, now, thresholds) {
  const hours = Math.max(0, now - safeTime(lastSeenAt)) / HOUR;
  if (hours <= thresholds[0]) return 100;
  if (hours <= thresholds[1]) return 70;
  if (hours <= thresholds[2]) return 40;
  return 10;
}

function graphStatus(score, qualifies, burstPostCount) {
  if (qualifies && score >= 80 && burstPostCount > 0) return "burst";
  if (qualifies && score >= 60) return "active";
  if (qualifies && score >= 40) return "emerging";
  return "observing";
}

function chineseStatus(creatorCount) {
  if (creatorCount >= 4) return "concentrated";
  if (creatorCount >= 2) return "confirmed";
  if (creatorCount === 1) return "first";
  return "none";
}

function summarizeCreators(posts) {
  const groups = new Map();
  for (const post of posts) {
    const handle = handleKey(post);
    if (!handle) continue;
    const time = post.publishedAt || post.capturedAt || null;
    const item = groups.get(handle) || {
      handle: String(post.handle || post.author || handle),
      displayName: String(post.author || post.handle || handle),
      postCount: 0,
      evidenceFamilyCount: 0,
      evidenceDayCount: 0,
      firstSeenAt: time,
      lastSeenAt: time
    };
    item.postCount += 1;
    if (safeTime(time) && (!safeTime(item.firstSeenAt) || safeTime(time) < safeTime(item.firstSeenAt))) item.firstSeenAt = time;
    if (safeTime(time) > safeTime(item.lastSeenAt)) item.lastSeenAt = time;
    groups.set(handle, item);
  }
  return [...groups.values()]
    .sort((a, b) => safeTime(a.firstSeenAt) - safeTime(b.firstSeenAt) || b.postCount - a.postCount)
    .slice(0, 8);
}

function calculateHeat(sourcePosts, config, now) {
  const posts = uniquePosts(sourcePosts);
  if (!posts.length) {
    return {
      score: 0,
      scoreBreakdown: { coverage: 0, creatorDiversity: 0, momentum: 0, hotPostStrength: 0, freshness: 0 },
      postCount: 0,
      creatorCount: 0,
      creatorHandles: [],
      momentumRatio: 0,
      risingPostCount: 0,
      burstPostCount: 0,
      totalViews: 0,
      totalInteractions: 0,
      totalLikes: 0,
      firstSeenAt: null,
      lastSeenAt: null
    };
  }
  const creators = new Set(posts.map(handleKey).filter(Boolean));
  const recent = posts.filter(post => now - safeTime(post.publishedAt || post.capturedAt) <= config.recentHours * HOUR);
  const baseline = posts.filter(post => {
    const age = now - safeTime(post.publishedAt || post.capturedAt);
    return age > config.recentHours * HOUR && age <= config.hours * HOUR;
  });
  const recentRate = recent.length / config.recentHours;
  const baselineRate = baseline.length / Math.max(.5, config.hours - config.recentHours);
  const momentumRatio = baselineRate ? recentRate / baselineRate : recent.length >= config.minPosts ? 4 : recent.length ? 2 : 0;
  const risingPostCount = posts.filter(post => post.analysis?.level === "升温").length;
  const burstPostCount = posts.filter(post => post.analysis?.level === "爆发").length;
  const totalViews = posts.reduce((sum, post) => sum + Math.max(0, Number(post.views) || 0), 0);
  const totalInteractions = posts.reduce((sum, post) => sum + postInteractionTotal(post), 0);
  const totalLikes = posts.reduce((sum, post) => sum + Math.max(0, Number(post.likes) || 0), 0);
  const times = posts.map(post => post.publishedAt || post.capturedAt).filter(Boolean).sort();
  const scoreBreakdown = {
    coverage: clamp(posts.length / config.coverageTarget * 100),
    creatorDiversity: clamp(creators.size / config.creatorTarget * 100),
    momentum: clamp(momentumRatio / 4 * 100),
    hotPostStrength: clamp((risingPostCount + burstPostCount * 2) / config.heatTarget * 100),
    freshness: freshnessScore(times.at(-1), now, config.freshness)
  };
  const score = clamp(
    scoreBreakdown.coverage * .25 +
    scoreBreakdown.creatorDiversity * .2 +
    scoreBreakdown.momentum * .25 +
    scoreBreakdown.hotPostStrength * .2 +
    scoreBreakdown.freshness * .1
  );
  return {
    score,
    scoreBreakdown,
    postCount: posts.length,
    evidenceFamilyCount: evidenceFamilyCount(posts),
    evidenceDayCount: evidenceDayCount(posts),
    creatorCount: creators.size,
    creatorHandles: [...creators],
    momentumRatio: Number(momentumRatio.toFixed(2)),
    risingPostCount,
    burstPostCount,
    totalViews,
    totalInteractions,
    totalLikes,
    firstSeenAt: times[0] || null,
    lastSeenAt: times.at(-1) || null
  };
}

function nodeMetrics(posts, config, now) {
  const matched = uniquePosts(posts);
  const chinesePosts = matched.filter(post => detectPostLanguage(post.text) === "zh");
  const overseasPosts = matched.filter(post => detectPostLanguage(post.text) !== "zh");
  const global = calculateHeat(matched, config, now);
  const chinese = calculateHeat(chinesePosts, config, now);
  const lagHours = global.firstSeenAt && chinese.firstSeenAt
    ? Math.max(0, (safeTime(chinese.firstSeenAt) - safeTime(global.firstSeenAt)) / HOUR)
    : null;
  const qualifies = global.postCount >= config.minPosts && global.creatorCount >= config.minCreators &&
    (global.risingPostCount + global.burstPostCount > 0 || global.momentumRatio >= 2);
  return {
    global,
    chinese,
    status: graphStatus(global.score, qualifies, global.burstPostCount),
    chineseStatus: chineseStatus(chinese.creatorCount),
    chineseCreatorPreview: summarizeCreators(chinesePosts),
    lagHours: lagHours === null ? null : Number(lagHours.toFixed(1)),
    overseasPostCount: overseasPosts.length,
    overseasCreatorCount: new Set(overseasPosts.map(handleKey).filter(Boolean)).size
  };
}

function metricFields(metrics) {
  return {
    globalScore: metrics.global.score,
    chineseScore: metrics.chinese.score,
    score: metrics.global.score,
    scoreBreakdown: metrics.global.scoreBreakdown,
    chineseScoreBreakdown: metrics.chinese.scoreBreakdown,
    status: metrics.status,
    chineseStatus: metrics.chineseStatus,
    postCount: metrics.global.postCount,
    evidenceFamilyCount: metrics.global.evidenceFamilyCount,
    evidenceDayCount: metrics.global.evidenceDayCount,
    creatorCount: metrics.global.creatorCount,
    zhPostCount: metrics.chinese.postCount,
    zhCreatorCount: metrics.chinese.creatorCount,
    overseasPostCount: metrics.overseasPostCount,
    overseasCreatorCount: metrics.overseasCreatorCount,
    momentumRatio: metrics.global.momentumRatio,
    chineseMomentumRatio: metrics.chinese.momentumRatio,
    risingPostCount: metrics.global.risingPostCount,
    burstPostCount: metrics.global.burstPostCount,
    chineseRisingPostCount: metrics.chinese.risingPostCount,
    chineseBurstPostCount: metrics.chinese.burstPostCount,
    totalViews: metrics.global.totalViews,
    totalInteractions: metrics.global.totalInteractions,
    totalLikes: metrics.global.totalLikes,
    rankEligible: metrics.global.totalViews > 0 &&
      metrics.global.totalInteractions > 0 &&
      metrics.global.totalLikes > 0,
    firstSeenAt: metrics.global.firstSeenAt,
    lastSeenAt: metrics.global.lastSeenAt,
    globalFirstSeenAt: metrics.global.firstSeenAt,
    chineseFirstSeenAt: metrics.chinese.firstSeenAt,
    chineseLagHours: metrics.lagHours,
    creatorHandles: metrics.global.creatorHandles,
    zhCreatorHandles: metrics.chinese.creatorHandles,
    chineseCreatorPreview: metrics.chineseCreatorPreview
  };
}

export function calculateTopicMetrics(posts = [], options = {}) {
  const window = WINDOW_CONFIG[options.window] ? options.window : "24h";
  const now = Number.isFinite(Date.parse(options.now)) ? Date.parse(options.now) : Date.now();
  return metricFields(nodeMetrics(uniquePosts(posts), WINDOW_CONFIG[window], now));
}

function buildChangeBuckets(posts) {
  const buckets = new Map();
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  for (const post of posts) {
    for (const candidate of extractChangeCandidates(post)) {
      const key = candidate.normalizedText.toLowerCase();
      if (!buckets.has(key)) {
        buckets.set(key, {
          id: `change-${slug(candidate.normalizedText)}`,
          normalizedText: candidate.normalizedText,
          kind: candidate.kind,
          category: candidate.category,
          subject: candidate.subject,
          changeType: candidate.changeType,
          changeSummary: candidate.changeSummary,
          previousState: candidate.previousState,
          currentState: candidate.currentState,
          posts: new Map(),
          confidences: []
        });
      }
      const bucket = buckets.get(key);
      bucket.posts.set(post.id, post);
      const rootPost = postsById.get(String(post.provenance?.rootPostId || ""));
      if (rootPost) bucket.posts.set(rootPost.id, rootPost);
      bucket.confidences.push(candidate.confidence);
    }
  }
  return [...buckets.values()];
}

function buildChangeNode(bucket, config, now) {
  const posts = [...bucket.posts.values()];
  const confidence = bucket.confidences.length
    ? bucket.confidences.reduce((sum, value) => sum + value, 0) / bucket.confidences.length
    : 0;
  const parentTopicId = `topic-${slug(bucket.subject || "AI 行业")}`;
  return {
    id: bucket.id,
    nodeType: "change",
    parentTopicId,
    normalizedText: bucket.normalizedText,
    kind: bucket.kind,
    category: bucket.category,
    subject: bucket.subject,
    changeType: bucket.changeType,
    changeSummary: bucket.changeSummary,
    previousState: bucket.previousState,
    currentState: bucket.currentState,
    ...metricFields(nodeMetrics(posts, config, now)),
    sourcePostIds: posts.map(post => post.id),
    confidence: Number(confidence.toFixed(2))
  };
}

function dominantCategory(changes) {
  const counts = new Map();
  for (const change of changes) counts.set(change.category, (counts.get(change.category) || 0) + change.postCount);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "行业趋势";
}

function buildTopicNodes(changeNodes, postsById, config, now) {
  const groups = new Map();
  for (const change of changeNodes) {
    if (!groups.has(change.parentTopicId)) groups.set(change.parentTopicId, []);
    groups.get(change.parentTopicId).push(change);
  }
  return [...groups].map(([id, changes]) => {
    const sourcePostIds = [...new Set(changes.flatMap(change => change.sourcePostIds))];
    const posts = sourcePostIds.map(postId => postsById.get(postId)).filter(Boolean);
    const metrics = nodeMetrics(posts, config, now);
    const confidence = changes.reduce((sum, change) => sum + change.confidence, 0) / changes.length;
    return {
      id,
      nodeType: "topic",
      normalizedText: changes[0]?.subject || "AI 行业",
      subject: changes[0]?.subject || "AI 行业",
      kind: "topic",
      category: dominantCategory(changes),
      childChangeIds: changes.map(change => change.id),
      ...metricFields(metrics),
      sourcePostIds,
      confidence: Number(confidence.toFixed(2))
    };
  }).filter(topic => topic.postCount >= config.minPosts && topic.creatorCount >= config.minCreators && topic.confidence >= .75)
    .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount || a.normalizedText.localeCompare(b.normalizedText));
}

function buildObservationTopics(keywords, existingTopics, postsById, config, now) {
  const existingNames = new Set(existingTopics.map(topic => topic.normalizedText.toLowerCase()));
  const seen = new Set();
  return (keywords || []).map(keyword => {
    const normalizedText = String(keyword.normalizedText || "").trim();
    const key = normalizedText.toLowerCase();
    if (!normalizedText || seen.has(key) || existingNames.has(key) || Number(keyword.confidence || 0) < .75) return null;
    seen.add(key);
    const sourcePostIds = [...new Set(keyword.sourcePostIds || [])].filter(id => postsById.has(id));
    const posts = sourcePostIds.map(id => postsById.get(id));
    const metrics = nodeMetrics(posts, config, now);
    if (metrics.global.postCount < 2 || metrics.global.creatorCount < 2) return null;
    return {
      id: `topic-signal-${slug(normalizedText)}`,
      nodeType: "topic",
      normalizedText,
      subject: normalizedText,
      kind: "topic",
      category: keyword.category || "行业趋势",
      childChangeIds: [],
      signalOnly: true,
      ...metricFields(metrics),
      sourcePostIds,
      confidence: Number(keyword.confidence || 0)
    };
  }).filter(Boolean);
}

const DISCUSSION_DIRECTION_RULES = [
  {
    id: "release-capability",
    label: "发布与能力",
    category: "事件与发布",
    patterns: [/\breleas(?:e|ed|ing)\b/iu, /\blaunch(?:ed|ing)?\b/iu, /\bnew\b/iu, /\bupdate[ds]?\b/iu, /\bbenchmark\b/iu, /发布|上线|更新|新模型|新版本|能力|性能|推理/u]
  },
  {
    id: "pricing-usage",
    label: "定价与用量",
    category: "行业趋势",
    patterns: [/\bpric(?:e|ing)\b/iu, /\bcost\b/iu, /\bplan\b/iu, /\busage\b/iu, /\blimit\b/iu, /\bquota\b/iu, /定价|价格|成本|套餐|额度|用量|限额|降价/u]
  },
  {
    id: "security-risk",
    label: "安全与风险",
    category: "争议与风险",
    patterns: [/\bsecur(?:ity|e)\b/iu, /\bsafety\b/iu, /\brisk\b/iu, /\bjailbreak\b/iu, /\battack\b/iu, /\bvulnerab/iu, /安全|风险|漏洞|攻击|越狱|滥用|诉讼|合规/u]
  },
  {
    id: "comparison-evaluation",
    label: "对比与评测",
    category: "技术与能力",
    patterns: [/\bvs\.?\b/iu, /\bcompare[sd]?\b/iu, /\bcomparison\b/iu, /\bbenchmark\b/iu, /\beval(?:uation)?\b/iu, /对比|比较|评测|测试|排行|基准/u]
  },
  {
    id: "integration-compatibility",
    label: "集成与兼容",
    category: "技术与能力",
    patterns: [/\bintegrat(?:e|ed|ion)\b/iu, /\bconnect(?:ed|or)?\b/iu, /\bcompatib/iu, /\bapi\b/iu, /\bdesktop\b/iu, /\bbrowser\b/iu, /\bextension\b/iu, /\btool[\s-]?call/iu, /集成|接入|兼容|连接器|桌面端|浏览器|扩展|工具调用/u]
  },
  {
    id: "reasoning-performance",
    label: "推理与性能",
    category: "技术与能力",
    patterns: [/\breasoning\b/iu, /\binference\b/iu, /\blatency\b/iu, /\btoken\b/iu, /\bcontext\b/iu, /\bmemory\b/iu, /\bperformance\b/iu, /推理|性能|延迟|上下文|记忆|速度|吞吐|令牌/u]
  },
  {
    id: "multimodal-interaction",
    label: "多模态交互",
    category: "应用场景",
    patterns: [/\bvoice\b/iu, /\baudio\b/iu, /\bvideo\b/iu, /\bimage\b/iu, /\bvision\b/iu, /\bspeech\b/iu, /\bmultimodal\b/iu, /语音|音频|视频|图像|视觉|多模态/u]
  },
  {
    id: "developer-experience",
    label: "开发体验",
    category: "应用场景",
    patterns: [/\bcoding\b/iu, /\bdeveloper\b/iu, /\bdebug/iu, /\breview\b/iu, /\bsession\b/iu, /\bterminal\b/iu, /\bide\b/iu, /编程|开发者|调试|代码审查|会话|终端|编辑器|体验/u]
  },
  {
    id: "adoption-migration",
    label: "采用与迁移",
    category: "行业趋势",
    patterns: [/\badopt/iu, /\bmigrat/iu, /\bswitch(?:ed|ing)?\b/iu, /\breplac(?:e|ed|ing)\b/iu, /\bmove[sd]?\s+to\b/iu, /采用|迁移|切换|替代|转向|转用|普及/u]
  },
  {
    id: "open-ecosystem",
    label: "开源与生态",
    category: "行业趋势",
    patterns: [/\bopen[\s-]?source\b/iu, /\bgithub\b/iu, /\bplugin\b/iu, /\bskill\b/iu, /\bmcp\b/iu, /开源|生态|插件|协议|社区|仓库/u]
  },
  {
    id: "workflow-practice",
    label: "工作流与实践",
    category: "应用场景",
    patterns: [/\bworkflow\b/iu, /\bhow[\s-]?to\b/iu, /\btutorial\b/iu, /\buse[\s-]?case\b/iu, /\busing\b/iu, /\bbuild(?:ing|s|t)?\b/iu, /工作流|教程|实践|使用|体验|案例|搭建|开发|自动化|提示词/u]
  },
  {
    id: "business-market",
    label: "商业与市场",
    category: "行业趋势",
    patterns: [/\bbusiness\b/iu, /\bmarket\b/iu, /\bfund(?:ing|ed)?\b/iu, /\brevenue\b/iu, /\bregulat/iu, /商业|市场|融资|营收|监管|竞争|收购|估值/u]
  }
];

function discussionDirectionsForPost(post) {
  const text = String(post?.text || "");
  return DISCUSSION_DIRECTION_RULES
    .map(rule => ({
      rule,
      score: rule.patterns.reduce((sum, pattern) => sum + Number(pattern.test(text)), 0)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || DISCUSSION_DIRECTION_RULES.indexOf(a.rule) - DISCUSSION_DIRECTION_RULES.indexOf(b.rule))
    .map(item => item.rule);
}

function discussionDirectionForPost(post) {
  return discussionDirectionsForPost(post)[0] || null;
}

function buildDiscussionDirectionNodes(topicNodes, existingChanges, postsById, config, now, targetCount = 6) {
  const result = [];
  for (const topic of topicNodes) {
    const explicitChanges = existingChanges.filter(change => change.parentTopicId === topic.id);
    const buckets = new Map(DISCUSSION_DIRECTION_RULES.map(rule => [rule.id, { rule, posts: [] }]));
    for (const postId of topic.sourcePostIds || []) {
      const post = postsById.get(postId);
      if (!post) continue;
      for (const direction of discussionDirectionsForPost(post)) {
        buckets.get(direction.id).posts.push(post);
      }
    }
    let candidates = [...buckets.values()].map(bucket => {
      const posts = uniquePosts(bucket.posts);
      const creatorCount = new Set(posts.map(handleKey).filter(Boolean)).size;
      return { ...bucket, posts, creatorCount };
    }).filter(bucket => bucket.posts.length >= 1 && bucket.creatorCount >= 1)
      .sort((a, b) =>
        b.posts.length - a.posts.length ||
        b.creatorCount - a.creatorCount ||
        a.rule.label.localeCompare(b.rule.label)
      )
      .slice(0, Math.max(0, targetCount - explicitChanges.length));
    if (!candidates.length && !explicitChanges.length) {
      const posts = uniquePosts((topic.sourcePostIds || []).map(id => postsById.get(id)).filter(Boolean));
      const creatorCount = new Set(posts.map(handleKey).filter(Boolean)).size;
      if (posts.length >= 2 && creatorCount >= 2) {
        candidates = [{
          rule: { id: "general-discussion", label: "综合讨论", category: topic.category || "行业趋势" },
          posts,
          creatorCount
        }];
      }
    }
    for (const bucket of candidates) {
      const metrics = nodeMetrics(bucket.posts, config, now);
      const confidence = Math.min(.96, .78 + bucket.creatorCount * .025 + bucket.posts.length * .012);
      result.push({
        id: `direction-${slug(topic.normalizedText)}-${bucket.rule.id}`,
        nodeType: "change",
        parentTopicId: topic.id,
        normalizedText: bucket.rule.label,
        kind: "topic",
        category: bucket.rule.category,
        subject: topic.normalizedText,
        changeType: "讨论方向",
        directionOnly: true,
        changeSummary: `${bucket.posts.length} 条真实帖子形成「${bucket.rule.label}」讨论方向`,
        previousState: "此前未形成集中讨论",
        currentState: `${bucket.posts.length} 条帖子、${bucket.creatorCount} 位作者正在集中讨论`,
        ...metricFields(metrics),
        sourcePostIds: bucket.posts.map(post => post.id),
        confidence: Number(confidence.toFixed(2))
      });
    }
  }
  return result;
}

const INDUSTRY_THEME_RULES = [
  {
    id: "agent-workflows",
    label: "AI 编程与 Agent 工作流",
    patterns: [/\bcodex\b/iu, /\bclaude code\b/iu, /\bagent(?:ic)?\b/iu, /\bmcp\b/iu, /\bskill\b/iu, /\bcoding\b/iu, /编程|智能体|任务交付|工作流|浏览器自动化|桌面自动化|工具调用/u]
  },
  {
    id: "open-source-ecosystem",
    label: "开源 AI 生态",
    patterns: [/\bopen[\s-]?source\b/iu, /\bhugging\s*face\b/iu, /\bgithub\b/iu, /开源|开放权重|模型权重|社区生态/u]
  },
  {
    id: "multimodal-content",
    label: "多模态内容与交互",
    patterns: [/\bmultimodal\b/iu, /\bimage\b/iu, /\bvideo\b/iu, /\bvoice\b/iu, /\baudio\b/iu, /\bvision\b/iu, /多模态|图像|视频|语音|音频|视觉/u]
  },
  {
    id: "safety-governance",
    label: "AI 安全与治理",
    patterns: [/\bsafety\b/iu, /\bsecurity\b/iu, /\brisk\b/iu, /\bjailbreak\b/iu, /安全|治理|合规|风险|争议|漏洞|攻击/u]
  },
  {
    id: "commercial-market",
    label: "AI 商业化与市场",
    patterns: [/\bpricing\b/iu, /\bcost\b/iu, /\bmarket\b/iu, /\bbusiness\b/iu, /定价|成本|商业化|市场|套餐|额度|降价/u]
  },
  {
    id: "model-competition",
    label: "模型能力与推理竞争",
    patterns: [/\bgpt(?:-\d|\s\d)?/iu, /\bclaude\b/iu, /\bkimi\b/iu, /\bfable\b/iu, /\bmodel\b/iu, /\breasoning\b/iu, /\binference\b/iu, /\bbenchmark\b/iu, /模型|推理|性能|上下文|基准|评测/u]
  }
];

const CATEGORY_THEME_FALLBACK = {
  "应用场景": { id: "ai-applications", label: "AI 应用与产品实践" },
  "技术与能力": { id: "technical-capabilities", label: "AI 技术能力演进" },
  "事件与发布": { id: "product-evolution", label: "AI 产品与能力演进" },
  "争议与风险": { id: "safety-governance", label: "AI 安全与治理" },
  "行业趋势": { id: "industry-shifts", label: "AI 产业趋势" },
  "人物与机构": { id: "industry-organizations", label: "AI 产业与机构动态" }
};

function classifyIndustryDirection(change, postsById) {
  const evidenceText = (change.sourcePostIds || [])
    .map(id => postsById.get(id)?.text)
    .filter(Boolean)
    .join(" ");
  const labelText = `${change.normalizedText || ""} ${change.currentState || ""}`;
  const subjectText = String(change.subject || "");
  const text = `${labelText} ${subjectText} ${evidenceText}`;
  const ranked = INDUSTRY_THEME_RULES.map((rule, index) => {
    const labelHits = rule.patterns.filter(pattern => pattern.test(labelText)).length;
    const subjectHits = rule.patterns.filter(pattern => pattern.test(subjectText)).length;
    const evidenceHits = rule.patterns.filter(pattern => pattern.test(evidenceText)).length;
    const score = labelHits * 4 + subjectHits * 2.5 + evidenceHits + (INDUSTRY_THEME_RULES.length - index) * .001;
    return { ...rule, score };
  }).sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > .01) {
    return {
      id: ranked[0].id,
      label: ranked[0].label,
      confidence: Math.min(.98, .76 + ranked[0].score * .018)
    };
  }
  const fallback = CATEGORY_THEME_FALLBACK[change.category] || { id: "industry-shifts", label: "AI 产业趋势" };
  return { ...fallback, confidence: .76 };
}

function industryDirectionLabel(change) {
  const subject = String(change.subject || "").trim();
  const label = String(change.normalizedText || "").trim();
  if (!change.directionOnly || !subject || label.toLowerCase().includes(subject.toLowerCase())) return label;
  return `${subject} · ${label}`;
}

function assessDirection(change, postsById, config) {
  const posts = uniquePosts((change.sourcePostIds || []).map(id => postsById.get(id)).filter(Boolean));
  const familyCount = evidenceFamilyCount(posts);
  const creatorCount = new Set(posts.map(handleKey).filter(Boolean)).size;
  const dayCount = evidenceDayCount(posts);
  const rankablePostCount = posts.filter(hasRankableHeat).length;
  const highQualityPostCount = posts.filter(isHighQualityTopicPost).length;
  const accelerating = Number(change.risingPostCount || 0) + Number(change.burstPostCount || 0) > 0 ||
    Number(change.momentumRatio || 0) >= 2;
  const failures = [];
  if (familyCount < config.directionMinFamilies) failures.push("insufficient_evidence_families");
  if (creatorCount < config.directionMinCreators) failures.push("insufficient_independent_creators");
  if (dayCount < config.directionMinDays) failures.push("insufficient_time_span");
  if (rankablePostCount < config.directionMinFamilies) failures.push("insufficient_public_performance");
  if (highQualityPostCount < config.directionMinQualityPosts) failures.push("insufficient_high_quality_posts");
  if (!accelerating) failures.push("no_acceleration_signal");
  if (Number(change.confidence || 0) < .75) failures.push("low_confidence");
  return {
    established: failures.length === 0,
    failures,
    evidenceFamilyCount: familyCount,
    evidenceDayCount: dayCount,
    independentCreatorCount: creatorCount,
    rankablePostCount,
    highQualityPostCount,
    accelerating,
    minimumEvidenceFamilies: config.directionMinFamilies,
    minimumHighQualityPosts: config.directionMinQualityPosts,
    minimumCreators: config.directionMinCreators,
    minimumDays: config.directionMinDays
  };
}

export function buildIndustryTopicStructure(candidateChanges, postsById, config, now, minimumDirections = 6) {
  const assessedDirections = candidateChanges.map(change => ({
    change,
    assessment: assessDirection(change, postsById, config)
  }));
  const qualifiedDirections = assessedDirections
    .filter(item => item.assessment.established)
    .map(({ change, assessment }) => {
      const theme = classifyIndustryDirection(change, postsById);
      return {
        ...change,
        normalizedText: industryDirectionLabel(change),
        originalSubject: change.subject,
        themeAssignment: theme,
        directionStatus: "established",
        directionEvidence: assessment,
        evidenceFamilyCount: assessment.evidenceFamilyCount,
        evidenceDayCount: assessment.evidenceDayCount,
        highQualityPostCount: assessment.highQualityPostCount
      };
    });
  const groups = new Map();
  qualifiedDirections.forEach(direction => {
    const key = direction.themeAssignment.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(direction);
  });

  const establishedGroups = new Map([...groups].filter(([, directions]) => {
    const dimensionCount = new Set(directions.map(direction => direction.category)).size;
    return directions.length >= minimumDirections && dimensionCount >= 3;
  }));
  const directionPlacement = new Map();
  const topics = [...establishedGroups].map(([themeId, directions]) => {
    const sourcePostIds = [...new Set(directions.flatMap(direction => direction.sourcePostIds || []))];
    const posts = sourcePostIds.map(id => postsById.get(id)).filter(Boolean);
    const metrics = nodeMetrics(posts, config, now);
    const theme = directions[0].themeAssignment;
    const entityCounts = new Map();
    directions.forEach(direction => {
      const entity = String(direction.originalSubject || "").trim();
      if (entity) entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
    });
    const id = `topic-industry-${themeId}`;
    const memberDirectionIds = directions.map(direction => direction.id);
    const namingConfidence = directions.reduce((sum, direction) => sum + direction.themeAssignment.confidence, 0) / directions.length;
    directions.forEach(direction => directionPlacement.set(direction.id, { topicId: id, changeId: direction.id, standalone: false }));
    return {
      id,
      nodeType: "topic",
      normalizedText: theme.label,
      subject: theme.label,
      kind: "topic",
      category: dominantCategory(directions),
      childChangeIds: memberDirectionIds,
      memberDirectionIds,
      formationMethod: "direction_cluster",
      formationVersion: "2.0.0",
      coherence: Number(namingConfidence.toFixed(2)),
      dimensionCount: new Set(directions.map(direction => direction.category)).size,
      dominantEntities: [...entityCounts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name),
      namingConfidence: Number(namingConfidence.toFixed(2)),
      ...metricFields(metrics),
      sourcePostIds,
      confidence: Number(namingConfidence.toFixed(2))
    };
  });

  const establishedThemeIds = new Set(establishedGroups.keys());
  const changes = qualifiedDirections
    .filter(direction => establishedThemeIds.has(direction.themeAssignment.id))
    .map(direction => ({
      ...direction,
      parentTopicId: `topic-industry-${direction.themeAssignment.id}`
    }));
  const standaloneTopics = qualifiedDirections
    .filter(direction => !establishedThemeIds.has(direction.themeAssignment.id))
    .map(direction => {
      const id = `topic-direction-${slug(direction.normalizedText)}`;
      directionPlacement.set(direction.id, { topicId: id, changeId: id, standalone: true });
      return {
        ...direction,
        id,
        nodeType: "topic",
        parentTopicId: null,
        subject: direction.originalSubject || direction.subject,
        childChangeIds: [],
        memberDirectionIds: [direction.id],
        formationMethod: "standalone_direction",
        formationVersion: "2.0.0",
        coherence: 1,
        dimensionCount: 1,
        dominantEntities: [direction.originalSubject || direction.subject].filter(Boolean),
        namingConfidence: direction.confidence,
        directionOnly: true,
        collapsedDirection: true,
        collapsedDirectionId: direction.id
      };
    });
  return {
    topics: [...topics, ...standaloneTopics]
      .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount || a.normalizedText.localeCompare(b.normalizedText)),
    changes,
    directionPlacement,
    qualifiedDirections,
    candidateDirections: assessedDirections
      .filter(item => !item.assessment.established)
      .map(({ change, assessment }) => ({
        ...change,
        normalizedText: industryDirectionLabel(change),
        directionStatus: "candidate",
        ...assessment
      })),
    rejectedDirectionCount: candidateChanges.length - qualifiedDirections.length
  };
}

function explicitReferenceTo(post, mother) {
  const motherId = String(mother?.id || "");
  if (!motherId) return false;
  const referencedIds = [
    post.referencedPostId,
    post.quotedPostId,
    ...(post.referencedPostIds || [])
  ].filter(Boolean).map(String);
  const urls = [
    ...(post.referencedPostUrls || []),
    ...(post.externalUrls || [])
  ].map(String);
  return referencedIds.includes(motherId) ||
    urls.some(url => url.includes(`/status/${motherId}`)) ||
    (post.provenance?.status === "confirmed" && String(post.provenance.rootPostId) === motherId);
}

function topicMatchesPost(topic, post, trendingKeywords = []) {
  if ((topic.sourcePostIds || []).includes(post.id)) return true;
  const topicName = String(topic.normalizedText || "").toLowerCase();
  if (trendingKeywords.some(keyword =>
    String(keyword.normalizedText || "").toLowerCase() === topicName &&
    (keyword.sourcePostIds || []).includes(post.id) &&
    Number(keyword.confidence || 0) >= .75
  )) return true;
  return extractChangeCandidates(post).some(candidate =>
    String(candidate.subject || "").toLowerCase() === topicName &&
    Number(candidate.confidence || 0) >= .75
  );
}

function selectMother(memberPosts, allPostsById) {
  const rootVotes = new Map();
  for (const post of memberPosts) {
    const rootIds = [...new Set([
      post.provenance?.rootPostId,
      post.referencedPostId,
      post.quotedPostId,
      ...(post.referencedPostIds || [])
    ].filter(Boolean).map(String))];
    for (const rootId of rootIds) {
      if (!allPostsById.has(rootId)) continue;
      const vote = rootVotes.get(rootId) || { count: 0, confirmed: 0 };
      vote.count += 1;
      if (post.provenance?.status === "confirmed" || explicitReferenceTo(post, allPostsById.get(rootId))) {
        vote.confirmed += 1;
      }
      rootVotes.set(rootId, vote);
    }
  }
  const votedRoot = [...rootVotes]
    .sort((a, b) => b[1].confirmed - a[1].confirmed || b[1].count - a[1].count ||
      safeTime(allPostsById.get(a[0])?.publishedAt) - safeTime(allPostsById.get(b[0])?.publishedAt))[0];
  if (votedRoot) {
    return {
      post: allPostsById.get(votedRoot[0]),
      status: votedRoot[1].confirmed ? "confirmed" : "candidate",
      confidence: votedRoot[1].confirmed ? .98 : .78
    };
  }
  const earliest = [...memberPosts].sort((a, b) =>
    safeTime(a.publishedAt || a.capturedAt) - safeTime(b.publishedAt || b.capturedAt)
  )[0];
  return earliest ? { post: earliest, status: "direct", confidence: .55 } : null;
}

function buildDiscussionClusters(topicNodes, changeNodes, inWindowPosts, allPosts, options, now) {
  const allPostsById = new Map(allPosts.filter(post => post?.id).map(post => [String(post.id), post]));
  const inWindowIds = new Set(inWindowPosts.map(post => post.id));
  const followedHandles = new Set((options.followedCreators || []).map(item => handleKey(item)));
  const recentFloor = now - 7 * 24 * HOUR;
  const followedPosts = allPosts.filter(post =>
    followedHandles.has(handleKey(post)) &&
    safeTime(post.publishedAt || post.capturedAt) >= recentFloor &&
    safeTime(post.publishedAt || post.capturedAt) <= now
  );
  const primaryTopicByFollowedPost = new Map();
  for (const post of followedPosts) {
    const candidates = topicNodes
      .filter(topic => topicMatchesPost(topic, post, options.trendingKeywords || []))
      .sort((a, b) =>
        Number((b.sourcePostIds || []).includes(post.id)) - Number((a.sourcePostIds || []).includes(post.id)) ||
        String(b.normalizedText || "").length - String(a.normalizedText || "").length ||
        Number(b.confidence || 0) - Number(a.confidence || 0) ||
        Number(b.globalScore || 0) - Number(a.globalScore || 0)
      );
    if (candidates[0]) primaryTopicByFollowedPost.set(post.id, candidates[0].id);
  }
  const clusters = [];

  const makeCluster = (topic, change, memberIds, fallbackIds = []) => {
    if (!change?.id) return null;
    const posts = [...new Set([...memberIds, ...fallbackIds])]
      .map(id => allPostsById.get(String(id)))
      .filter(Boolean);
    if (!posts.length) return null;
    const motherResult = selectMother(posts, allPostsById);
    if (!motherResult?.post) return null;
    const mother = motherResult.post;
    const members = uniquePosts([mother, ...posts]);
    const explicitDerivativePostIds = members
      .filter(post => post.id !== mother.id && explicitReferenceTo(post, mother))
      .map(post => post.id);
    const inferredDerivativePostIds = members
      .filter(post =>
        post.id !== mother.id &&
        !explicitDerivativePostIds.includes(post.id) &&
        post.provenance?.status === "candidate" &&
        String(post.provenance.rootPostId || "") === String(mother.id)
      )
      .map(post => post.id);
    const followedPostIds = members.filter(post => followedHandles.has(handleKey(post))).map(post => post.id);
    const id = `cluster-${change.id}`;
    return {
      id,
      topicId: topic.id,
      changeId: change.id,
      motherNodeId: `discussion-${id}-${mother.id}`,
      motherPostId: mother.id,
      motherStatus: motherResult.status,
      motherCreatorHandle: mother.handle || mother.author || "",
      memberPostIds: members.map(post => post.id),
      followedPostIds,
      explicitDerivativePostIds,
      inferredDerivativePostIds,
      sourcePostIds: members.map(post => post.id),
      confidence: motherResult.confidence,
      windowFallback: followedPostIds.some(id => !inWindowIds.has(id)),
      score: Math.max(...members.map(post => Number(post.analysis?.score || 0)), 0)
    };
  };

  for (const topic of topicNodes) {
    const topicChanges = changeNodes.filter(change => change.parentTopicId === topic.id);
    const belongsToPrimaryTopic = postId => {
      const post = allPostsById.get(String(postId));
      if (!post || !followedHandles.has(handleKey(post))) return true;
      return primaryTopicByFollowedPost.get(post.id) === topic.id;
    };
    const matchedFollowed = followedPosts.filter(post =>
      primaryTopicByFollowedPost.get(post.id) === topic.id
    );
    const followedByChange = new Map(topicChanges.map(change => [change.id, []]));
    for (const post of matchedFollowed) {
      const extractedDirection = discussionDirectionForPost(post)?.label;
      const matchedChange = topicChanges.find(change => (change.sourcePostIds || []).includes(post.id)) ||
        topicChanges.find(change => change.directionOnly && change.normalizedText === extractedDirection) ||
        topicChanges.find(change => extractChangeCandidates(post).some(candidate =>
          String(candidate.normalizedText || "").toLowerCase() === String(change.normalizedText || "").toLowerCase()
        )) ||
        topicChanges[0];
      if (matchedChange) followedByChange.get(matchedChange.id)?.push(post);
    }
    for (const change of topicChanges) {
      const matchedForChange = followedByChange.get(change.id) || [];
      const cluster = makeCluster(
        topic,
        change,
        (change.sourcePostIds || []).filter(belongsToPrimaryTopic),
        matchedForChange.map(post => post.id)
      );
      if (cluster) clusters.push(cluster);
    }
  }
  return clusters;
}

function buildEdges(topicNodes, changeNodes, clusters) {
  const topicIds = new Set(topicNodes.map(topic => topic.id));
  const includedChanges = changeNodes.filter(change => topicIds.has(change.parentTopicId));
  const edges = includedChanges.map(change => ({
    id: `edge-${change.parentTopicId}-${change.id}`,
    sourceId: change.parentTopicId,
    targetId: change.id,
    relationType: "contains",
    sharedCreatorCount: 0,
    sharedChineseCreatorCount: 0,
    coPostCount: change.postCount,
    coPostIds: [],
    creatorHandles: [],
    sourcePostIds: change.sourcePostIds,
    strength: clamp(35 + change.globalScore * .45),
    weak: false,
    firstSeenAt: change.firstSeenAt,
    lastSeenAt: change.lastSeenAt
  }));
  for (const cluster of clusters) {
    edges.push({
      id: `edge-${cluster.changeId}-${cluster.motherNodeId}`,
      sourceId: cluster.changeId,
      targetId: cluster.motherNodeId,
      relationType: "cluster_source",
      sourcePostIds: cluster.sourcePostIds,
      strength: clamp(45 + cluster.score * .35),
      weak: false,
      firstSeenAt: null,
      lastSeenAt: null
    });
  }
  return edges;
}

export function buildTopicGraph(posts = [], options = {}) {
  const window = WINDOW_CONFIG[options.window] ? options.window : "24h";
  const config = WINDOW_CONFIG[window];
  const now = options.now ? safeTime(options.now) : Date.now();
  const start = now - config.hours * HOUR;
  const rawInWindow = posts.filter(post => {
    const time = safeTime(post.publishedAt || post.capturedAt);
    return post.id && time >= start && time <= now;
  });
  const inWindow = rawInWindow.filter(hasRankableHeat);
  const postsById = new Map(inWindow.map(post => [post.id, post]));
  const allChanges = buildChangeBuckets(inWindow)
    .map(bucket => buildChangeNode(bucket, config, now))
    .filter(change => change.confidence >= .75);
  const minimumTopicDirections = Math.max(1, Number(options.minimumTopicDirections) || 1);
  const changeTopics = buildTopicNodes(allChanges, postsById, config, now);
  const observationTopics = buildObservationTopics(options.trendingKeywords, changeTopics, postsById, config, now);
  const candidateTopics = [...changeTopics, ...observationTopics]
    .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount || a.normalizedText.localeCompare(b.normalizedText));
  const candidateTopicIds = new Set(candidateTopics.map(topic => topic.id));
  const explicitChanges = allChanges.filter(change => candidateTopicIds.has(change.parentTopicId));
  const discussionDirections = buildDiscussionDirectionNodes(
    candidateTopics,
    explicitChanges,
    postsById,
    config,
    now,
    Math.max(6, minimumTopicDirections)
  );
  const candidateChanges = [...explicitChanges, ...discussionDirections]
    .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount);
  const industryStructure = buildIndustryTopicStructure(
    candidateChanges,
    postsById,
    config,
    now,
    minimumTopicDirections
  );
  const assessedCandidateIds = new Set(candidateChanges.map(change => change.id));
  const rawDirectionSignals = allChanges
    .filter(change => !assessedCandidateIds.has(change.id))
    .map(change => {
      const assessment = assessDirection(change, postsById, config);
      return {
        ...change,
        normalizedText: industryDirectionLabel(change),
        directionStatus: "candidate",
        ...assessment
      };
    });
  const { topics, changes } = industryStructure;
  const candidateClusters = buildDiscussionClusters(
    candidateTopics,
    candidateChanges,
    inWindow,
    posts,
    options,
    now
  );
  const clusters = candidateClusters.flatMap(cluster => {
    const placement = industryStructure.directionPlacement.get(cluster.changeId);
    if (!placement) return [];
    return [{
      ...cluster,
      topicId: placement.topicId,
      changeId: placement.changeId,
      collapsedDirection: placement.standalone
    }];
  });
  const times = inWindow.map(post => safeTime(post.publishedAt || post.capturedAt)).filter(Boolean).sort((a, b) => a - b);
  const observedHours = times.length > 1 ? Math.min(config.hours, Math.max(1, (now - times[0]) / HOUR)) : 0;
  return {
    window,
    calculatedAt: new Date(now).toISOString(),
    coverage: {
      requestedHours: config.hours,
      observedHours: Number(observedHours.toFixed(1)),
      complete: observedHours >= config.hours * .9,
      postCount: rawInWindow.length,
      rankablePostCount: inWindow.length,
      excludedWithoutHeatCount: rawInWindow.length - inWindow.length,
      topicCount: topics.length,
      changeCount: changes.length,
      rejectedShallowTopicCount: candidateTopics.length,
      rejectedWeakDirectionCount: industryStructure.rejectedDirectionCount
    },
    standard: {
      minimumPosts: config.minPosts,
      minimumCreators: config.minCreators,
      directionMinimumEvidenceFamilies: config.directionMinFamilies,
      directionMinimumCreators: config.directionMinCreators,
      directionMinimumDays: config.directionMinDays,
      directionMinimumHighQualityPosts: config.directionMinQualityPosts,
      directionRequiresAcceleration: true,
      strongEdgeCreators: 2,
      observationMinimumPosts: 2,
      observationMinimumCreators: 2,
      minimumTopicDirections,
      topicFormation: "direction_cluster_v2",
      rankingEvidence: {
        requiresViews: true,
        requiresInteractions: true,
        requiresLikes: true,
        minimumViewsPerPost: TOPIC_QUALITY_STANDARD.minimumViews,
        minimumLikesPerPost: TOPIC_QUALITY_STANDARD.minimumLikes,
        minimumInteractionsPerPost: TOPIC_QUALITY_STANDARD.minimumInteractions,
        minimumQualifiedPosts: TOPIC_QUALITY_STANDARD.minimumPosts
      },
      audience: "全球 AI 趋势 + 中文 X / Twitter 推圈跟进",
      weights: { coverage: .25, creatorDiversity: .2, momentum: .25, hotPostStrength: .2, freshness: .1 }
    },
    candidateDirections: [...industryStructure.candidateDirections, ...rawDirectionSignals],
    nodes: [...topics, ...changes],
    clusters,
    edges: buildEdges(topics, changes, clusters)
  };
}
