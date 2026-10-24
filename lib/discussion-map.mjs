import { buildTopicGraph, calculateTopicMetrics, isHighQualityTopicPost } from "./topic-graph.mjs";
import { detectPostLanguage } from "./trending.mjs";

const cleanHandle = value => String(value || "").trim().replace(/^@/, "").toLowerCase();
const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const unique = values => [...new Set(values.filter(Boolean).map(String))];
const slug = value => String(value || "")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 48);

const DETAIL_RULES = [
  { id: "open-pledge", label: () => "开源模型公开倡议", pattern: /\bopen letter\b|\bmanifesto\b|\bpledge\b|公开信|联名|宣言|倡议/iu },
  { id: "quota-cost", label: subject => `${subject} 额度与成本`, pattern: /\bquota\b|\blimit\b|\busage\b|\btoken\b|额度|用量|限额|周额度|token/iu },
  { id: "video-editing", label: subject => `${subject} 视频工作流`, pattern: /\bvideo\b|\bffmpeg\b|\bediting\b|视频|剪辑|字幕|转录/iu },
  { id: "image-visual", label: subject => `${subject} 图像与视觉生成`, pattern: /\bimage\b|\bvisual\b|\bvision\b|\btext-to-cad\b|图像|视觉|生图|文生图|三维生成/iu },
  { id: "browser-desktop", label: subject => `${subject} 浏览器与桌面自动化`, pattern: /\bbrowser\b|\bdesktop\b|浏览器|网页操作|桌面端|桌面自动化/iu },
  { id: "agent-task", label: subject => `${subject} 任务执行与自动化`, pattern: /\bagent workflow\b|\btask execution\b|\bautomation\b|\bworkflow\b|任务交付|任务执行|自动化|工作流/iu },
  { id: "coding-review", label: subject => `${subject} 编程与代码审查`, pattern: /\bcoding\b|\bcode review\b|\bdebug\b|\bterminal\b|\bide\b|编程|代码审查|调试|终端|编辑器/iu },
  { id: "prompt-context", label: subject => `${subject} 提示词与上下文`, pattern: /\bsystem prompt\b|\bcontext\b|\bmemory\b|系统提示词|提示词|上下文|记忆/iu },
  { id: "skill-protocol", label: subject => `${subject} Skill 与协议生态`, pattern: /\bskill\b|\bmcp\b|\bplugin\b|Skill|插件|协议/iu },
  { id: "open-tooling", label: subject => `${subject} 开源工具与项目`, pattern: /\bopen[\s-]?source\b|\bgithub\b|\brepository\b|开源项目|开源工具|代码仓库/iu },
  { id: "integration", label: subject => `${subject} 模型与工具接入`, pattern: /\bintegrat|\bconnect|\bapi\b|接入|集成|兼容|连接器|工具调用/iu },
  { id: "safety", label: subject => `${subject} 安全与越权风险`, pattern: /\bsecurity\b|\bsafety\b|\brisk\b|\bjailbreak\b|\battack\b|安全|风险|越权|入侵|漏洞|越狱/iu },
  { id: "benchmark", label: subject => `${subject} 能力评测`, pattern: /\bbenchmark\b|\beval\b|\bperformance\b|\bscore\b|基准|评测|测评|性能|跑分/iu },
  { id: "reasoning", label: subject => `${subject} 推理与科研能力`, pattern: /\breasoning\b|\binference\b|\bsota\b|\bresearch\b|推理|科研|研究能力|底层突破/iu },
  { id: "pricing", label: subject => `${subject} 定价变化`, pattern: /\bprice\b|\bpricing\b|\bcost\b|定价|价格|降价|成本/iu },
  { id: "migration", label: subject => `${subject} 用户迁移`, pattern: /\bmigrat|\bswitch|\breplace|迁移|切换|替代|转用/iu },
  { id: "release", label: subject => `${subject} 新版本发布`, pattern: /\brelease|\blaunch|\bupdate\b|\bnew model\b|发布|上线|更新|新模型|新版本/iu }
];

const SUBJECT_RULES = [
  [/\bclaude code\b/iu, "Claude Code"],
  [/\bcodex\b/iu, "Codex"],
  [/\bgpt[-\s]?5\.?6\b/iu, "GPT-5.6"],
  [/\bopus\s*5\b|\bclaude\b/iu, "Claude"],
  [/\bkimi\s*k?3\b/iu, "Kimi K3"],
  [/\bopenai\b/iu, "OpenAI"],
  [/\bmcp\b/iu, "MCP"],
  [/\bagent(?:ic)?\b|智能体|Agent/iu, "AI Agent"]
];

const postInteractionTotal = post => ["replies", "reposts", "likes", "bookmarks"]
  .reduce((sum, key) => sum + Math.max(0, Number(post?.[key]) || 0), 0);
const evidenceFamily = post => String(post?.provenance?.rootPostId || post?.rootPostId || post?.referencedPostId || post?.quotedPostId || post?.id || "");

function postSubject(post, fallback = "AI") {
  const text = String(post?.text || "");
  return SUBJECT_RULES.find(([pattern]) => pattern.test(text))?.[1] ||
    String(fallback || "AI").replace(/\s*·.*$/u, "").trim() ||
    "AI";
}

function granularFocuses(focus, postsById, options) {
  const buckets = new Map();
  for (const postId of focus.sourcePostIds || []) {
    const post = postsById.get(String(postId));
    if (!post) continue;
    const rules = DETAIL_RULES.filter(item => item.pattern.test(String(post.text || ""))).slice(0, 4);
    for (const rule of rules) {
      const subject = rule.id === "open-pledge" ? "AI" : postSubject(post, focus.subject);
      const label = rule.label(subject);
      const key = `${rule.id}:${label.toLowerCase()}`;
      const bucket = buckets.get(key) || { rule, label, posts: [] };
      bucket.posts.push(post);
      buckets.set(key, bucket);
    }
  }
  const familyMinimum = options.window === "7d" ? 3 : 2;
  const creatorMinimum = 2;
  return [...buckets.values()].flatMap(bucket => {
    const posts = [...new Map(bucket.posts.map(post => [String(post.id), post])).values()];
    const families = new Set(posts.map(evidenceFamily).filter(Boolean)).size;
    const creators = new Set(posts.map(post => cleanHandle(post.handle || post.author)).filter(Boolean)).size;
    const hotPosts = posts.filter(post => ["升温", "爆发"].includes(post.analysis?.level));
    const burstPosts = posts.filter(post => post.analysis?.level === "爆发");
    const highQualityPostCount = posts.filter(isHighQualityTopicPost).length;
    const highDiscussion = highQualityPostCount >= 5 &&
      families >= familyMinimum && creators >= creatorMinimum && hotPosts.length > 0;
    const highHeat = highQualityPostCount >= 5 &&
      families >= 2 && creators >= 2 && burstPosts.length > 0;
    if (!highDiscussion && !highHeat) return [];
    const metrics = calculateTopicMetrics(posts, { window: options.window, now: options.now });
    if (!metrics.rankEligible || !posts.some(post => postInteractionTotal(post) > 0)) return [];
    const chinesePosts = posts.filter(post => detectPostLanguage(post.text) === "zh");
    return [{
      ...focus,
      ...metrics,
      id: `focus-${slug(bucket.label)}`,
      normalizedText: bucket.label,
      sourcePostIds: posts.map(post => String(post.id)),
      evidenceFamilyCount: families,
      highQualityPostCount,
      creatorCount: creators,
      zhPostCount: chinesePosts.length,
      zhCreatorCount: new Set(chinesePosts.map(post => cleanHandle(post.handle || post.author)).filter(Boolean)).size,
      originalDirectionText: focus.normalizedText,
      admissionType: highDiscussion ? "corroborated_signal" : "high_heat_cluster",
      priorityScore: Math.max(Number(metrics.globalScore || 0), Number(metrics.chineseScore || 0)),
      changeSummary: `${posts.length} 条真实帖子集中讨论「${bucket.label}」`,
      currentState: `${posts.length} 条帖子、${creators} 位作者正在集中讨论`
    }];
  });
}

function buildFallbackCluster(focus, posts, followedCreators = []) {
  const followed = new Set(followedCreators.map(item => cleanHandle(item.handle)));
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  const members = unique(focus.sourcePostIds || []).map(id => postsById.get(id)).filter(Boolean);
  if (!members.length) return null;
  const rootReferences = new Map();
  for (const post of members) {
    const rootId = String(
      post.provenance?.rootPostId ||
      post.rootPostId ||
      post.referencedPostId ||
      post.quotedPostId ||
      ""
    );
    if (!rootId) continue;
    const item = rootReferences.get(rootId) || { postId: rootId, creators: new Set(), derivativePostIds: [] };
    item.creators.add(cleanHandle(post.handle || post.author));
    item.derivativePostIds.push(String(post.id));
    rootReferences.set(rootId, item);
  }
  const verified = [...rootReferences.values()]
    .filter(item => item.creators.size >= 2 && postsById.has(item.postId))
    .sort((a, b) => b.creators.size - a.creators.size)[0];
  const mother = verified
    ? postsById.get(verified.postId)
    : [...members].sort((a, b) =>
      safeTime(a.publishedAt || a.capturedAt) - safeTime(b.publishedAt || b.capturedAt)
    )[0];
  if (!mother) return null;
  const explicitDerivativePostIds = verified?.derivativePostIds || [];
  const id = `cluster-focus-${slug(focus.id)}`;
  return {
    id,
    topicId: focus.id,
    changeId: focus.id,
    motherNodeId: `discussion-${id}-root`,
    motherPostId: String(mother.id),
    motherStatus: verified ? "confirmed" : "candidate",
    motherCreatorHandle: mother.handle || mother.author,
    memberPostIds: unique(members.map(post => post.id)),
    followedPostIds: unique(members
      .filter(post => followed.has(cleanHandle(post.handle || post.author)))
      .map(post => post.id)),
    explicitDerivativePostIds,
    inferredDerivativePostIds: unique(members
      .filter(post => String(post.id) !== String(mother.id) && !explicitDerivativePostIds.includes(String(post.id)))
      .map(post => post.id)),
    sourcePostIds: unique(members.map(post => post.id)),
    confidence: verified ? .96 : .78,
    score: focus.globalScore,
    windowFallback: false
  };
}

function enforceConfirmedInitiator(cluster, postsById) {
  const derivativeCreators = new Set(
    unique(cluster.explicitDerivativePostIds || [])
      .map(id => postsById.get(String(id)))
      .filter(Boolean)
      .map(post => cleanHandle(post.handle || post.author))
      .filter(Boolean)
  );
  const confirmed = cluster.motherStatus === "confirmed" && derivativeCreators.size >= 2;
  return {
    ...cluster,
    motherStatus: confirmed ? "confirmed" : "candidate",
    verifiedDerivativeCreatorCount: derivativeCreators.size
  };
}

function focusFromDirection(node, industryTheme, admissionType) {
  return {
    ...node,
    nodeType: "topic",
    focusNode: true,
    collapsedDirection: true,
    childChangeIds: [],
    parentTopicId: null,
    industryTheme: industryTheme || node.category || "AI 行业动态",
    admissionType,
    priorityScore: Math.max(Number(node.globalScore || 0), Number(node.chineseScore || 0)),
    focusVersion: "1.0.0"
  };
}

function isHighHeatCandidate(node) {
  return Number(node.highQualityPostCount || 0) >= 5 &&
    Number(node.evidenceFamilyCount || 0) >= 3 &&
    Number(node.independentCreatorCount || node.creatorCount || 0) >= 2 &&
    Number(node.burstPostCount || 0) >= 1 &&
    Number(node.momentumRatio || 0) >= 2 &&
    (Number(node.globalScore || 0) >= 75 || Number(node.chineseScore || 0) >= 70) &&
    Number(node.confidence || 0) >= .75;
}

export function buildDiscussionMap(posts = [], options = {}) {
  const graph = buildTopicGraph(posts, options);
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const formalDirections = graph.nodes.filter(node =>
    node.nodeType === "change" || (node.nodeType === "topic" && node.collapsedDirection)
  );
  const formalIds = new Set(formalDirections.map(node => node.id));
  const highHeatDirections = (graph.candidateDirections || [])
    .filter(node => !formalIds.has(node.id) && isHighHeatCandidate(node));
  const baseFocuses = [
    ...formalDirections.map(node => {
      const parent = nodeById.get(node.parentTopicId);
      return focusFromDirection(node, parent?.normalizedText, "high_discussion");
    }),
    ...highHeatDirections.map(node => focusFromDirection(node, node.category, "high_heat_cluster"))
  ];
  const granular = baseFocuses.flatMap(focus => granularFocuses(focus, postsById, {
    window: graph.window,
    now: graph.calculatedAt
  }));
  const selectedFocuses = granular.length >= 4 ? granular : baseFocuses;
  const focuses = [...new Map(selectedFocuses
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .map(node => [node.normalizedText.toLowerCase(), node])).values()]
    .sort((a, b) =>
    b.priorityScore - a.priorityScore ||
    b.evidenceFamilyCount - a.evidenceFamilyCount ||
    b.creatorCount - a.creatorCount
  ).slice(0, 20)
    .map((node, index) => ({
      ...node,
      heatRank: index + 1,
      heatZone: index === 0 ? "core" : index < 7 ? "active" : "peripheral"
    }));
  const focusIds = new Set(focuses.map(node => node.id));
  const clusters = focuses.map(focus => {
    const existing = graph.clusters.find(cluster => cluster.changeId === focus.id);
    const cluster = existing
      ? { ...existing, topicId: focus.id, changeId: focus.id }
      : buildFallbackCluster(focus, posts, options.followedCreators || []);
    return cluster ? enforceConfirmedInitiator(cluster, postsById) : null;
  }).filter(Boolean);
  const clusterByFocus = new Map(clusters.map(cluster => [cluster.changeId, cluster]));
  const edges = [];
  const promotedIds = new Set(focuses.map(node => node.id));
  const candidateSignals = (graph.candidateDirections || [])
    .filter(node => !promotedIds.has(node.id))
    .map(node => ({
      id: node.id,
      normalizedText: node.normalizedText,
      evidenceFamilyCount: node.evidenceFamilyCount,
      creatorCount: node.independentCreatorCount || node.creatorCount,
      globalScore: node.globalScore,
      chineseScore: node.chineseScore,
      missingRequirements: node.failures || []
    }));
  return {
    window: graph.window,
    calculatedAt: graph.calculatedAt,
    coverage: {
      ...graph.coverage,
      focusCount: focuses.length,
      candidateCount: candidateSignals.length,
      topicCount: focuses.length,
      changeCount: 0
    },
    standard: {
      ...graph.standard,
      mapType: "discussion_focus",
      visibleIndustryTopics: false,
      visibleRelations: false,
      granularMinimumFamilies: 2,
      granularMinimumCreators: 2,
      maximumFocusCount: 20,
      highHeatMinimumFamilies: 2,
      highHeatMinimumCreators: 2,
      highHeatMinimumScore: 75
    },
    nodes: focuses,
    clusters,
    edges,
    candidateSignals
  };
}
