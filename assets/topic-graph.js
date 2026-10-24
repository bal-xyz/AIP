const WIDTH = 1280;
const HEIGHT = 720;
const LAYOUT_VERSION = 39;
const MAX_CHANGES = 64;
const MAX_AMBIENT_HOT_POSTS = 100;
const AMBIENT_HOT_REFRESH_MS = 2 * 60 * 60 * 1000;
const AI_SIGNAL_PATTERN = /\bai\b|人工智能|智能体|agent|llm|大模型|模型|推理|多模态|机器学习|生成式|机器人|具身|codex|cursor|copilot|mcp|openai|anthropic|claude|gpt|gemini|deepseek|qwen|通义|豆包|kimi|nvidia|英伟达|算力|芯片|prompt|rag|token|vibe coding|skill/iu;
const MIN_ZOOM = .93;
const MAX_ZOOM = 4;
const CATEGORY_COLORS = {
  "模型与产品": "#75b8ff",
  "技术与能力": "#62d6c5",
  "应用场景": "#9caeff",
  "行业趋势": "#d2ae67",
  "事件与发布": "#ef8f65",
  "争议与风险": "#ff7955",
  "人物与机构": "#c5d0da"
};
const layoutCache = new Map();
const animatedLayouts = new Set();
const cameraStateByWindow = new Map();
const ambientHotSnapshots = new Map();

const esc = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));
const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const cleanHandle = value => String(value || "").trim().replace(/^@/, "").toLowerCase();

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function chineseStatusLabel(status) {
  return ({ none: "尚未进入中文圈", first: "中文首发信号", confirmed: "中文圈已确认", concentrated: "中文圈集中跟进" })[status] || status;
}

function compactAge(value) {
  const hours = Math.max(0, (Date.now() - Date.parse(value)) / 3_600_000);
  if (!Number.isFinite(hours)) return "时间未知";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m前`;
  if (hours < 48) return `${Math.round(hours)}h前`;
  return `${Math.round(hours / 24)}d前`;
}

function lagLabel(node) {
  if (!node.chineseFirstSeenAt) return "中文尚未跟进";
  if (!node.chineseLagHours) return "中文同步出现";
  return `中文滞后 ${node.chineseLagHours < 1 ? `${Math.max(1, Math.round(node.chineseLagHours * 60))}m` : `${node.chineseLagHours.toFixed(node.chineseLagHours < 10 ? 1 : 0)}h`}`;
}

export function graphNodeRadius(node) {
  if (node?.focusNode) return 5.2;
  if (node?.nodeType === "topic") return 6;
  if (node?.nodeType === "change") return 3.2;
  if (node?.nodeType === "post") return 2.2;
  if (node?.nodeType === "creator") {
    if (node.isSource) return 3;
    if (node.followed) return 3.2;
    return 2.7;
  }
  return 3;
}

export function graphMotherRingRadius(node) {
  return graphNodeRadius(node) + 1.9;
}

export function graphNodeTextOffsets(node) {
  const r = graphNodeRadius(node);
  const labelGap = node?.focusNode ? 17
    : node?.nodeType === "topic" ? 17
      : node?.nodeType === "change" ? 17
        : node?.nodeType === "creator" && node?.isSource ? 14
          : 12.5;
  const labelY = r + labelGap;
  return {
    parentY: -(r + 7.5),
    labelY,
    summaryY: labelY + 9
  };
}

export function graphNodeTypography(node) {
  if (node?.focusNode) return { label: 12.5, parent: 6.2, summary: 6 };
  if (node?.nodeType === "topic") return { label: 11.5, parent: 6.5, summary: 6 };
  if (node?.nodeType === "change") return { label: 12.5, parent: 6.2, summary: 6 };
  if (node?.nodeType === "post") return { label: 7.5, parent: 5.5, summary: 5.5 };
  if (node?.nodeType === "creator") {
    if (node.isSource) return { label: 9.5, parent: 5.8, summary: 5.8 };
    return { label: 7.5, parent: 5.5, summary: 5.5 };
  }
  return { label: 8, parent: 6, summary: 6 };
}

const clampScore = value => Math.max(0, Math.min(100, Number(value) || 0));

export function directionHeatLevel(score) {
  const value = clampScore(score);
  return value > 0 ? Math.min(5, Math.ceil(value / 20)) : 0;
}

export function directionHeatArcGeometry(score) {
  const count = 5;
  const lit = directionHeatLevel(score);
  const radius = 7.8;
  const segmentDegrees = 48;
  const polar = degrees => {
    const angle = degrees / 180 * Math.PI;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    };
  };
  return Array.from({ length: count }, (_, index) => {
    const startDegrees = -114 + index * 72;
    const endDegrees = startDegrees + segmentDegrees;
    const start = polar(startDegrees);
    const end = polar(endDegrees);
    return {
      d: `M${start.x.toFixed(2)} ${start.y.toFixed(2)}A${radius} ${radius} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
      lit: index < lit
    };
  });
}

function directionHeatArcs(node) {
  if (node.nodeType !== "change" && !node.focusNode) return "";
  return directionHeatArcGeometry(node.chineseScore).map(segment =>
    `<path class="direction-heat-arc ${segment.lit ? "is-lit" : ""}" d="${segment.d}"></path>`
  ).join("");
}

function nodeIdentityMark(node, r) {
  if (node.nodeType !== "creator") return "";
  const marks = [];
  if (node.isSource) {
    marks.push(`<circle class="node-mother-ring" r="${graphMotherRingRadius(node).toFixed(1)}"></circle>`);
  }
  if (node.isSource && node.sourceConfirmed) {
    const y = graphMotherRingRadius(node) + 1.2;
    marks.push(`<line class="node-source-mark" x1="-2.4" y1="${y.toFixed(1)}" x2="2.4" y2="${y.toFixed(1)}"></line>`);
  }
  if (node.followed) {
    marks.push(`<path class="node-follow-mark" d="M${(r + 1).toFixed(1)} ${(r + 1.8).toFixed(1)}l1.5 1.5 2.6-3"></path>`);
  }
  if (node.hasAcceleratingPost) {
    marks.push(`<circle class="node-acceleration-halo halo-inner" r="${(r + 3.8).toFixed(1)}"></circle>`);
    marks.push(`<circle class="node-acceleration-halo halo-outer" r="${(r + 3.8).toFixed(1)}"></circle>`);
  }
  return marks.join("");
}

export function graphLod(zoom) {
  if (zoom < .85) return "far";
  if (zoom < 1.35) return "default";
  if (zoom < 1.85) return "near";
  return "detail";
}

export function clampGraphCamera(camera) {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(camera.zoom) || 1));
  const panFactor = Math.max(.72, zoom * .72);
  return {
    zoom,
    panX: Math.max(-WIDTH * panFactor, Math.min(WIDTH * panFactor, Number(camera.panX) || 0)),
    panY: Math.max(-HEIGHT * panFactor, Math.min(HEIGHT * panFactor, Number(camera.panY) || 0))
  };
}

export function zoomGraphCameraAt(
  camera,
  nextZoom,
  anchorX = WIDTH / 2,
  anchorY = HEIGHT / 2,
  centerX = WIDTH / 2,
  centerY = HEIGHT / 2
) {
  const current = clampGraphCamera(camera);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  const ratio = zoom / current.zoom;
  return clampGraphCamera({
    zoom,
    panX: anchorX - centerX - (anchorX - centerX - current.panX) * ratio,
    panY: anchorY - centerY - (anchorY - centerY - current.panY) * ratio
  });
}

function uniqueById(values) {
  return [...new Map(values.map(value => [value.id, value])).values()];
}

function normalizedTerms(value) {
  const text = String(value || "").toLowerCase().replace(/[\s\-_.:/\\]+/g, "");
  const ascii = String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const chinese = [...String(value || "").matchAll(/[\u3400-\u9fff]{2,}/gu)]
    .flatMap(match => {
      const value = match[0];
      return value.length === 2
        ? [value]
        : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
    });
  return { text, tokens: new Set([...ascii, ...chinese].filter(token => !["ai", "the", "and"].includes(token))) };
}

function semanticAffinity(source, target) {
  const a = normalizedTerms(source);
  const b = normalizedTerms(target);
  if (!a.text || !b.text) return 0;
  if (a.text.includes(b.text) || b.text.includes(a.text)) return 1;
  const overlap = [...a.tokens].filter(token => b.tokens.has(token)).length;
  const union = new Set([...a.tokens, ...b.tokens]).size;
  return union ? overlap / union : 0;
}

export function computeTopicAffinities(node, topics = []) {
  const sourceIds = new Set((node?.sourcePostIds || []).map(String));
  const primaryTopicId = node?.topicId || node?.parentTopicId || null;
  const semanticText = [
    node?.normalizedText,
    node?.representativeText,
    node?.currentState,
    node?.previousState
  ].filter(Boolean).join(" ");
  return topics.map(topic => {
    const topicSourceIds = new Set((topic.sourcePostIds || []).map(String));
    const sharedPostCount = [...sourceIds].filter(id => topicSourceIds.has(id)).length;
    const evidenceOverlap = sourceIds.size ? sharedPostCount / sourceIds.size : 0;
    const semantic = semanticAffinity(semanticText, topic.normalizedText);
    const primary = topic.id === primaryTopicId;
    const hasHardEvidence = primary || sharedPostCount > 0 || semantic >= .55;
    const score = hasHardEvidence
      ? Math.max(primary ? .94 : 0, evidenceOverlap * .74 + semantic * .26)
      : 0;
    return {
      topicId: topic.id,
      score: Number(Math.min(1, score).toFixed(4)),
      sharedPostCount,
      evidenceOverlap: Number(evidenceOverlap.toFixed(4)),
      semantic: Number(semantic.toFixed(4)),
      primary
    };
  }).sort((a, b) => b.score - a.score || Number(b.primary) - Number(a.primary));
}

function topicPairAffinity(a, b) {
  const aIds = new Set((a.sourcePostIds || []).map(String));
  const bIds = new Set((b.sourcePostIds || []).map(String));
  const shared = [...aIds].filter(id => bIds.has(id)).length;
  const overlap = shared / Math.max(1, Math.min(aIds.size, bIds.size));
  return Math.min(1, overlap * .78 + semanticAffinity(a.normalizedText, b.normalizedText) * .22);
}

export function graphLabelScale(zoom) {
  const safeZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(zoom) || 1));
  return Number((1 / Math.sqrt(safeZoom)).toFixed(4));
}

export function deriveGraphView(graph, selectedNodeId = null) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const topics = nodes.filter(node => node.nodeType === "topic")
    .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount);
  const selected = nodes.find(node => node.id === selectedNodeId);
  const defaultRoot = topics[0];
  const rootNodeId = selected?.nodeType === "topic"
    ? selected.id
    : selected?.parentTopicId || defaultRoot?.id || null;
  const root = topics.find(topic => topic.id === rootNodeId);
  const visibleTopics = [root, ...topics.filter(topic => topic.id !== rootNodeId)]
    .filter(Boolean);
  const visibleTopicIds = new Set(visibleTopics.map(topic => topic.id));
  const expandedTopicId = selected?.nodeType === "topic"
    ? selected.id
    : selected?.parentTopicId || null;
  const changeGroups = new Map(visibleTopics.map(topic => [topic.id, []]));
  nodes.filter(node => node.nodeType === "change" && visibleTopicIds.has(node.parentTopicId))
    .map(node => ({ ...node, topicAffinities: computeTopicAffinities(node, visibleTopics) }))
    .sort((a, b) => b.globalScore - a.globalScore || b.creatorCount - a.creatorCount)
    .forEach(node => changeGroups.get(node.parentTopicId)?.push(node));
  const rootChanges = (changeGroups.get(rootNodeId) || []).slice(0, 6);
  const visibleChanges = visibleTopics.flatMap(topic =>
    (changeGroups.get(topic.id) || []).slice(0, 6)
  ).slice(0, MAX_CHANGES);
  const visibleNodes = [...visibleTopics, ...visibleChanges];
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id));

  const containsEdges = edges.filter(edge =>
    edge.relationType === "contains" &&
    visibleNodeIds.has(edge.sourceId) &&
    visibleNodeIds.has(edge.targetId)
  );
  const clusterEdges = edges.filter(edge =>
    edge.relationType === "cluster_source" &&
    visibleNodeIds.has(edge.sourceId)
  );
  const visibleEdges = containsEdges;
  const focusedEdges = selectedNodeId
    ? visibleEdges.filter(edge =>
      [edge.sourceId, edge.targetId].includes(selectedNodeId) ||
      [edge.sourceId, edge.targetId].includes(rootNodeId) ||
      (selected?.nodeType === "change" && edge.sourceId === rootNodeId)
    )
    : visibleEdges.filter(edge => edge.sourceId === rootNodeId);

  const featuredChanges = selected?.nodeType === "change"
    ? uniqueById([selected, ...rootChanges]).slice(0, 3)
    : rootChanges.slice(0, 3);
  const labeledTopics = visibleTopics;
  const labeledChanges = selected?.nodeType === "change"
    ? uniqueById([selected, ...featuredChanges]).slice(0, 4)
    : featuredChanges;
  const labelIds = new Set([...labeledTopics, ...labeledChanges, selected].filter(Boolean).map(node => node.id));
  return {
    selectedNodeId: selected?.id || null,
    selectedNodeType: selected?.nodeType || null,
    rootNodeId,
    visibleTopics,
    rootChanges,
    featuredChanges,
    visibleChanges,
    visibleNodes,
    visibleNodeIds,
    labelIds,
    clusterEdges,
    skeletonEdges: visibleEdges,
    focusedEdges,
    visibleEdges
  };
}

function creatorGroupsForNode(node, posts, followedSet) {
  const sourceIds = new Set(node?.sourcePostIds || []);
  const groups = new Map();
  posts.filter(post => sourceIds.has(post.id)).forEach(post => {
    const handle = cleanHandle(post.handle || post.author);
    if (!handle) return;
    const time = post.publishedAt || post.capturedAt || null;
    const item = groups.get(handle) || {
      handle: String(post.handle || `@${handle}`),
      displayName: String(post.author || post.handle || handle),
      postIds: [],
      posts: [],
      firstSeenAt: time,
      maxScore: 0,
      maxHeat: "普通",
      followed: followedSet.has(handle)
    };
    item.postIds.push(post.id);
    item.posts.push(post);
    if (safeTime(time) < safeTime(item.firstSeenAt)) item.firstSeenAt = time;
    item.maxScore = Math.max(item.maxScore, Number(post.analysis?.score || 0));
    if (post.analysis?.level === "爆发" || (post.analysis?.level === "升温" && item.maxHeat !== "爆发")) item.maxHeat = post.analysis.level;
    groups.set(handle, item);
  });
  return [...groups.values()].sort((a, b) =>
    safeTime(a.firstSeenAt) - safeTime(b.firstSeenAt) ||
    Number(b.followed) - Number(a.followed) ||
    b.maxScore - a.maxScore
  );
}

function explicitlyReferences(group, source) {
  const sourceHandle = cleanHandle(source.handle);
  return group.posts.some(post => {
    const text = String(post.text || "").toLowerCase();
    return text.includes(`@${sourceHandle}`) ||
      (post.referencedPostId && source.postIds.includes(post.referencedPostId)) ||
      (post.quotedPostId && source.postIds.includes(post.quotedPostId)) ||
      (post.provenance?.status === "confirmed" && source.postIds.includes(post.provenance.rootPostId));
  });
}

function groupLanguage(group) {
  const firstPost = [...group.posts].sort((a, b) =>
    safeTime(a.publishedAt || a.capturedAt) - safeTime(b.publishedAt || b.capturedAt)
  )[0];
  return /[\u3400-\u9fff]/u.test(String(firstPost?.text || "")) ? "zh" : "en";
}

const graphWindowHours = window => ({ "2h": 2, "24h": 24, "7d": 168 })[window] || 24;
const isChinesePost = post => /[\u3400-\u9fff]/u.test(String(post?.text || ""));
const postInteractionCount = post =>
  Math.max(0, Number(post?.likes) || 0) +
  Math.max(0, Number(post?.replies) || 0) +
  Math.max(0, Number(post?.reposts ?? post?.retweets) || 0) +
  Math.max(0, Number(post?.bookmarks) || 0);
const postPublicSignal = post =>
  Math.max(0, Number(post?.views) || 0) +
  Math.max(0, Number(post?.likes) || 0) * 20 +
  Math.max(0, Number(post?.replies) || 0) * 30 +
  Math.max(0, Number(post?.reposts ?? post?.retweets) || 0) * 35 +
  Math.max(0, Number(post?.bookmarks) || 0) * 15;

export function creatorDirectionHeat(posts = [], options = {}) {
  const uniquePosts = uniqueById(posts.filter(Boolean));
  const now = safeTime(options.now) || Date.now();
  const windowHours = graphWindowHours(options.window);
  const totalPublicSignal = uniquePosts.reduce((sum, post) => sum + postPublicSignal(post), 0);
  const maxPublicSignal = Math.max(totalPublicSignal, Number(options.maxPublicSignal) || 0, 1);
  const hasEngagement = uniquePosts.some(post =>
    Math.max(0, Number(post.views) || 0) > 0 && postInteractionCount(post) > 0
  );
  const publicPerformance = hasEngagement
    ? clampScore(Math.log1p(totalPublicSignal) / Math.log1p(maxPublicSignal) * 100)
    : 0;
  const growthStrength = uniquePosts.reduce((best, post) => {
    const levelFloor = ({ "爆发": 100, "升温": 75, "普通": 35, "冷却": 15 })[post.analysis?.level] || 0;
    return Math.max(best, Number(post.analysis?.score || 0), levelFloor);
  }, 0);
  const relevantCoverage = clampScore(uniquePosts.length / 3 * 100);
  const latest = Math.max(...uniquePosts.map(post => safeTime(post.publishedAt || post.capturedAt)), 0);
  const ageHours = latest ? Math.max(0, (now - latest) / 3_600_000) : windowHours;
  const freshness = clampScore((1 - ageHours / windowHours) * 100);
  const scoreBreakdown = {
    publicPerformance: Math.round(publicPerformance),
    growthStrength: Math.round(growthStrength),
    relevantCoverage: Math.round(relevantCoverage),
    freshness: Math.round(freshness)
  };
  const score = hasEngagement
    ? Math.round(
      scoreBreakdown.publicPerformance * .4 +
      scoreBreakdown.growthStrength * .3 +
      scoreBreakdown.relevantCoverage * .2 +
      scoreBreakdown.freshness * .1
    )
    : 0;
  return {
    score,
    scoreBreakdown,
    hasEngagement,
    postCount: uniquePosts.length,
    totalPublicSignal
  };
}

export function ambientHotPostsForGraph(graph = {}, posts = [], limit = MAX_AMBIENT_HOT_POSTS) {
  const clusters = Array.isArray(graph.clusters) ? graph.clusters : [];
  const establishedPostIds = new Set([
    ...(Array.isArray(graph.nodes) ? graph.nodes : []).flatMap(node => node.sourcePostIds || []),
    ...clusters.flatMap(cluster => [
      cluster.motherPostId,
      ...(cluster.memberPostIds || []),
      ...(cluster.sourcePostIds || [])
    ])
  ].filter(Boolean).map(String));
  const candidateSignalByPostId = new Map();
  (Array.isArray(graph.candidateDirections) ? graph.candidateDirections : []).forEach(candidate => {
    const evidenceText = [
      candidate.normalizedText,
      candidate.subject,
      candidate.category,
      candidate.currentState,
      candidate.previousState
    ].filter(Boolean).join(" ");
    (candidate.sourcePostIds || []).forEach(id => {
      const key = String(id);
      candidateSignalByPostId.set(key, `${candidateSignalByPostId.get(key) || ""} ${evidenceText}`);
    });
  });
  return uniqueById(posts)
    .filter(post => {
      const postId = String(post.id);
      if (establishedPostIds.has(postId)) return false;
      const aiEvidence = `${candidateSignalByPostId.get(postId) || ""} ${post.text || ""}`;
      if (!AI_SIGNAL_PATTERN.test(aiEvidence)) return false;
      return Number(post.views || 0) > 0 && postInteractionCount(post) > 0;
    })
    .sort((a, b) =>
      Number(b.analysis?.score || 0) - Number(a.analysis?.score || 0) ||
      postPublicSignal(b) - postPublicSignal(a) ||
      safeTime(b.publishedAt || b.capturedAt) - safeTime(a.publishedAt || a.capturedAt)
    )
    .slice(0, Math.max(0, Number(limit) || 0));
}

function ambientHotSnapshot(graph, posts) {
  const current = ambientHotPostsForGraph(graph, posts);
  const calculatedAt = safeTime(graph.calculatedAt) || Date.now();
  const bucket = Math.floor(calculatedAt / AMBIENT_HOT_REFRESH_MS);
  const key = String(graph.window || "24h");
  const previous = ambientHotSnapshots.get(key);
  const byId = new Map(current.map(post => [String(post.id), post]));
  if (previous?.bucket === bucket) {
    const stable = previous.ids.map(id => byId.get(id)).filter(Boolean);
    const stableIds = new Set(stable.map(post => String(post.id)));
    const next = [...stable, ...current.filter(post => !stableIds.has(String(post.id)))]
      .slice(0, MAX_AMBIENT_HOT_POSTS);
    previous.ids = next.map(post => String(post.id));
    return next;
  }
  ambientHotSnapshots.set(key, {
    bucket,
    updatedAt: new Date(bucket * AMBIENT_HOT_REFRESH_MS).toISOString(),
    ids: current.map(post => String(post.id))
  });
  return current;
}

export function deriveCreatorView(view, selected, options) {
  const posts = Array.isArray(options.posts) ? options.posts : [];
  const graph = options.graph || {};
  const clusters = Array.isArray(graph.clusters) ? graph.clusters : [];
  const postsById = new Map(posts.map(post => [String(post.id), post]));
  const followedSet = new Set((options.followedCreators || []).map(item => cleanHandle(item.handle)));
  const creatorNodes = [];
  const clusterByNodeId = new Map();
  const visibleTopicIds = new Set(view.visibleTopics.map(topic => topic.id));
  const visibleClusters = clusters.filter(cluster =>
    visibleTopicIds.has(cluster.topicId) &&
    cluster.changeId &&
    view.visibleNodeIds.has(cluster.changeId)
  );
  const selectedCreatorCluster = options.selectedCreatorId
    ? visibleClusters.find(cluster =>
      cluster.motherNodeId === options.selectedCreatorId ||
      String(options.selectedCreatorId).startsWith(`discussion-${cluster.id}-`)
    )
    : null;
  const expandedTopicId = selected?.nodeType === "topic" ? selected.id : selected?.parentTopicId;
  const expandedChangeId = selected?.nodeType === "change" ? selected.id : null;
  const displayClusters = visibleClusters;
  const nodeTierById = new Map();

  for (const cluster of displayClusters) {
    const mother = postsById.get(String(cluster.motherPostId));
    if (!mother) continue;
    const isExpanded = cluster === selectedCreatorCluster ||
      (expandedChangeId && cluster.changeId === expandedChangeId);
    const explicitIds = new Set(cluster.explicitDerivativePostIds || []);
    const inferredIds = new Set(cluster.inferredDerivativePostIds || []);
    const followedIds = new Set(cluster.followedPostIds || []);
    const clusterPosts = uniqueById([
      mother,
      ...(cluster.memberPostIds || []).map(id => postsById.get(String(id))).filter(Boolean)
    ]);
    const groups = new Map();
    clusterPosts.forEach(post => {
      const handleKey = cleanHandle(post.handle || post.author);
      if (!handleKey) return;
      const group = groups.get(handleKey) || {
        handleKey,
        handle: post.handle || post.author || handleKey,
        displayName: post.author || post.handle || handleKey,
        posts: [],
        isSource: false,
        followed: followedSet.has(handleKey),
        explicit: false,
        inferred: false
      };
      group.posts.push(post);
      group.isSource ||= String(post.id) === String(cluster.motherPostId);
      group.followed ||= followedIds.has(post.id);
      group.explicit ||= explicitIds.has(post.id);
      group.inferred ||= inferredIds.has(post.id);
      groups.set(handleKey, group);
    });
    const maxPublicSignal = Math.max(...[...groups.values()].map(group =>
      group.posts.reduce((sum, post) => sum + postPublicSignal(post), 0)
    ), 1);
    const rankedNodes = [...groups.values()].map(group => {
      const sortedPosts = [...group.posts].sort((a, b) =>
        Number(b.analysis?.score || 0) - Number(a.analysis?.score || 0) ||
        safeTime(b.publishedAt || b.capturedAt) - safeTime(a.publishedAt || a.capturedAt)
      );
      const representativePost = group.isSource
        ? group.posts.find(post => String(post.id) === String(cluster.motherPostId)) || sortedPosts[0]
        : sortedPosts.find(isChinesePost) || sortedPosts[0];
      const directionHeat = creatorDirectionHeat(group.posts, {
        window: graph.window,
        now: graph.calculatedAt,
        maxPublicSignal
      });
      const isSource = group.isSource;
      const followed = group.followed;
      const explicit = group.explicit;
      const inferred = group.inferred;
      const highValue = !isSource && !followed && directionHeat.score >= 60;
      const role = isSource
        ? cluster.motherStatus === "confirmed"
          ? "已验证发起人"
          : cluster.motherStatus === "candidate"
            ? "最早观察"
            : "直接证据帖"
        : followed
          ? `已关注加工${cluster.windowFallback ? " · 7D回看" : ""}`
          : explicit
            ? "明确加工"
            : inferred
              ? "疑似加工"
              : highValue
                ? "高热讨论"
                : "相关讨论";
      const id = isSource ? cluster.motherNodeId : `discussion-${cluster.id}-${hash(group.handleKey).toString(36)}`;
      const isChinese = isChinesePost(representativePost);
      const node = {
        id,
        nodeType: "creator",
        clusterId: cluster.id,
        topicId: cluster.topicId,
        changeId: cluster.changeId,
        relatedNodeId: cluster.changeId,
        parentNodeId: isSource ? cluster.changeId : cluster.motherNodeId,
        normalizedText: group.displayName,
        displayName: group.displayName,
        handle: group.handle,
        role,
        language: isChinese ? "zh" : "en",
        isSource,
        sourceConfirmed: cluster.motherStatus === "confirmed",
        followed,
        explicit,
        inferred,
        highValue,
        sourcePostIds: group.posts.map(post => post.id),
        representativePostId: representativePost.id,
        representativeText: representativePost.text || "",
        publishedAt: representativePost.publishedAt || representativePost.capturedAt || null,
        globalScore: Number(representativePost.analysis?.score || 0),
        chineseScore: isChinese ? Number(representativePost.analysis?.score || 0) : 0,
        status: representativePost.analysis?.level === "爆发" ? "burst" : "observing",
        creatorDirectionScore: directionHeat.score,
        creatorDirectionScoreBreakdown: directionHeat.scoreBreakdown,
        hasRankableEngagement: directionHeat.hasEngagement,
        hasAcceleratingPost: group.posts.some(post => ["升温", "爆发"].includes(post.analysis?.level)),
        acceleratingPostCount: group.posts.filter(post => ["升温", "爆发"].includes(post.analysis?.level)).length,
        postCount: directionHeat.postCount,
        englishHotSignal: !isChinese &&
          directionHeat.hasEngagement &&
          group.posts.some(post =>
            Number(post.analysis?.score || 0) >= 70 &&
            ["升温", "爆发"].includes(post.analysis?.level)
          )
      };
      node.topicAffinities = computeTopicAffinities(node, view.visibleTopics);
      return node;
    }).sort((a, b) =>
      Number(b.isSource) - Number(a.isSource) ||
      Number(b.followed) - Number(a.followed) ||
      b.creatorDirectionScore - a.creatorDirectionScore ||
      safeTime(a.publishedAt) - safeTime(b.publishedAt)
    );

    const chineseNodes = rankedNodes.filter(node => node.language === "zh" && node.hasRankableEngagement);
    const englishSignal = rankedNodes
      .filter(node => node.englishHotSignal)
      .sort((a, b) =>
        b.creatorDirectionScore - a.creatorDirectionScore ||
        b.globalScore - a.globalScore
      )[0];
    const defaultNodes = uniqueById([
      ...rankedNodes.filter(node => node.isSource),
      ...rankedNodes.filter(node => node.followed && node.hasRankableEngagement),
      ...chineseNodes,
      ...(englishSignal ? [englishSignal] : []),
      ...rankedNodes.filter(node => node.hasRankableEngagement)
    ]).slice(0, 8);
    const defaultIds = new Set(defaultNodes.map(node => node.id));
    const expansionOrder = uniqueById([
      ...defaultNodes,
      ...chineseNodes,
      ...(englishSignal ? [englishSignal] : []),
      ...rankedNodes
    ]);
    const expandedIds = new Set(expansionOrder.slice(0, 12).map(node => node.id));

    rankedNodes.forEach(node => {
      const tier = isExpanded && expandedIds.has(node.id)
        ? "default"
        : defaultIds.has(node.id)
          ? "default"
          : expandedIds.has(node.id)
            ? "near"
            : "detail";
      node.creatorTier = tier;
      node.nearEligible = tier !== "detail";
      node.labeled = tier === "default";
      creatorNodes.push(node);
      nodeTierById.set(node.id, tier);
      clusterByNodeId.set(node.id, cluster);
    });
  }

  // Posts with real public engagement but insufficient multi-author evidence
  // remain in a two-hour ranked snapshot around the outside of the formal map.
  // Once recomputation assigns them to a topic, they leave this band at once.
  const ambientHotPosts = ambientHotSnapshot(graph, posts);

  ambientHotPosts.forEach((post, index) => {
    const handleKey = cleanHandle(post.handle || post.author);
    if (!handleKey) return;
    const isChinese = isChinesePost(post);
    const heat = creatorDirectionHeat([post], {
      window: graph.window,
      now: graph.calculatedAt,
      maxPublicSignal: Math.max(...ambientHotPosts.map(postPublicSignal), 1)
    });
    const node = {
      id: `ambient-hot-${String(post.id)}`,
      nodeType: "creator",
      clusterId: "",
      topicId: "",
      changeId: "",
      relatedNodeId: "",
      parentNodeId: "",
      normalizedText: String(post.author || post.handle || handleKey),
      displayName: String(post.author || post.handle || handleKey),
      handle: String(post.handle || `@${handleKey}`),
      role: "待成势热帖",
      language: isChinese ? "zh" : "en",
      isSource: false,
      followed: followedSet.has(handleKey),
      explicit: false,
      inferred: false,
      highValue: true,
      ambientHotPost: true,
      ambientRank: index + 1,
      sourcePostIds: [post.id],
      representativePostId: post.id,
      representativeText: post.text || "",
      publishedAt: post.publishedAt || post.capturedAt || null,
      globalScore: Number(post.analysis?.score || 0),
      chineseScore: isChinese ? Number(post.analysis?.score || 0) : 0,
      status: post.analysis?.level === "爆发" ? "burst" : "active",
      creatorDirectionScore: heat.score,
      creatorDirectionScoreBreakdown: heat.scoreBreakdown,
      hasRankableEngagement: true,
      hasAcceleratingPost: index < 20 && ["升温", "爆发"].includes(post.analysis?.level),
      acceleratingPostCount: 1,
      postCount: 1,
      creatorTier: "default",
      nearEligible: true,
      labeled: index < 24
    };
    node.topicAffinities = computeTopicAffinities(node, view.visibleTopics);
    creatorNodes.push(node);
    nodeTierById.set(node.id, "default");
  });

  return {
    nodes: creatorNodes,
    postNodes: [],
    edges: [],
    clusters: displayClusters,
    clusterByNodeId,
    nodeTierById
  };
}

export function graphRelationDistance(edge = {}) {
  const strength = Math.max(0, Math.min(100, Number(edge.strength || 0))) / 100;
  const ranges = {
    contains: [54, 82],
    cluster_source: [30, 44],
    creator_source: [34, 48],
    creator_explicit: [38, 58],
    creator_post: [18, 26],
    creator_inferred: [52, 84],
    shared_chinese_audience: [330, 480],
    shared_global_audience: [370, 540]
  };
  const [near, far] = ranges[edge.relationType] || [360, 540];
  return far - (far - near) * strength;
}

export function graphRelationSemantics(edge = {}) {
  if (edge.relationType === "contains") {
    return { distanceBand: "series", directional: true, causal: false, label: "同一话题系列" };
  }
  if (edge.relationType === "cluster_source") {
    return { distanceBand: "provenance", directional: true, causal: false, label: "讨论簇母帖" };
  }
  if (["creator_source", "creator_explicit", "creator_post"].includes(edge.relationType)) {
    return {
      distanceBand: "provenance",
      directional: true,
      causal: edge.relationType !== "creator_post",
      label: edge.relationType === "creator_source"
        ? "最早来源"
        : edge.relationType === "creator_explicit"
          ? "明确引用或承接"
          : "代表帖子"
    };
  }
  if (edge.relationType === "creator_inferred") {
    return { distanceBand: "inferred", directional: false, causal: false, label: "疑似加工" };
  }
  return {
    distanceBand: "correlation",
    directional: false,
    causal: false,
    label: edge.relationType === "shared_chinese_audience" ? "中文共同讨论" : "全球共同讨论"
  };
}

export function radialDirectionPoint(parent, index, count, topicId, orbit = 62) {
  const total = Math.max(1, Number(count) || 1);
  const stableOffset = ((hash(topicId) % 360) / 180) * Math.PI;
  const angle = stableOffset + Number(index || 0) / total * Math.PI * 2;
  return {
    x: parent.x + Math.cos(angle) * orbit,
    y: parent.y + Math.sin(angle) * orbit,
    angle
  };
}

export function discussionOrbitPoint(center, index, count, clusterId, orbit = 74) {
  const total = Math.max(1, Number(count) || 1);
  const stableOffset = ((hash(clusterId) % 360) / 180) * Math.PI;
  const angle = stableOffset + Number(index || 0) / total * Math.PI * 2;
  return {
    x: center.x + Math.cos(angle) * orbit,
    y: center.y + Math.sin(angle) * orbit,
    angle
  };
}

export function discussionOrbitDistance(count, node = {}) {
  const total = Math.max(1, Number(count) || 1);
  const compactBase = total <= 2 ? 32
    : total <= 4 ? 38
      : total <= 6 ? 45
        : 52;
  if (node.followed) return compactBase - 2;
  if (node.explicit) return compactBase;
  if (node.inferred) return compactBase + 3;
  return compactBase + 2;
}

export function ambientHotPostPoint(index, count, id, center = { x: WIDTH / 2, y: HEIGHT / 2 }) {
  const total = Math.max(1, Number(count) || 1);
  const ring = total > 50 ? Number(index || 0) % 2 : 0;
  const ringCount = total > 50
    ? ring === 0 ? Math.ceil(total / 2) : Math.floor(total / 2)
    : total;
  const ringIndex = total > 50 ? Math.floor(Number(index || 0) / 2) : Number(index || 0);
  const stableOffset = ((hash(`ambient-ring:${total}:${ring}`) % 120) / 180) * Math.PI;
  const step = Math.PI * 2 / Math.max(1, ringCount);
  const angleJitter = ((hash(`ambient-angle:${id}`) % 2001) - 1000) / 1000;
  const radialJitter = ((hash(`ambient-radius:${id}`) % 2001) - 1000) / 1000;
  const verticalJitter = ((hash(`ambient-y:${id}`) % 2001) - 1000) / 1000;
  const angle = stableOffset + ringIndex * step + angleJitter * step * .34;
  const radiusX = ring ? 815 : 735;
  const radiusY = ring ? 460 : 414;
  const radiusScale = 1 + radialJitter * (ring ? .105 : .085);
  const yScale = 1 + verticalJitter * .07;
  return {
    x: center.x + Math.cos(angle) * radiusX * radiusScale,
    y: center.y + Math.sin(angle) * radiusY * radiusScale * yScale,
    angle
  };
}

export function ambientHotViewportPoint(
  index,
  count,
  id,
  frame = { width: WIDTH, height: HEIGHT },
  minimumZoom = MIN_ZOOM
) {
  const total = Math.max(1, Number(count) || 1);
  const center = { x: frame.width / 2, y: frame.height / 2 };
  const padding = Math.max(9, Math.min(18, Math.min(frame.width, frame.height) * .018));
  const halfWidth = Math.max(1, center.x - padding);
  const halfHeight = Math.max(1, center.y - padding);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const stableOffset = ((hash(`ambient-viewport:${total}`) % 360) / 180) * Math.PI;
  const angleJitter = ((hash(`ambient-viewport-angle:${id}`) % 2001) - 1000) / 1000 * .075;
  const depthNoise = (hash(`ambient-viewport-depth:${id}`) % 1001) / 1000;
  const angle = stableOffset + Number(index || 0) * goldenAngle + angleJitter;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const edgeDistance = Math.min(
    halfWidth / Math.max(.001, Math.abs(cosine)),
    halfHeight / Math.max(.001, Math.abs(sine))
  );
  const bandDepth = .72 + depthNoise * .27;
  let targetX = center.x + cosine * edgeDistance * bandDepth;
  let targetY = center.y + sine * edgeDistance * bandDepth;
  // Four inconspicuous edge anchors guarantee that every resized viewport is
  // visibly occupied on all sides; the remaining points keep the irregular
  // golden-angle star distribution.
  if (Number(index || 0) < 4) {
    const sideOffset = ((hash(`ambient-side:${id}`) % 2001) - 1000) / 1000;
    if (index === 0) {
      targetX = padding;
      targetY = center.y + sideOffset * halfHeight * .72;
    } else if (index === 1) {
      targetX = frame.width - padding;
      targetY = center.y + sideOffset * halfHeight * .72;
    } else if (index === 2) {
      targetX = center.x + sideOffset * halfWidth * .72;
      targetY = padding;
    } else {
      targetX = center.x + sideOffset * halfWidth * .72;
      targetY = frame.height - padding;
    }
  }
  const zoom = Math.max(.01, Number(minimumZoom) || 1);
  return {
    x: center.x + (targetX - center.x) / zoom,
    y: center.y + (targetY - center.y) / zoom,
    angle,
    bandDepth
  };
}

export function graphNodeCollisionRadius(node) {
  const core = graphNodeRadius(node);
  if (node?.hasAcceleratingPost) return core + 9.5;
  if (node?.isSource) return core + 5.5;
  if (node?.nodeType === "change" || node?.focusNode) return core + 4.5;
  return core + 3.5;
}

export function createLayout(view, creatorView) {
  const positions = new Map();
  const root = view.visibleNodes.find(node => node.id === view.rootNodeId);
  if (!root) return positions;
  const setSeed = (id, x, y, z = 0) => {
    positions.set(id, { x, y, z });
  };
  const rootPoint = { x: WIDTH / 2, y: HEIGHT / 2 };
  const topicLayout = compactTopicLayout(view.visibleTopics);
  view.visibleTopics.forEach(node => {
    const point = topicLayout.get(node.id);
    setSeed(node.id, point.x, point.y, 0);
  });

  const featuredIds = new Set(view.featuredChanges.map(node => node.id));
  view.visibleTopics.forEach(topic => {
    const siblings = view.visibleChanges.filter(change => change.parentTopicId === topic.id);
    siblings.forEach((node, index) => {
      if (positions.has(node.id)) return;
      const parent = positions.get(topic.id);
      if (!parent) return;
      const featured = featuredIds.has(node.id);
      const radial = radialDirectionPoint(parent, index, siblings.length, topic.id);
      setSeed(node.id, radial.x, radial.y, featured ? 24 : -18);
    });
  });

  creatorView.clusters.forEach((cluster, clusterIndex) => {
    const parentId = cluster.changeId;
    const parentPoint = positions.get(parentId);
    const source = creatorView.nodes.find(node => node.clusterId === cluster.id && node.isSource);
    if (!parentPoint || !source) return;
    const processors = creatorView.nodes.filter(node => node.clusterId === cluster.id && !node.isSource);
    const members = [source, ...processors];
    const orbit = discussionOrbitDistance(members.length);
    const sourcePoint = discussionOrbitPoint(parentPoint, 0, members.length, cluster.id, orbit);
    setSeed(source.id, sourcePoint.x, sourcePoint.y, 40 - clusterIndex);
    processors.forEach((node, index) => {
      const orbitPoint = discussionOrbitPoint(
        parentPoint,
        index + 1,
        members.length,
        cluster.id,
        orbit
      );
      setSeed(
        node.id,
        orbitPoint.x,
        orbitPoint.y,
        18 - index
      );
    });
  });
  const ambientHotNodes = creatorView.nodes.filter(node => node.ambientHotPost);
  ambientHotNodes.forEach((node, index) => {
    const point = ambientHotPostPoint(index, ambientHotNodes.length, node.id, rootPoint);
    setSeed(node.id, point.x, point.y, -26 - index);
  });
  const layoutNodes = [...view.visibleNodes, ...creatorView.nodes];
  const nodeById = new Map(layoutNodes.map(node => [node.id, node]));
  const anchorPositions = new Map([...positions].map(([id, point]) => [id, { ...point }]));
  for (let iteration = 0; iteration < 84; iteration += 1) {
    const movement = new Map([...positions.keys()].map(id => [id, { x: 0, y: 0 }]));
    const ids = [...positions.keys()];
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const aId = ids[i];
        const bId = ids[j];
        const a = positions.get(aId);
        const b = positions.get(bId);
        const aNode = nodeById.get(aId);
        const bNode = nodeById.get(bId);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < .01) {
          const angle = hash(`${aId}:${bId}`) / 0xffffffff * Math.PI * 2;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const aTopic = aNode?.nodeType === "topic";
        const bTopic = bNode?.nodeType === "topic";
        const aChange = aNode?.nodeType === "change" || aNode?.focusNode;
        const bChange = bNode?.nodeType === "change" || bNode?.focusNode;
        const ambientAgainstTopic = (aTopic && bNode?.ambientHotPost) ||
          (bTopic && aNode?.ambientHotPost);
        const aAmbient = Boolean(aNode?.ambientHotPost);
        const bAmbient = Boolean(bNode?.ambientHotPost);
        const ambientAgainstFormal = aAmbient !== bAmbient;
        const sameTopicCluster = (aTopic && bNode?.topicId === aId) ||
          (bTopic && aNode?.topicId === bId);
        const sameChangeCluster = (aChange && bNode?.changeId === aId) ||
          (bChange && aNode?.changeId === bId);
        const rippleSafeDistance = graphNodeCollisionRadius(aNode) +
          graphNodeCollisionRadius(bNode) + 4;
        const desired = ambientAgainstTopic ? 178
          : ambientAgainstFormal ? 104
          : sameChangeCluster ? Math.max(20, rippleSafeDistance)
            : sameTopicCluster ? Math.max(30, rippleSafeDistance)
              : aTopic || bTopic ? Math.max(110, rippleSafeDistance)
                : aChange || bChange ? Math.max(46, rippleSafeDistance)
              : Math.max(24, rippleSafeDistance);
        if (distance >= desired) continue;
        const force = (desired - distance) * .075 * (1 - iteration / 110);
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        movement.get(aId).x -= fx;
        movement.get(aId).y -= fy;
        movement.get(bId).x += fx;
        movement.get(bId).y += fy;
      }
    }
    ids.forEach(id => {
      if (id === root.id) return;
      const point = positions.get(id);
      const delta = movement.get(id);
      const node = nodeById.get(id);
      const anchor = anchorPositions.get(id);
      if (node?.nodeType === "creator" && anchor) {
        const pull = node.ambientHotPost ? .045 : .18;
        delta.x += (anchor.x - point.x) * pull;
        delta.y += (anchor.y - point.y) * pull;
      }
      const xMin = node?.ambientHotPost ? -250 : 28;
      const xMax = node?.ambientHotPost ? WIDTH + 250 : WIDTH - 28;
      const yMin = node?.ambientHotPost ? -155 : 28;
      const yMax = node?.ambientHotPost ? HEIGHT + 155 : HEIGHT - 28;
      point.x = Math.max(xMin, Math.min(xMax, point.x + delta.x));
      point.y = Math.max(yMin, Math.min(yMax, point.y + delta.y));
    });
  }
  // Collision resolution may displace sparse discussion clusters enough to
  // obscure ownership. Lock every real discussion member back onto one shared
  // circle after the global layout: 1 = stable arbitrary point, 2 = opposite
  // points, N = exact 360° / N spacing.
  creatorView.clusters.forEach((cluster, clusterIndex) => {
    const parentPoint = positions.get(cluster.changeId);
    const source = creatorView.nodes.find(node => node.clusterId === cluster.id && node.isSource);
    if (!parentPoint || !source) return;
    const processors = creatorView.nodes.filter(node => node.clusterId === cluster.id && !node.isSource);
    const members = [source, ...processors];
    const orbit = discussionOrbitDistance(members.length);
    members.forEach((node, index) => {
      const point = discussionOrbitPoint(parentPoint, index, members.length, cluster.id, orbit);
      const current = positions.get(node.id);
      if (!current) return;
      current.x = point.x;
      current.y = point.y;
      current.z = parentPoint.z || 0;
    });
  });
  return positions;
}

function projectPoint(point) {
  const x = point.x - WIDTH / 2;
  const y = point.y - HEIGHT / 2;
  const depth = point.z || 0;
  const perspective = 760 / Math.max(540, 760 - depth * .28);
  return {
    x: WIDTH / 2 + x * perspective,
    y: HEIGHT / 2 + y * perspective,
    depth,
    scale: Math.max(.68, Math.min(1.3, perspective)),
    opacity: Math.max(.52, Math.min(1, .8 + depth / 820))
  };
}

export function compactTopicLayout(topics) {
  const center = { x: WIDTH / 2, y: HEIGHT / 2 };
  const points = new Map();
  const ranked = [...topics].sort((a, b) =>
    Number(b.globalScore || 0) - Number(a.globalScore || 0) ||
    Number(b.creatorCount || 0) - Number(a.creatorCount || 0) ||
    String(a.id).localeCompare(String(b.id))
  );
  const radialTargets = new Map();
  ranked.forEach((topic, index) => {
    if (index === 0) {
      radialTargets.set(topic.id, 0);
      points.set(topic.id, { ...center });
      return;
    }
    const percentile = (index - 1) / Math.max(1, ranked.length - 2);
    const score = Math.max(0, Math.min(100, Number(topic.globalScore || 0)));
    const radius = 220 + Math.sqrt(percentile) * 225 + (100 - score) * .3;
    const angle = index * 2.399963;
    radialTargets.set(topic.id, radius);
    points.set(topic.id, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius * .56
    });
  });
  for (let iteration = 0; iteration < 140; iteration += 1) {
    const movement = new Map(ranked.map(topic => [topic.id, { x: 0, y: 0 }]));
    for (let i = 0; i < ranked.length; i += 1) {
      for (let j = i + 1; j < ranked.length; j += 1) {
        const a = ranked[i];
        const b = ranked[j];
        const pa = points.get(a.id);
        const pb = points.get(b.id);
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let distance = Math.hypot(dx, dy);
        if (distance < .01) {
          const angle = ((hash(`${a.id}:${b.id}`) % 360) / 180) * Math.PI;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const labelSpan = Math.min(58, (String(a.normalizedText || "").length + String(b.normalizedText || "").length) * 2.2);
        const desired = 216 + labelSpan;
        const force = distance < desired ? -(desired - distance) * .09 : 0;
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        movement.get(a.id).x += fx;
        movement.get(a.id).y += fy;
        movement.get(b.id).x -= fx;
        movement.get(b.id).y -= fy;
      }
    }
    const cooling = 1 - iteration / 190;
    ranked.forEach((topic, index) => {
      const point = points.get(topic.id);
      if (index === 0) {
        point.x = center.x;
        point.y = center.y;
        return;
      }
      const delta = movement.get(topic.id);
      const dx = point.x - center.x;
      const dy = (point.y - center.y) / .56;
      const currentRadius = Math.max(1, Math.hypot(dx, dy));
      const targetRadius = radialTargets.get(topic.id);
      const radialDelta = (targetRadius - currentRadius) * .032;
      delta.x += dx / currentRadius * radialDelta;
      delta.y += dy / currentRadius * radialDelta * .56;
      point.x = Math.max(center.x - 500, Math.min(center.x + 500, point.x + delta.x * cooling));
      point.y = Math.max(center.y - 290, Math.min(center.y + 290, point.y + delta.y * cooling));
    });
  }
  return points;
}

function affinityAnchor(node, topicPositions, fallbackId) {
  const affinities = (node?.topicAffinities || [])
    .filter(item => item.score >= .18 && topicPositions.has(item.topicId));
  if (!affinities.length) return topicPositions.get(fallbackId) || { x: WIDTH / 2, y: HEIGHT / 2 };
  let weightTotal = 0;
  let x = 0;
  let y = 0;
  affinities.forEach(item => {
    const weight = Math.pow(item.score, 1.7);
    const point = topicPositions.get(item.topicId);
    weightTotal += weight;
    x += point.x * weight;
    y += point.y * weight;
  });
  return { x: x / weightTotal, y: y / weightTotal };
}

function nodeMarkup(node, point, context) {
  const selected = node.id === context.selectedId;
  const related = context.hasSelection && !selected && context.relatedIds.has(node.id);
  const dimmed = context.hasSelection && !selected && !related;
  const isTopic = node.nodeType === "topic";
  const isChange = node.nodeType === "change";
  const isCreator = node.nodeType === "creator";
  const isPost = node.nodeType === "post";
  const r = graphNodeRadius(node);
  const textOffsets = graphNodeTextOffsets(node);
  const typography = graphNodeTypography(node);
  const rawLabel = node.normalizedText || node.displayName || node.handle;
  const maxLength = node.focusNode ? 20 : isTopic ? 12 : isChange ? 14 : isPost ? 28 : 14;
  const label = rawLabel.length > maxLength ? `${rawLabel.slice(0, maxLength - 1)}…` : rawLabel;
  const displayLabel = label;
  const labeled = !isPost && (context.labelIds.has(node.id) || (node.labeled && !context.mobile));
  const driftX = (hash(node.id) % 5) - 2;
  const driftY = (hash(`${node.id}-y`) % 5) - 2;
  const duration = 4.2 + (hash(`${node.id}-duration`) % 28) / 10;
  const delay = -((hash(`${node.id}-delay`) % 50) / 10);
  const classes = [
    "graph-node", `node-${node.nodeType}`, `status-${node.status || "observing"}`,
    node.chineseStatus ? `cn-${node.chineseStatus}` : "",
    node.id === context.rootNodeId ? "root" : "",
    isTopic && node.id !== context.rootNodeId ? "ambient-topic" : "",
    isChange && context.featuredIds.has(node.id) ? "branch-detail" : "",
    labeled ? "labeled" : "",
    selected ? "selected" : "",
    related ? "related" : "",
    dimmed ? "dimmed" : "",
    isCreator && node.isSource ? "creator-source" : "",
    isCreator && node.sourceConfirmed ? "creator-source-confirmed" : "",
    node.focusNode ? "discussion-focus" : "",
    isCreator && node.language ? `creator-language-${node.language}` : "",
    isCreator && node.isSource ? "cluster-mother" : "",
    isCreator && !node.isSource ? "cluster-processor" : "",
    isCreator && node.isSource && node.language === "en" ? "creator-overseas" : "",
    isCreator && node.earlyChinese ? "creator-early-chinese" : "",
    isCreator && node.nearEligible ? "creator-near" : "",
    isCreator && node.followed ? "creator-followed" : "",
    isCreator && node.highValue ? "creator-high" : "",
    isCreator && node.explicit ? "creator-explicit" : "",
    isCreator && node.inferred ? "creator-inferred" : "",
    isCreator && node.creatorTier ? `creator-tier-${node.creatorTier}` : "",
    isCreator && node.hasAcceleratingPost ? "creator-accelerating" : "",
    isCreator && node.ambientHotPost ? "creator-ambient-hot" : "",
    isPost && node.followed ? "post-followed" : "",
    isPost && node.isSource ? "post-source" : ""
  ].filter(Boolean).join(" ");
  const aria = isCreator
    ? `博主，${node.displayName}，${node.role}${node.hasAcceleratingPost ? "，存在正在升温的内容" : ""}`
    : isPost
      ? `帖子，${node.displayName}，${compactAge(node.publishedAt)}，${rawLabel}`
    : `${node.focusNode ? "讨论焦点" : isTopic ? "话题" : "变化"}，${rawLabel}，全球热度 ${node.globalScore}，中文热度 ${node.chineseScore}，${chineseStatusLabel(node.chineseStatus)}`;
  const dataAttribute = isCreator && node.ambientHotPost
    ? `data-graph-post="${esc(node.representativePostId || "")}"`
    : isCreator
    ? `data-graph-creator="${esc(node.handle)}" data-context-node="${esc(node.relatedNodeId)}" data-creator-role="${esc(node.role)}" data-discussion-node="${esc(node.id)}" data-representative-post="${esc(node.representativePostId || "")}" data-creator-score="${esc(node.creatorDirectionScore)}" data-creator-breakdown="${esc(JSON.stringify(node.creatorDirectionScoreBreakdown || {}))}" data-cluster-id="${esc(node.clusterId)}" data-topic-id="${esc(node.topicId)}" data-change-id="${esc(node.changeId || "")}"`
    : isPost
      ? `data-graph-post="${esc(node.postId)}"`
      : `data-graph-node="${esc(node.id)}" data-topic-id="${esc(isTopic ? node.id : node.parentTopicId || "")}" data-change-id="${esc(isChange ? node.id : "")}"`;
  const affinityAttribute = !isTopic
    ? `data-topic-affinities="${esc((node.topicAffinities || [])
      .filter(item => item.score >= .18)
      .map(item => `${item.topicId}:${item.score.toFixed(2)}`)
      .join(","))}"`
    : "";
  const hitWidth = Math.max(18, r * 2 + 12);
  const hitHeight = hitWidth;
  const hitY = -hitHeight / 2;
  const parentText = isCreator
    ? node.role
    : isPost
      ? `${node.displayName} · ${compactAge(node.publishedAt)}`
      : isChange
        ? node.directionOnly ? "讨论方向" : "具体变化"
        : "详情";
  const summary = isCreator && node.representativeText
    ? String(node.representativeText).replace(/\s+/g, " ").trim()
    : isChange
      ? String(node.currentState || node.summary || "").replace(/\s+/g, " ").trim()
      : "";
  const summaryLabel = summary.length > 24 ? `${summary.slice(0, 23)}…` : summary;
  return `<g class="node-position" transform="translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) scale(${point.scale.toFixed(3)})">
    <g class="node-arrival ${context.settling ? "settling" : ""}" style="--arrival-x:${((WIDTH / 2 - point.x) * .06).toFixed(1)}px;--arrival-y:${((HEIGHT / 2 - point.y) * .06).toFixed(1)}px;--arrival-delay:${(context.order * 18).toFixed(0)}ms">
      <g class="${classes}" ${dataAttribute} ${affinityAttribute} data-node-id="${esc(node.id)}" style="--depth-opacity:${point.opacity.toFixed(3)};--node-label-size:${typography.label}px;--node-parent-size:${typography.parent}px;--node-summary-size:${typography.summary}px;--drift-x:${driftX}px;--drift-y:${driftY}px;--drift-duration:${duration.toFixed(1)}s;--drift-delay:${delay.toFixed(1)}s" tabindex="0" role="button" aria-label="${esc(aria)}">
        <title>${esc(aria)}</title>
        <rect class="node-hit" x="${(-hitWidth / 2).toFixed(1)}" y="${hitY.toFixed(1)}" width="${hitWidth}" height="${hitHeight.toFixed(1)}" rx="${isCreator ? 17 : 8}"></rect>
        <g class="node-breath" style="--breath-duration:${(3.6 + (hash(node.id) % 26) / 10).toFixed(1)}s;--breath-delay:${delay.toFixed(1)}s">
          <circle class="node-core" r="${r}"></circle>
          ${directionHeatArcs(node)}
          ${nodeIdentityMark(node, r)}
        </g>
        ${isCreator && (node.isSource || node.englishHotSignal) ? `<text class="node-language" x="${(r + 3.4).toFixed(1)}" y="${-(r + .8).toFixed(1)}">${node.language === "en" ? "EN" : "中"}</text>` : ""}
        ${!isTopic ? `<text class="node-parent" y="${textOffsets.parentY.toFixed(1)}">${esc(parentText)}</text>` : ""}
        <text class="node-label" y="${textOffsets.labelY.toFixed(1)}">${esc(displayLabel)}</text>
        ${summaryLabel ? `<text class="node-summary" y="${textOffsets.summaryY.toFixed(1)}">${esc(summaryLabel)}</text>` : ""}
      </g>
    </g>
  </g>`;
}

function edgeMarkup(edge, source, target, selectedId, focusIds, settling, order, rootNodeId, featuredIds) {
  const semantics = graphRelationSemantics(edge);
  const touches = selectedId && focusIds.has(edge.sourceId) && focusIds.has(edge.targetId);
  const creatorRelation = edge.relationType.startsWith("creator_");
  const chainEdge = creatorRelation || edge.relationType === "cluster_source" ||
    (edge.relationType === "contains" && edge.sourceId === rootNodeId && featuredIds.has(edge.targetId));
  const dimmed = selectedId && !touches;
  const width = edge.relationType === "contains" ? .7 : edge.relationType === "cluster_source" ? .62 : creatorRelation ? .75 : .35 + (edge.strength || 0) / 75;
  const opacity = Math.min(source.opacity, target.opacity) * (edge.relationType === "contains" ? .56 : edge.relationType === "cluster_source" ? .52 : creatorRelation ? .72 : .4);
  const relationLabel = edge.relationType === "contains"
    ? "属于同一话题系列，距离近表示结构关联"
    : edge.relationType === "cluster_source"
      ? "具体变化或话题对应的母帖"
    : edge.relationType === "shared_chinese_audience"
      ? `${edge.sharedChineseCreatorCount} 位中文共同博主`
      : edge.relationType === "shared_global_audience"
        ? `${edge.sharedCreatorCount} 位全球共同作者`
        : edge.relationType === "creator_source"
          ? "该变化的最早证据来源"
          : edge.relationType === "creator_post"
            ? "博主的代表帖子"
          : edge.relationType === "creator_explicit"
            ? "明确引用或承接形成的传播关系"
            : "基于时间和内容相似度的弱相关，不代表因果";
  const interactive = !edge.virtual;
  return `<g class="graph-edge relation-${edge.relationType} distance-${semantics.distanceBand} ${semantics.directional ? "directional" : "undirected"} ${semantics.causal ? "causal-evidence" : ""} ${edge.relationScope ? `scope-${edge.relationScope}` : ""} ${edge.lod ? `edge-lod-${edge.lod}` : ""} ${chainEdge ? "chain-edge" : ""} ${edge.weak ? "weak" : ""} ${touches ? "focused" : ""} ${dimmed ? "dimmed" : ""} ${settling ? "settling" : ""}" data-source-id="${esc(edge.sourceId)}" data-target-id="${esc(edge.targetId)}" ${interactive ? `data-graph-edge="${esc(edge.id)}" role="button" tabindex="0" aria-label="${esc(relationLabel)}"` : `aria-hidden="true"`} style="--edge-opacity:${opacity.toFixed(3)};--edge-delay:${(180 + order * 14).toFixed(0)}ms">
    <line class="edge-visible" x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" style="--edge-width:${width.toFixed(1)}"></line>
    ${interactive ? `<line class="edge-hit" x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}"></line>` : ""}
  </g>`;
}

function defaultCamera() {
  return { zoom: MIN_ZOOM, panX: 0, panY: 0 };
}

function cameraTransform(camera, frame = { width: WIDTH, height: HEIGHT }) {
  return `translate(${camera.panX.toFixed(2)} ${camera.panY.toFixed(2)}) translate(${frame.width / 2} ${frame.height / 2}) scale(${camera.zoom.toFixed(4)}) translate(${-frame.width / 2} ${-frame.height / 2})`;
}

function clientToGraph(svg, clientX, clientY) {
  const bounds = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const viewWidth = viewBox?.width || WIDTH;
  const viewHeight = viewBox?.height || HEIGHT;
  return {
    x: (clientX - bounds.left) / Math.max(1, bounds.width) * viewWidth,
    y: (clientY - bounds.top) / Math.max(1, bounds.height) * viewHeight
  };
}

function responsiveGraphFrame(container) {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  const aspect = width / height;
  const frameWidth = Math.max(360, HEIGHT * aspect);
  return {
    width: frameWidth,
    height: HEIGHT,
    xScale: Math.max(.24, Math.min(1.35, (frameWidth - 64) / (WIDTH - 64))),
    yScale: aspect < .7 ? .92 : .78
  };
}

export function mountTopicGraph(container, graph, options = {}) {
  container.__graphResizeObserver?.disconnect?.();
  const topics = graph?.nodes?.filter(node => node.nodeType === "topic") || [];
  if (!topics.length) {
    container.innerHTML = `<div class="graph-empty"><b>讨论焦点积累中</b><span>至少需要多作者、多证据族和真实互动，单条爆款不会进入关系图。</span></div>`;
    return;
  }
  const selected = graph.nodes.find(node => node.id === options.selectedNodeId);
  const view = deriveGraphView(graph, selected?.id);
  const creatorView = deriveCreatorView(view, selected, {
    ...options,
    graph,
    selectedCreatorId: options.selectedCreatorId
  });
  const mobile = container.clientWidth < 560;
  if (mobile) {
    view.labelIds = new Set([
      view.rootNodeId,
      ...view.featuredChanges.slice(0, 2).map(node => node.id),
      ...(selected ? [selected.id] : [])
    ]);
  }
  const topicRanks = new Map([...topics].sort((a, b) => b.globalScore - a.globalScore).map((node, index) => [node.id, index + 1]));
  const cacheKey = `${LAYOUT_VERSION}:${graph.window}:${graph.calculatedAt}:${view.rootNodeId}:${view.visibleNodes.map(node => node.id).join(",")}:${creatorView.nodes.map(node => node.id).join(",")}:${creatorView.postNodes.map(node => node.id).join(",")}`;
  if (!layoutCache.has(cacheKey)) layoutCache.set(cacheKey, createLayout(view, creatorView));
  const positions = layoutCache.get(cacheKey);
  const settling = !animatedLayouts.has(cacheKey) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  animatedLayouts.add(cacheKey);
  if (!cameraStateByWindow.has(graph.window)) cameraStateByWindow.set(graph.window, defaultCamera(mobile));
  const camera = cameraStateByWindow.get(graph.window);
  let activeFrame = { width: WIDTH, height: HEIGHT, xScale: 1, yScale: 1 };

  const paint = () => {
    container.__graphResizeObserver?.disconnect?.();
    const frame = responsiveGraphFrame(container);
    activeFrame = frame;
    const ambientNodes = creatorView.nodes.filter(node => node.ambientHotPost);
    const ambientIndexById = new Map(ambientNodes.map((node, index) => [node.id, index]));
    const projected = new Map([...positions].map(([id, point]) => {
      const projectedPoint = projectPoint(point);
      if (ambientIndexById.has(id)) {
        const viewportPoint = ambientHotViewportPoint(
          ambientIndexById.get(id),
          ambientNodes.length,
          id,
          frame
        );
        return [id, {
          ...projectedPoint,
          x: viewportPoint.x,
          y: viewportPoint.y
        }];
      }
      return [id, {
        ...projectedPoint,
        x: frame.width / 2 + (projectedPoint.x - WIDTH / 2) * frame.xScale,
        y: frame.height / 2 + (projectedPoint.y - HEIGHT / 2) * frame.yScale
      }];
    }));
    const clusterEdges = view.clusterEdges.map(edge => ({
      ...edge,
      lod: creatorView.nodeTierById.get(edge.targetId) === "detail"
        ? "detail"
        : creatorView.nodeTierById.get(edge.targetId) === "near"
          ? "near"
          : undefined
    }));
    const allEdges = [...view.visibleEdges, ...clusterEdges];
    const selectedCreator = creatorView.nodes.find(node => node.id === options.selectedCreatorId);
    const selectedEntityId = selectedCreator?.id || selected?.id || null;
    const focusTopicId = selectedCreator?.topicId || (selected?.nodeType === "topic" ? selected.id : selected?.parentTopicId);
    const focusChangeId = selectedCreator?.changeId || (selected?.nodeType === "change" ? selected.id : null);
    const focusClusterId = selectedCreator?.clusterId || null;
    const relatedIds = new Set();
    if (selectedEntityId) {
      if (focusTopicId) relatedIds.add(focusTopicId);
      view.visibleChanges
        .filter(change =>
          focusChangeId ? change.id === focusChangeId : change.parentTopicId === focusTopicId
        )
        .forEach(change => relatedIds.add(change.id));
      creatorView.nodes
        .filter(node =>
          focusClusterId ? node.clusterId === focusClusterId
            : focusChangeId ? node.changeId === focusChangeId
              : node.topicId === focusTopicId
        )
        .forEach(node => relatedIds.add(node.id));
      relatedIds.add(selectedEntityId);
    }
    const edgeLayer = allEdges.map((edge, index) => {
      const source = projected.get(edge.sourceId);
      const target = projected.get(edge.targetId);
      return source && target ? edgeMarkup(edge, source, target, selectedEntityId, relatedIds, settling, index, view.rootNodeId, new Set(view.featuredChanges.map(node => node.id))) : "";
    }).join("");
    const allNodes = [...view.visibleNodes, ...creatorView.nodes, ...creatorView.postNodes];
    const interactionLayer = node => ({
      topic: 0,
      change: 1,
      creator: 2,
      post: 3
    })[node.nodeType] ?? 0;
    const nodeLayer = allNodes
      .map(node => ({ node, point: projected.get(node.id) }))
      .filter(item => item.point)
      .sort((a, b) =>
        interactionLayer(a.node) - interactionLayer(b.node) ||
        a.point.depth - b.point.depth
      )
      .map(({ node, point }, index) => nodeMarkup(node, point, {
        selectedId: selectedEntityId,
        hasSelection: Boolean(selectedEntityId),
        relatedIds,
        rootNodeId: view.rootNodeId,
        labelIds: view.labelIds,
        featuredIds: new Set(view.featuredChanges.map(node => node.id)),
        topicRanks,
        settling,
        mobile,
        order: index
      })).join("");
    const lod = graphLod(camera.zoom);
    container.innerHTML = `<div class="graph-reading-key" aria-hidden="true">捏合缩放 · 拖动平移 · EN 英文来源</div>
      <svg class="topic-network lod-${lod} ${settling ? "is-settling" : ""}" data-lod="${lod}" data-zoom="${camera.zoom.toFixed(2)}" style="--label-scale:${graphLabelScale(camera.zoom).toFixed(4)}" viewBox="0 0 ${frame.width.toFixed(1)} ${frame.height}" aria-label="AI 推圈讨论焦点与相关博主" tabindex="0">
        <defs><marker id="provenance-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6Z"></path></marker></defs>
        <rect class="graph-background" width="${frame.width.toFixed(1)}" height="${frame.height}"></rect>
        <g class="graph-viewport" transform="${cameraTransform(camera, frame)}">
          <g class="graph-zone-boundary" aria-hidden="true">
            <ellipse cx="${(frame.width / 2).toFixed(1)}" cy="${(frame.height / 2).toFixed(1)}" rx="${(625 * frame.xScale).toFixed(1)}" ry="${(352 * frame.yScale).toFixed(1)}"></ellipse>
          </g>
          <g class="edge-layer">${edgeLayer}</g><g class="node-layer">${nodeLayer}</g>
        </g>
      </svg>`;
    bind();
  };

  const bind = () => {
    const frame = activeFrame;
    const svg = container.querySelector("svg");
    const viewport = svg?.querySelector(".graph-viewport");
    if (!svg || !viewport) return;
    let collisionFrame = 0;
    let collisionSettleTimer = 0;
    const resolveLabelCollisions = () => {
      if (svg.classList.contains("camera-moving")) return;
      cancelAnimationFrame(collisionFrame);
      collisionFrame = requestAnimationFrame(() => {
        svg.classList.add("resolving-labels");
        const nodes = [...svg.querySelectorAll(".graph-node")];
        nodes.forEach(node => {
          node.classList.remove("label-collided");
          node.style.setProperty("--label-x", "0px");
          node.style.setProperty("--label-y", "0px");
        });
        const visible = nodes.map(node => {
          const label = node.querySelector(".node-label");
          if (!label || getComputedStyle(node).opacity === "0" || getComputedStyle(label).opacity === "0") return null;
          const priority = node.classList.contains("hover-origin") || node.matches(":focus") ? 130
            : node.classList.contains("selected") ? 120
            : node.classList.contains("root") ? 115
              : node.classList.contains("node-topic") ? 100
                : node.classList.contains("branch-detail") ? 85
                  : node.classList.contains("node-change") ? 80
                    : node.classList.contains("creator-source") || node.classList.contains("post-source") ? 70
                      : node.classList.contains("creator-followed") || node.classList.contains("post-followed") ? 65
                        : node.classList.contains("creator-high") ? 60
                          : node.classList.contains("node-creator") ? 45 : 30;
          return { node, label, priority };
        }).filter(Boolean).sort((a, b) => b.priority - a.priority);
        const coreRects = nodes.map(node => {
          const core = node.querySelector(".node-core");
          if (!core) return null;
          const rect = core.getBoundingClientRect();
          return {
            node,
            left: rect.left - 3,
            right: rect.right + 3,
            top: rect.top - 3,
            bottom: rect.bottom + 3
          };
        }).filter(Boolean);
        const accepted = [];
        for (const item of visible) {
          const textRects = [
            item.label,
            item.node.querySelector(".node-parent"),
            item.node.querySelector(".node-summary")
          ].filter(element => element && getComputedStyle(element).opacity !== "0")
            .map(element => element.getBoundingClientRect())
            .filter(rect => rect?.width);
          if (!textRects.length) continue;
          const rect = {
            left: Math.min(...textRects.map(value => value.left)),
            right: Math.max(...textRects.map(value => value.right)),
            top: Math.min(...textRects.map(value => value.top)),
            bottom: Math.max(...textRects.map(value => value.bottom))
          };
          const horizontalGap = item.priority >= 100 ? 10 : item.priority >= 80 ? 7 : 4;
          const verticalGap = item.priority >= 100 ? 7 : item.priority >= 80 ? 5 : 3;
          const overlapsLabel = accepted.some(other =>
            rect.left < other.right + horizontalGap &&
            rect.right > other.left - horizontalGap &&
            rect.top < other.bottom + verticalGap &&
            rect.bottom > other.top - verticalGap
          );
          const coversNode = coreRects.some(core =>
            core.node !== item.node &&
            rect.left < core.right &&
            rect.right > core.left &&
            rect.top < core.bottom &&
            rect.bottom > core.top
          );
          if (overlapsLabel || coversNode) {
            item.node.classList.add("label-collided");
          } else {
            accepted.push(rect);
          }
        }
        requestAnimationFrame(() => svg.classList.remove("resolving-labels"));
      });
    };
    const beginCameraMotion = () => {
      clearTimeout(collisionSettleTimer);
      cancelAnimationFrame(collisionFrame);
      svg.classList.add("camera-moving");
    };
    const finishCameraMotion = (delay = 72) => {
      clearTimeout(collisionSettleTimer);
      collisionSettleTimer = window.setTimeout(() => {
        svg.classList.remove("camera-moving");
        resolveLabelCollisions();
      }, delay);
    };
    const applyCamera = (next, { resolveCollisions = true } = {}) => {
      Object.assign(camera, clampGraphCamera(next));
      cameraStateByWindow.set(graph.window, camera);
      viewport.setAttribute("transform", cameraTransform(camera, frame));
      svg.style.setProperty("--label-scale", graphLabelScale(camera.zoom).toFixed(4));
      const lod = graphLod(camera.zoom);
      svg.dataset.zoom = camera.zoom.toFixed(2);
      svg.dataset.lod = lod;
      for (const value of ["far", "default", "near", "detail"]) svg.classList.toggle(`lod-${value}`, value === lod);
      if (resolveCollisions) resolveLabelCollisions();
    };
    const resetCamera = () => applyCamera(defaultCamera(mobile));
    const gesture = {
      pointers: new Map(),
      panStart: null,
      pinchStart: null,
      moved: false,
      suppressClick: false,
      lastTapAt: 0,
      lastTapPoint: null
    };
    const suppressActivation = event => {
      if (!gesture.suppressClick) return false;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      gesture.suppressClick = false;
      return true;
    };
    const graphNodes = [...svg.querySelectorAll(".graph-node[data-node-id]")];
    const graphEdges = [...svg.querySelectorAll(".graph-edge[data-source-id][data-target-id]")];
    const clearNodeHover = () => {
      svg.classList.remove("has-node-hover");
      graphNodes.forEach(node => node.classList.remove("hover-origin", "hover-neighbor"));
      graphEdges.forEach(edge => edge.classList.remove("hover-linked", "hover-muted"));
    };
    const focusNodeRelations = nodeId => {
      if (!nodeId) return clearNodeHover();
      const neighborIds = new Set();
      const origin = graphNodes.find(node => node.dataset.nodeId === nodeId);
      const clusterId = origin?.dataset.clusterId;
      svg.classList.add("has-node-hover");
      graphEdges.forEach(edge => {
        const linked = edge.dataset.sourceId === nodeId || edge.dataset.targetId === nodeId;
        edge.classList.toggle("hover-linked", linked);
        edge.classList.toggle("hover-muted", !linked);
        if (linked) {
          neighborIds.add(edge.dataset.sourceId);
          neighborIds.add(edge.dataset.targetId);
        }
      });
      if (clusterId) {
        graphNodes.filter(node => node.dataset.clusterId === clusterId).forEach(node => neighborIds.add(node.dataset.nodeId));
        if (origin.dataset.topicId) neighborIds.add(origin.dataset.topicId);
        if (origin.dataset.changeId) neighborIds.add(origin.dataset.changeId);
      }
      if (origin?.classList.contains("node-change")) {
        graphNodes
          .filter(node => node.dataset.changeId === nodeId || node.dataset.topicId === origin.dataset.topicId && node.classList.contains("node-topic"))
          .forEach(node => neighborIds.add(node.dataset.nodeId));
      }
      graphNodes.forEach(node => {
        node.classList.toggle("hover-origin", node.dataset.nodeId === nodeId);
        node.classList.toggle("hover-neighbor", node.dataset.nodeId !== nodeId && neighborIds.has(node.dataset.nodeId));
      });
    };
    const nearestInteractiveNode = (event, fallback) => {
      if (!event || event.detail === 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return fallback;
      if (event.target?.classList?.contains("node-label") ||
          event.target?.classList?.contains("node-parent") ||
          event.target?.classList?.contains("node-summary")) return fallback;
      let nearest = fallback;
      let nearestDistance = Infinity;
      graphNodes.forEach(node => {
        const core = node.querySelector(".node-core");
        if (!core) return;
        const rect = core.getBoundingClientRect();
        const distance = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
        if (distance < nearestDistance) {
          nearest = node;
          nearestDistance = distance;
        }
      });
      return nearestDistance <= 28 ? nearest : fallback;
    };
    const activateInteractiveNode = (element, event) => {
      if (suppressActivation(event)) return;
      const target = nearestInteractiveNode(event, element);
      if (target.dataset.graphCreator) {
        event.stopPropagation();
        options.onCreatorSelect?.(
          target.dataset.graphCreator,
          target.dataset.contextNode,
          target.dataset.creatorRole,
          target.dataset.discussionNode,
          target.dataset.representativePost,
          Number(target.dataset.creatorScore || 0),
          JSON.parse(target.dataset.creatorBreakdown || "{}")
        );
      } else if (target.dataset.graphNode) {
        options.onNodeSelect?.(target.dataset.graphNode);
      }
    };

    graphNodes.forEach(element => {
      element.addEventListener("pointerenter", () => focusNodeRelations(element.dataset.nodeId));
      element.addEventListener("pointerleave", clearNodeHover);
      element.addEventListener("focus", () => focusNodeRelations(element.dataset.nodeId));
      element.addEventListener("blur", () => {
        requestAnimationFrame(() => {
          if (!svg.querySelector(".graph-node:focus")) clearNodeHover();
        });
      });
    });

    container.querySelectorAll("[data-graph-node]").forEach(element => {
      const activate = event => activateInteractiveNode(element, event);
      element.addEventListener("click", activate);
      element.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate(event);
        }
      });
    });
    container.querySelectorAll("[data-graph-creator]").forEach(element => {
      const activate = event => activateInteractiveNode(element, event);
      element.addEventListener("click", activate);
      element.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate(event);
        }
      });
    });
    container.querySelectorAll("[data-graph-post]").forEach(element => {
      const activate = event => {
        if (suppressActivation(event)) return;
        event.stopPropagation();
        options.onPostSelect?.(element.dataset.graphPost);
      };
      element.addEventListener("click", activate);
      element.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate(event);
        }
      });
    });
    container.querySelectorAll("[data-graph-edge]").forEach(element => {
      const activate = event => {
        if (suppressActivation(event)) return;
        options.onEdgeSelect?.(element.dataset.graphEdge);
      };
      element.addEventListener("click", activate);
      element.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          activate(event);
        }
      });
    });
    const startPinch = () => {
      const values = [...gesture.pointers.values()];
      if (values.length < 2) return;
      beginCameraMotion();
      const [a, b] = values;
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture.pinchStart = {
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        midpoint,
        anchor: clientToGraph(svg, midpoint.x, midpoint.y),
        camera: { ...camera }
      };
      gesture.panStart = null;
    };
    svg.addEventListener("wheel", event => {
      event.preventDefault();
      beginCameraMotion();
      const bounds = svg.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const anchor = clientToGraph(svg, event.clientX, event.clientY);
        const factor = Math.exp(-event.deltaY * .006);
        applyCamera(
          zoomGraphCameraAt(camera, camera.zoom * factor, anchor.x, anchor.y, frame.width / 2, frame.height / 2),
          { resolveCollisions: false }
        );
      } else {
        applyCamera({
          ...camera,
          panX: camera.panX - event.deltaX * frame.width / Math.max(1, bounds.width),
          panY: camera.panY - event.deltaY * frame.height / Math.max(1, bounds.height)
        }, { resolveCollisions: false });
      }
      finishCameraMotion(110);
    }, { passive: false });
    svg.addEventListener("pointerdown", event => {
      gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      gesture.moved = false;
      gesture.suppressClick = false;
      if (gesture.pointers.size === 2) {
        startPinch();
      } else if (event.target.classList.contains("graph-background")) {
        beginCameraMotion();
        svg.setPointerCapture?.(event.pointerId);
        gesture.panStart = {
          pointerId: event.pointerId,
          point: clientToGraph(svg, event.clientX, event.clientY),
          camera: { ...camera },
          pointerType: event.pointerType
        };
      }
    });
    svg.addEventListener("pointermove", event => {
      if (!gesture.pointers.has(event.pointerId)) return;
      gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gesture.pointers.size >= 2 && gesture.pinchStart) {
        const [a, b] = [...gesture.pointers.values()];
        const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const currentMidpoint = clientToGraph(svg, midpoint.x, midpoint.y);
        const zoomed = zoomGraphCameraAt(
          gesture.pinchStart.camera,
          gesture.pinchStart.camera.zoom * distance / gesture.pinchStart.distance,
          gesture.pinchStart.anchor.x,
          gesture.pinchStart.anchor.y,
          frame.width / 2,
          frame.height / 2
        );
        applyCamera({
          ...zoomed,
          panX: zoomed.panX + currentMidpoint.x - gesture.pinchStart.anchor.x,
          panY: zoomed.panY + currentMidpoint.y - gesture.pinchStart.anchor.y
        }, { resolveCollisions: false });
        gesture.moved = true;
        gesture.suppressClick = true;
      } else if (gesture.panStart?.pointerId === event.pointerId) {
        const point = clientToGraph(svg, event.clientX, event.clientY);
        const dx = point.x - gesture.panStart.point.x;
        const dy = point.y - gesture.panStart.point.y;
        if (Math.hypot(dx, dy) > 3) {
          gesture.moved = true;
          gesture.suppressClick = true;
        }
        applyCamera({
          ...gesture.panStart.camera,
          panX: gesture.panStart.camera.panX + dx,
          panY: gesture.panStart.camera.panY + dy
        }, { resolveCollisions: false });
      }
    });
    const endPointer = event => {
      const wasTouch = event.pointerType === "touch";
      const point = { x: event.clientX, y: event.clientY };
      gesture.pointers.delete(event.pointerId);
      if (wasTouch && !gesture.moved && event.target.classList.contains("graph-background")) {
        const now = Date.now();
        const previous = gesture.lastTapPoint;
        if (now - gesture.lastTapAt < 320 && previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 24) {
          resetCamera();
          options.onReset?.();
          gesture.lastTapAt = 0;
          gesture.lastTapPoint = null;
          gesture.suppressClick = true;
        } else {
          gesture.lastTapAt = now;
          gesture.lastTapPoint = point;
        }
      }
      if (gesture.pointers.size < 2) gesture.pinchStart = null;
      if (!gesture.pointers.size) {
        gesture.panStart = null;
        finishCameraMotion();
      }
    };
    svg.addEventListener("pointerup", endPointer);
    svg.addEventListener("pointercancel", endPointer);
    svg.addEventListener("dblclick", event => {
      if (!event.target.classList.contains("graph-background")) return;
      event.preventDefault();
      resetCamera();
      options.onReset?.();
    });
    svg.addEventListener("keydown", event => {
      const step = event.shiftKey ? 72 : 36;
      if (event.key === "ArrowLeft") applyCamera({ ...camera, panX: camera.panX + step });
      else if (event.key === "ArrowRight") applyCamera({ ...camera, panX: camera.panX - step });
      else if (event.key === "ArrowUp") applyCamera({ ...camera, panY: camera.panY + step });
      else if (event.key === "ArrowDown") applyCamera({ ...camera, panY: camera.panY - step });
      else if (["+", "="].includes(event.key)) applyCamera(zoomGraphCameraAt(camera, camera.zoom * 1.14, frame.width / 2, frame.height / 2, frame.width / 2, frame.height / 2));
      else if (["-", "_"].includes(event.key)) applyCamera(zoomGraphCameraAt(camera, camera.zoom / 1.14, frame.width / 2, frame.height / 2, frame.width / 2, frame.height / 2));
      else if (event.key === "0") resetCamera();
      else return;
      event.preventDefault();
    });
    svg.querySelector(".graph-background")?.addEventListener("click", () => {
      if (gesture.suppressClick) {
        gesture.suppressClick = false;
        return;
      }
      options.onReset?.();
    });
    svg.querySelector(".node-layer")?.addEventListener("animationend", event => {
      if (event.animationName !== "graph-node-arrive") return;
      clearTimeout(collisionSettleTimer);
      collisionSettleTimer = window.setTimeout(resolveLabelCollisions, 72);
    });
    if ("ResizeObserver" in window) {
      let lastWidth = container.clientWidth;
      let lastHeight = container.clientHeight;
      container.__graphResizeObserver = new ResizeObserver(() => {
        const nextWidth = container.clientWidth;
        const nextHeight = container.clientHeight;
        if (Math.abs(nextWidth - lastWidth) > 8 || Math.abs(nextHeight - lastHeight) > 8) {
          lastWidth = nextWidth;
          lastHeight = nextHeight;
          requestAnimationFrame(paint);
        } else {
          resolveLabelCollisions();
        }
      });
      container.__graphResizeObserver.observe(container);
    }
    resolveLabelCollisions();
    document.fonts?.ready?.then(resolveLabelCollisions);
    if (settling) {
      // The force layout eases into its final positions after first paint.
      // Re-check every settling phase so labels cannot drift back over text
      // or node cores after the initial collision pass.
      window.setTimeout(resolveLabelCollisions, 1050);
      window.setTimeout(resolveLabelCollisions, 1800);
      window.setTimeout(resolveLabelCollisions, 2800);
      window.setTimeout(resolveLabelCollisions, 4400);
    }
  };
  paint();
}

export function graphCategoryColors() {
  return { ...CATEGORY_COLORS };
}
