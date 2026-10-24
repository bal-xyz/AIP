import test from "node:test";
import assert from "node:assert/strict";
import { buildTopicGraph, hasRankableHeat, isHighQualityTopicPost } from "../lib/topic-graph.mjs";
import {
  ambientHotPostsForGraph,
  ambientHotPostPoint,
  ambientHotViewportPoint,
  clampGraphCamera,
  compactTopicLayout,
  computeTopicAffinities,
  createLayout,
  creatorDirectionHeat,
  discussionOrbitDistance,
  discussionOrbitPoint,
  deriveCreatorView,
  deriveGraphView,
  directionHeatArcGeometry,
  directionHeatLevel,
  graphLabelScale,
  graphLod,
  graphMotherRingRadius,
  graphNodeCollisionRadius,
  graphNodeRadius,
  graphNodeTextOffsets,
  graphNodeTypography,
  radialDirectionPoint,
  graphRelationDistance,
  graphRelationSemantics,
  zoomGraphCameraAt
} from "../assets/topic-graph.js";

const now = "2026-07-23T12:00:00.000Z";
const change = (normalizedText, subject, category = "行业趋势") => ({
  normalizedText,
  subject,
  changeType: "行业变化",
  category,
  previousState: "此前状态",
  currentState: "当前状态",
  confidence: .95
});
const post = (id, handle, hoursAgo, text, changes, level = "普通") => ({
  id,
  handle,
  author: handle,
  text,
  publishedAt: new Date(Date.parse(now) - hoursAgo * 3_600_000).toISOString(),
  extractedChanges: changes,
  views: 1000,
  replies: 2,
  reposts: 1,
  likes: 12,
  bookmarks: 1,
  analysis: { level, score: level === "爆发" ? 85 : 55 }
});
const nodesOf = (graph, type) => graph.nodes.filter(node => node.nodeType === type);

test("只有英文多作者讨论时话题仍进入主图，中文热度保持为零", () => {
  const signal = change("推理模型进入低价竞争", "推理模型");
  const graph = buildTopicGraph([
    post("en-1", "@alice", .2, "Reasoning model pricing dropped again.", [signal], "爆发"),
    post("en-2", "@bob", .4, "Frontier inference is entering a price war.", [signal]),
    post("en-3", "@carol", .8, "Lower model prices change the market.", [signal]),
    post("en-4", "@dora", 1.1, "Inference prices continue to fall.", [signal]),
    post("en-5", "@eve", 1.4, "Model pricing competition is accelerating.", [signal])
  ], { window: "2h", now });
  const topic = nodesOf(graph, "topic")[0];
  assert.equal(topic.normalizedText, "推理模型进入低价竞争");
  assert.equal(topic.formationMethod, "standalone_direction");
  assert.ok(topic.globalScore > 0);
  assert.equal(topic.chineseScore, 0);
  assert.equal(topic.chineseStatus, "none");
  assert.equal(topic.score, topic.globalScore);
});

test("中文作者数量分别形成首发、确认和集中跟进状态", () => {
  const signal = change("Agent 开始交付完整任务", "AI Agent");
  const makeGraph = count => buildTopicGraph([
    post("en-base", "@global", .2, "Agents now complete end-to-end tasks.", [signal], "升温"),
    ...Array.from({ length: count }, (_, index) => post(
      `cn-${count}-${index}`,
      `@中文${index}`,
      .3 + index * .1,
      "智能体开始交付完整任务。",
      [signal],
      index === 0 ? "爆发" : "普通"
    )),
    ...Array.from({ length: Math.max(0, 4 - count) }, (_, index) => post(
      `global-${count}-${index}`,
      `@global-${index}`,
      .8 + index * .1,
      "Agents complete full workflows.",
      [signal]
    ))
  ], { window: "2h", now });
  assert.equal(nodesOf(makeGraph(1), "topic")[0].chineseStatus, "first");
  assert.equal(nodesOf(makeGraph(2), "topic")[0].chineseStatus, "confirmed");
  assert.equal(nodesOf(makeGraph(4), "topic")[0].chineseStatus, "concentrated");
});

test("记录全球首现、中文首现、传播滞后和中文跟进博主", () => {
  const signal = change("桌面语音进入编程工作流", "Codex");
  const graph = buildTopicGraph([
    post("global-first", "@global-a", 5, "Desktop voice entered coding workflows.", [signal], "升温"),
    post("global-second", "@global-b", 4, "Codex voice workflow is spreading.", [signal]),
    post("global-third", "@global-c", 3, "Voice coding workflows continue to spread.", [signal]),
    post("cn-first", "@中文首发", 2, "Codex 桌面语音开始进入中文讨论。", [signal]),
    post("cn-second", "@中文跟进", 1, "中文推圈继续讨论桌面语音编程。", [signal])
  ], { window: "24h", now });
  const topic = nodesOf(graph, "topic")[0];
  assert.equal(topic.chineseLagHours, 3);
  assert.equal(topic.globalFirstSeenAt, new Date(Date.parse(now) - 5 * 3_600_000).toISOString());
  assert.equal(topic.chineseFirstSeenAt, new Date(Date.parse(now) - 2 * 3_600_000).toISOString());
  assert.deepEqual(topic.chineseCreatorPreview.map(item => [item.handle, item.postCount]), [["@中文首发", 1], ["@中文跟进", 1]]);
});

test("不足六个方向时方向保持独立，不制造空泛大主题", () => {
  const first = change("编程 Agent 扩展工具调用", "AI 编程 Agent", "技术与能力");
  const second = change("编程 Agent 转向多模型协作", "AI 编程 Agent");
  const graph = buildTopicGraph([
    post("p1", "@alice", .2, "Coding agents call more tools.", [first], "升温"),
    post("p2", "@bob", .4, "Coding agents call external tools.", [first]),
    post("p3", "@carol", .6, "编程智能体扩展工具调用。", [first]),
    post("p3b", "@dora", .7, "Agent tools are expanding.", [first]),
    post("p3c", "@eve", .75, "More tools enter coding agents.", [first]),
    post("p4", "@alice", .8, "Coding agents orchestrate multiple models.", [second]),
    post("p5", "@bob", 1, "Multi-model coding orchestration.", [second]),
    post("p6", "@dora", 1.2, "多模型协作正在改变编程智能体。", [second]),
    post("p6b", "@eve", 1.35, "Agent model orchestration expands.", [second]),
    post("p6c", "@frank", 1.5, "Multiple models cooperate in coding agents.", [second])
  ], { window: "2h", now, minimumTopicDirections: 6 });
  const topics = nodesOf(graph, "topic");
  assert.ok(topics.length >= 2);
  assert.ok(topics.every(topic => topic.formationMethod === "standalone_direction"));
  assert.equal(nodesOf(graph, "change").length, 0);
  assert.equal(graph.edges.some(edge => edge.relationType === "contains"), false);
});

test("共同作者和共同讨论不再形成跨话题连线", () => {
  const a = change("Codex 接入语音协作", "Codex");
  const b = change("视频生成接入编程 Agent", "AI 视频工作流");
  const graph = buildTopicGraph([
    post("a1", "@alice", .2, "Codex voice is available.", [a], "升温"),
    post("a2", "@bob", .3, "Codex desktop voice workflow.", [a]),
    post("a3", "@carol", .4, "Codex voice update.", [a]),
    post("b1", "@alice", .5, "Coding agents can generate video.", [b]),
    post("b2", "@bob", .6, "Video generation enters agent workflows.", [b]),
    post("b3", "@dora", .7, "Agent video workflow update.", [b])
  ], { window: "2h", now });
  assert.equal(graph.edges.some(item => item.relationType.includes("audience")), false);
  assert.ok(graph.edges.every(item => ["contains", "cluster_source"].includes(item.relationType)));
});

test("中文共同博主也不会制造跨话题连线", () => {
  const a = change("Codex 接入语音协作", "Codex");
  const b = change("视频生成接入编程 Agent", "AI 视频工作流");
  const graph = buildTopicGraph([
    post("a1", "@中文甲", .2, "Codex 接入语音协作。", [a], "升温"),
    post("a2", "@中文乙", .3, "Codex 语音工作流更新。", [a]),
    post("a3", "@global-a", .4, "Codex voice update.", [a]),
    post("b1", "@中文甲", .5, "视频生成接入编程智能体。", [b]),
    post("b2", "@中文乙", .6, "编程智能体开始生成视频。", [b]),
    post("b3", "@global-b", .7, "Agent video workflow.", [b])
  ], { window: "2h", now });
  assert.equal(graph.edges.some(item => item.relationType.includes("audience")), false);
});

test("同一话题下的变化不会因共同作者互相连线", () => {
  const a = change("Codex 接入语音协作", "Codex");
  const b = change("Codex 增强长期项目管理", "Codex");
  const graph = buildTopicGraph([
    post("a1", "@alice", .2, "Codex voice is available.", [a], "升温"),
    post("a2", "@bob", .3, "Codex desktop voice workflow.", [a]),
    post("a3", "@carol", .4, "Codex voice update.", [a]),
    post("a4", "@erin", .45, "Codex voice collaboration expands.", [a]),
    post("a5", "@frank", .48, "Voice enters more Codex workflows.", [a]),
    post("b1", "@alice", .5, "Codex now handles long projects.", [b], "升温"),
    post("b2", "@bob", .6, "Long-running Codex tasks improved.", [b]),
    post("b3", "@dora", .7, "Codex project memory update.", [b]),
    post("b4", "@gina", .8, "Long Codex projects gain continuity.", [b]),
    post("b5", "@henry", .9, "Codex handles persistent projects.", [b])
  ], { window: "2h", now });
  assert.equal(graph.edges.some(item => item.relationScope === "change"), false);
  assert.equal(graph.edges.some(item => item.relationType === "contains"), false);
  assert.ok(nodesOf(graph, "topic").length >= 2);
  assert.ok(nodesOf(graph, "topic").every(topic => topic.formationMethod === "standalone_direction"));
});

test("多作者候选词可以作为观察热点进入第一层", () => {
  const posts = [
    post("s1", "@alice", .2, "A new browser agent workflow.", []),
    post("s2", "@bob", .5, "Browser agent automation signal.", []),
    post("s3", "@carol", .8, "Browser agent workflow is emerging.", []),
    post("s4", "@dora", 1.1, "Browser agents automate more tasks.", []),
    post("s5", "@eve", 1.4, "Browser agent adoption is rising.", [])
  ];
  const graph = buildTopicGraph(posts, {
    window: "2h",
    now,
    trendingKeywords: [{
      normalizedText: "浏览器 Agent",
      category: "应用场景",
      confidence: .92,
      sourcePostIds: ["s1", "s2", "s3", "s4", "s5"]
    }]
  });
  const topic = nodesOf(graph, "topic")[0];
  assert.ok(topic.normalizedText.startsWith("浏览器 Agent · "));
  assert.equal(topic.formationMethod, "standalone_direction");
  assert.notEqual(topic.status, "observing");
});

test("未达到窗口门槛的方向不会借产品名制造大话题", () => {
  const posts = [
    post("release-1", "@a", .2, "OpenAI launched a new model capability.", []),
    post("release-2", "@b", .3, "OpenAI released a new reasoning update.", []),
    post("price-1", "@c", .4, "OpenAI pricing and usage limits changed.", []),
    post("price-2", "@d", .5, "OpenAI plan cost and quota discussion.", []),
    post("safe-1", "@e", .6, "OpenAI safety and security risk analysis.", []),
    post("safe-2", "@f", .7, "OpenAI jailbreak security concerns.", [])
  ];
  const graph = buildTopicGraph(posts, {
    window: "2h",
    now,
    trendingKeywords: [{
      normalizedText: "OpenAI",
      category: "人物与机构",
      confidence: .95,
      sourcePostIds: posts.map(item => item.id)
    }]
  });
  assert.equal(nodesOf(graph, "topic").length, 0);
  assert.equal(nodesOf(graph, "change").length, 0);
  assert.ok(graph.coverage.rejectedWeakDirectionCount >= 3);
});

test("单条帖子只进入候选观察池，不能生成正式方向", () => {
  const signal = change("Agent 新增本地文件控制", "AI Agent", "技术与能力");
  const graph = buildTopicGraph([
    post("single-signal", "@source", .2, "Agent adds local file control.", [signal], "升温")
  ], { window: "24h", now });
  assert.equal(nodesOf(graph, "topic").length, 0);
  assert.equal(nodesOf(graph, "change").length, 0);
  const candidate = graph.candidateDirections.find(item => item.normalizedText === signal.normalizedText);
  assert.ok(candidate);
  assert.equal(candidate.directionStatus, "candidate");
  assert.equal(candidate.evidenceFamilyCount, 1);
  assert.ok(candidate.failures.includes("insufficient_evidence_families"));
  assert.ok(candidate.failures.includes("insufficient_independent_creators"));
});

test("同一母帖的引用与加工只计算为一个独立证据族", () => {
  const signal = change("Codex 发布新的桌面能力", "Codex", "事件与发布");
  const root = post("mother", "@origin", .2, "Codex launches a desktop capability.", [signal], "升温");
  const derivatives = Array.from({ length: 4 }, (_, index) => ({
    ...post(`derivative-${index}`, `@derivative-${index}`, .4 + index * .1, "Reworked discussion of the same Codex post.", [signal]),
    provenance: { status: "confirmed", rootPostId: "mother" },
    referencedPostId: "mother"
  }));
  const graph = buildTopicGraph([root, ...derivatives], { window: "24h", now });
  assert.equal(nodesOf(graph, "topic").length, 0);
  const candidate = graph.candidateDirections.find(item => item.normalizedText === signal.normalizedText);
  assert.ok(candidate);
  assert.equal(candidate.rankablePostCount, 5);
  assert.equal(candidate.evidenceFamilyCount, 1);
  assert.ok(candidate.failures.includes("insufficient_evidence_families"));
});

test("单一作者不能制造讨论方向分支", () => {
  const posts = [
    post("one-1", "@same", .2, "OpenAI launched a new model.", []),
    post("one-2", "@same", .3, "OpenAI released another update.", [])
  ];
  const graph = buildTopicGraph(posts, {
    window: "2h",
    now,
    trendingKeywords: [{
      normalizedText: "OpenAI",
      confidence: .95,
      sourcePostIds: posts.map(item => item.id)
    }]
  });
  assert.equal(nodesOf(graph, "topic").length, 0);
  assert.equal(nodesOf(graph, "change").length, 0);
});

test("无法归入细分类的多作者话题生成综合讨论方向而不直连博主", () => {
  const posts = [
    post("general-1", "@a", .2, "OpenAI remains an important subject today.", []),
    post("general-2", "@b", .3, "People are talking about OpenAI today.", []),
    post("general-3", "@c", .4, "OpenAI remains under broad discussion.", []),
    post("general-4", "@d", .5, "OpenAI discussion continues.", []),
    post("general-5", "@e", .6, "More creators discuss OpenAI.", [])
  ];
  const graph = buildTopicGraph(posts, {
    window: "2h",
    now,
    trendingKeywords: [{
      normalizedText: "OpenAI",
      confidence: .95,
      sourcePostIds: posts.map(item => item.id)
    }]
  });
  const topic = nodesOf(graph, "topic")[0];
  assert.equal(topic.normalizedText, "OpenAI · 综合讨论");
  assert.equal(topic.formationMethod, "standalone_direction");
  assert.equal(nodesOf(graph, "change").length, 0);
  assert.ok(graph.clusters.every(cluster => cluster.changeId === topic.id));
  assert.ok(graph.edges.filter(edge => edge.relationType === "cluster_source")
    .every(edge => edge.sourceId === topic.id));
});

test("生产图谱只有至少六个真实方向时才保留上层话题", () => {
  const directions = [
    change("Agent 发布新能力", "AI Agent", "事件与发布"),
    change("Agent 工具调用", "AI Agent", "技术与能力"),
    change("Agent 客服落地", "AI Agent", "应用场景"),
    change("Agent 定价变化", "AI Agent", "行业趋势"),
    change("Agent 安全边界", "AI Agent", "争议与风险"),
    change("Agent 开源生态", "AI Agent", "行业趋势")
  ];
  const graph = buildTopicGraph(directions.flatMap((direction, index) => [
    post(`direction-${index}-a`, `@author-${index}-a`, .2 + index * .1, `Agent workflow evidence for ${direction.normalizedText}.`, [direction], "升温"),
    post(`direction-${index}-b`, `@author-${index}-b`, .3 + index * .1, `Agent workflow update about ${direction.normalizedText}.`, [direction]),
    post(`direction-${index}-c`, `@author-${index}-c`, .4 + index * .1, `Agent workflow discussion: ${direction.normalizedText}.`, [direction]),
    post(`direction-${index}-d`, `@author-${index}-d`, .5 + index * .1, `More evidence for ${direction.normalizedText}.`, [direction]),
    post(`direction-${index}-e`, `@author-${index}-e`, .6 + index * .1, `Independent discussion of ${direction.normalizedText}.`, [direction])
  ]), { window: "2h", now, minimumTopicDirections: 6 });
  const [topic] = nodesOf(graph, "topic");
  assert.ok(topic);
  assert.equal(topic.normalizedText, "AI 编程与 Agent 工作流");
  assert.equal(topic.formationMethod, "direction_cluster");
  assert.equal(topic.childChangeIds.length, 6);
  assert.equal(nodesOf(graph, "change").length, 6);
  assert.equal(graph.standard.minimumTopicDirections, 6);
});

test("只有一个真实方向时移除多余上层并把方向提升为顶层节点", () => {
  const direction = change("浏览器 Agent 控制标签页", "浏览器 Agent", "技术与能力");
  const graph = buildTopicGraph([
    post("single-a", "@a", .2, "Independent evidence A.", [direction], "升温"),
    post("single-b", "@b", .3, "Independent evidence B.", [direction]),
    post("single-c", "@c", .4, "Independent evidence C.", [direction]),
    post("single-d", "@d", .5, "Independent evidence D.", [direction]),
    post("single-e", "@e", .6, "Independent evidence E.", [direction])
  ], { window: "2h", now, minimumTopicDirections: 6 });
  const [collapsed] = nodesOf(graph, "topic");
  assert.ok(collapsed);
  assert.equal(collapsed.collapsedDirection, true);
  assert.equal(collapsed.normalizedText, "浏览器 Agent 控制标签页");
  assert.equal(collapsed.formationMethod, "standalone_direction");
  assert.equal(nodesOf(graph, "change").length, 0);
  assert.ok(graph.clusters.every(cluster => cluster.changeId === collapsed.id));
  assert.ok(graph.edges.every(edge => edge.relationType === "cluster_source"));
});

test("单一账号重复发帖不能独立生成首页话题", () => {
  const signal = change("浏览器 Agent 扩展控制能力", "浏览器 Agent");
  const graph = buildTopicGraph([
    post("p1", "@same", .2, "浏览器 Agent 更新。", [signal], "爆发"),
    post("p2", "@same", .4, "浏览器 Agent 再次更新。", [signal]),
    post("p3", "@same", .6, "浏览器 Agent 新变化。", [signal])
  ], { window: "24h", now });
  assert.equal(nodesOf(graph, "topic").length, 0);
});

test("所有时间窗口至少需要五条高质量帖子，7天窗口继续使用更高证据族门槛", () => {
  const signal = change("模型路由进入生产环境", "模型路由");
  const posts = [
    post("p1", "@a", .2, "模型路由进入生产环境。", [signal], "升温"),
    post("p2", "@b", .8, "模型路由开始规模部署。", [signal]),
    post("p0", "@c", 1.2, "模型路由获得更多生产采用。", [signal]),
    post("p3", "@c", 26, "Model routing deployment.", [signal]),
    post("p4", "@d", 50, "Model routing production use.", [signal]),
    post("p5", "@e", 80, "Model routing is now common.", [signal]),
    post("p6", "@f", 100, "Model routing adoption expands.", [signal]),
    post("p7", "@g", 120, "Routing systems enter more deployments.", [signal])
  ];
  const twoHour = buildTopicGraph(posts, { window: "2h", now });
  const sevenDay = buildTopicGraph(posts, { window: "7d", now });
  assert.equal(nodesOf(twoHour, "topic").length, 0);
  assert.equal(nodesOf(sevenDay, "topic")[0].postCount, 8);
  assert.equal(twoHour.standard.minimumPosts, 5);
  assert.equal(sevenDay.standard.minimumPosts, 5);
  assert.equal(sevenDay.standard.directionMinimumEvidenceFamilies, 8);
});

test("首页保留全景话题并默认展示每个话题最多六个真实分支", () => {
  const topics = Array.from({ length: 8 }, (_, index) => ({
    id: `topic-${index}`,
    nodeType: "topic",
    normalizedText: `话题${index}`,
    globalScore: 100 - index,
    chineseScore: index,
    creatorCount: 10,
    childChangeIds: Array.from({ length: 5 }, (__, child) => `change-${index}-${child}`)
  }));
  const changes = topics.flatMap((topic, index) => topic.childChangeIds.map((id, child) => ({
    id,
    nodeType: "change",
    parentTopicId: topic.id,
    normalizedText: `变化${index}-${child}`,
    globalScore: 80 - child,
    chineseScore: child,
    creatorCount: 4
  })));
  const edges = changes.map(item => ({
    id: `edge-${item.id}`,
    sourceId: item.parentTopicId,
    targetId: item.id,
    relationType: "contains",
    weak: false,
    strength: 50
  }));
  const view = deriveGraphView({ nodes: [...topics, ...changes], edges });
  assert.equal(view.visibleTopics.length, 8);
  assert.equal(view.rootChanges.length, 5);
  assert.equal(view.visibleNodes.length, 48);
  assert.equal(view.visibleEdges.filter(edge => edge.relationType === "contains").length, 40);
  assert.ok(view.labelIds.has("topic-0"));
  assert.ok(view.labelIds.has("change-0-0"));
  const expanded = deriveGraphView({ nodes: [...topics, ...changes], edges }, "topic-3");
  assert.equal(expanded.rootChanges.length, 5);
  assert.equal(expanded.visibleNodes.length, 48);
});

test("选择其他话题后切换中心，同时保留全景骨架", () => {
  const nodes = [
    { id: "topic-a", nodeType: "topic", globalScore: 90, creatorCount: 5, childChangeIds: ["change-a"] },
    { id: "topic-b", nodeType: "topic", globalScore: 70, creatorCount: 4, childChangeIds: ["change-b"] },
    { id: "change-a", nodeType: "change", parentTopicId: "topic-a", globalScore: 50, creatorCount: 3 },
    { id: "change-b", nodeType: "change", parentTopicId: "topic-b", globalScore: 40, creatorCount: 3 }
  ];
  const edges = [
    { id: "a", sourceId: "topic-a", targetId: "change-a", relationType: "contains", weak: false, strength: 50 },
    { id: "b", sourceId: "topic-b", targetId: "change-b", relationType: "contains", weak: false, strength: 45 }
  ];
  const view = deriveGraphView({ nodes, edges }, "topic-b");
  assert.equal(view.rootNodeId, "topic-b");
  assert.deepEqual(view.rootChanges.map(item => item.id), ["change-b"]);
  assert.ok(view.visibleEdges.some(edge => edge.id === "b"));
  assert.ok(view.visibleEdges.some(edge => edge.id === "a"));
  assert.ok(view.labelIds.has("change-b"));
});

test("默认中心只由真实全球热度决定，冷门话题仍保留在全景", () => {
  const nodes = [
    { id: "signal", nodeType: "topic", signalOnly: true, globalScore: 99, creatorCount: 8, childChangeIds: [] },
    { id: "topic", nodeType: "topic", globalScore: 80, creatorCount: 5, childChangeIds: ["change"] },
    { id: "cold", nodeType: "topic", globalScore: 12, creatorCount: 2, childChangeIds: [] },
    { id: "change", nodeType: "change", parentTopicId: "topic", globalScore: 70, creatorCount: 4 }
  ];
  const view = deriveGraphView({
    nodes,
    edges: [{ id: "contains", sourceId: "topic", targetId: "change", relationType: "contains", strength: 60 }]
  });
  assert.equal(view.rootNodeId, "signal");
  assert.deepEqual(view.visibleTopics.map(node => node.id), ["signal", "topic", "cold"]);
  assert.equal(view.visibleChanges[0].id, "change");
});

test("语义缩放使用四个稳定层级", () => {
  assert.equal(graphLod(.7), "far");
  assert.equal(graphLod(1), "default");
  assert.equal(graphLod(1.5), "near");
  assert.equal(graphLod(2), "detail");
});

test("图谱相机限制缩放和平移边界", () => {
  assert.deepEqual(clampGraphCamera({ zoom: 9, panX: 9999, panY: -9999 }), {
    zoom: 4,
    panX: 3686.3999999999996,
    panY: -2073.6
  });
  assert.equal(clampGraphCamera({ zoom: .1, panX: 0, panY: 0 }).zoom, .93);
});

test("以指针为中心缩放时锚点位置保持稳定", () => {
  const camera = { zoom: 1, panX: 0, panY: 0 };
  const anchor = { x: 800, y: 420 };
  const next = zoomGraphCameraAt(camera, 2, anchor.x, anchor.y);
  const beforeX = 640 + (anchor.x - 640) * camera.zoom + camera.panX;
  const afterX = 640 + (anchor.x - 640) * next.zoom + next.panX;
  const beforeY = 360 + (anchor.y - 360) * camera.zoom + camera.panY;
  const afterY = 360 + (anchor.y - 360) * next.zoom + next.panY;
  assert.equal(afterX, beforeX);
  assert.equal(afterY, beforeY);
});

test("图谱距离随关系强度增加而缩短", () => {
  const weak = graphRelationDistance({ relationType: "shared_global_audience", strength: 20 });
  const strong = graphRelationDistance({ relationType: "shared_global_audience", strength: 80 });
  assert.ok(strong < weak);
});

test("明确引用比疑似加工更靠近源头", () => {
  const explicit = graphRelationDistance({ relationType: "creator_explicit", strength: 80 });
  const inferred = graphRelationDistance({ relationType: "creator_inferred", strength: 80 });
  assert.ok(explicit < inferred);
});

test("同一话题系列比共同讨论关系更靠近", () => {
  const sameSeries = graphRelationDistance({ relationType: "contains", strength: 50 });
  const sharedAudience = graphRelationDistance({ relationType: "shared_chinese_audience", strength: 100 });
  assert.ok(sameSeries < sharedAudience);
});

test("距离语义区分系列、来源、推测和共同讨论", () => {
  assert.deepEqual(graphRelationSemantics({ relationType: "contains" }), {
    distanceBand: "series",
    directional: true,
    causal: false,
    label: "同一话题系列"
  });
  assert.equal(graphRelationSemantics({ relationType: "creator_explicit" }).causal, true);
  assert.equal(graphRelationSemantics({ relationType: "creator_inferred" }).directional, false);
  assert.equal(graphRelationSemantics({ relationType: "shared_global_audience" }).distanceBand, "correlation");
});

test("疑似加工和共同讨论不会贴得像已确认因果", () => {
  const explicit = graphRelationDistance({ relationType: "creator_explicit", strength: 40 });
  const inferred = graphRelationDistance({ relationType: "creator_inferred", strength: 100 });
  const correlated = graphRelationDistance({ relationType: "shared_chinese_audience", strength: 100 });
  assert.ok(explicit < inferred);
  assert.ok(inferred < correlated);
});

test("方向中文热度使用五段短弧按20分逐段点亮", () => {
  assert.equal(directionHeatLevel(0), 0);
  assert.equal(directionHeatLevel(20), 1);
  assert.equal(directionHeatLevel(21), 2);
  assert.equal(directionHeatLevel(64), 4);
  assert.equal(directionHeatLevel(180), 5);
  const arcs = directionHeatArcGeometry(53);
  assert.equal(arcs.length, 5);
  assert.equal(arcs.filter(arc => arc.lit).length, 3);
  assert.ok(arcs.every(arc => arc.d.startsWith("M") && arc.d.includes("A7.8 7.8")));
});

test("讨论簇优先使用已确认母帖并标记关注博主加工内容", () => {
  const rootPost = {
    id: "root-post",
    handle: "@origin",
    author: "Origin",
    text: "Original model release",
    publishedAt: new Date(Date.parse(now) - 4 * 3_600_000).toISOString(),
    views: 2400, likes: 30, replies: 4, reposts: 5, bookmarks: 2,
    analysis: { level: "升温", score: 70 }
  };
  const followedPost = {
    id: "follow-post",
    handle: "@followed",
    author: "Followed",
    text: "中文解读与加工",
    publishedAt: new Date(Date.parse(now) - 2 * 3_600_000).toISOString(),
    views: 1800, likes: 25, replies: 5, reposts: 3, bookmarks: 2,
    analysis: { level: "升温", score: 66 },
    provenance: { status: "confirmed", rootPostId: "root-post" }
  };
  const highPost = {
    id: "high-post",
    handle: "@hot",
    author: "Hot Creator",
    text: "A high-value follow-up with new evidence",
    publishedAt: new Date(Date.parse(now) - 1 * 3_600_000).toISOString(),
    views: 3200, likes: 44, replies: 7, reposts: 8, bookmarks: 4,
    analysis: { level: "升温", score: 72 }
  };
  const graph = {
    nodes: [
      {
        id: "topic",
        nodeType: "topic",
        normalizedText: "模型发布",
        globalScore: 80,
        creatorCount: 2,
        childChangeIds: ["change"]
      },
      {
        id: "change",
        nodeType: "change",
        parentTopicId: "topic",
        normalizedText: "模型能力更新",
        globalScore: 78,
        creatorCount: 2,
        sourcePostIds: ["root-post", "follow-post"]
      }
    ],
    edges: [{
      id: "contains",
      sourceId: "topic",
      targetId: "change",
      relationType: "contains",
      strength: 70
    }, {
      id: "cluster-source",
      sourceId: "change",
      targetId: "discussion-cluster-root-post",
      relationType: "cluster_source",
      strength: 70
    }],
    clusters: [{
      id: "cluster",
      topicId: "topic",
      changeId: "change",
      motherNodeId: "discussion-cluster-root-post",
      motherPostId: "root-post",
      motherStatus: "confirmed",
      memberPostIds: ["root-post", "follow-post", "high-post"],
      followedPostIds: ["follow-post"],
      explicitDerivativePostIds: ["follow-post"],
      inferredDerivativePostIds: ["high-post"],
      sourcePostIds: ["root-post", "follow-post", "high-post"],
      confidence: .98,
      score: 70
    }]
  };
  const view = deriveGraphView(graph);
  const creatorView = deriveCreatorView(view, null, {
    graph,
    posts: [rootPost, followedPost, highPost],
    followedCreators: [{ handle: "@followed" }]
  });
  const source = creatorView.nodes.find(node => node.isSource);
  const followed = creatorView.nodes.find(node => node.followed);
  const highValue = creatorView.nodes.find(node => node.representativePostId === "high-post");
  assert.equal(source.handle, "@origin");
  assert.equal(source.role, "已验证发起人");
  assert.equal(followed.role, "已关注加工");
  assert.equal(followed.labeled, true);
  assert.equal(source.hasAcceleratingPost, true);
  assert.equal(followed.hasAcceleratingPost, true);
  assert.equal(highValue.highValue, true);
  assert.equal(creatorView.nodes.filter(node => node.creatorTier === "default").length, 3);
  assert.equal(source.creatorTier, "default");
  assert.ok(creatorView.nodes.every(node => Number.isFinite(node.creatorDirectionScore)));
});

test("每个方向默认尽可能展示最多八位真实博主并保留关注与高热英文信号", () => {
  const creatorPosts = [
    { ...post("mother-en", "@origin", 5, "Original agent workflow", [], "升温"), analysis: { level: "升温", score: 68 } },
    post("zh-a", "@zh-a", 4, "中文方向讨论 A", [], "升温"),
    post("zh-b", "@zh-b", 3, "中文方向讨论 B", [], "爆发"),
    post("zh-c", "@zh-c", 2, "中文方向讨论 C", [], "升温"),
    post("zh-d", "@zh-d", 1, "中文方向讨论 D", [], "升温"),
    { ...post("en-hot", "@en-hot", .8, "Hot English source", [], "爆发"), analysis: { level: "爆发", score: 84 } },
    { ...post("en-second", "@en-second", .6, "Another hot English source", [], "升温"), analysis: { level: "升温", score: 76 } }
  ];
  const graph = {
    window: "24h",
    calculatedAt: now,
    nodes: [{
      id: "topic-density",
      nodeType: "topic",
      normalizedText: "Agent 工作流",
      globalScore: 80,
      creatorCount: 7,
      childChangeIds: ["change-density"],
      sourcePostIds: creatorPosts.map(item => item.id)
    }, {
      id: "change-density",
      nodeType: "change",
      parentTopicId: "topic-density",
      normalizedText: "多模型协作",
      globalScore: 75,
      chineseScore: 66,
      creatorCount: 7,
      sourcePostIds: creatorPosts.map(item => item.id)
    }],
    edges: [{
      id: "contains-density",
      sourceId: "topic-density",
      targetId: "change-density",
      relationType: "contains",
      strength: 70
    }, {
      id: "source-density",
      sourceId: "change-density",
      targetId: "mother-density",
      relationType: "cluster_source",
      strength: 70
    }],
    clusters: [{
      id: "density",
      topicId: "topic-density",
      changeId: "change-density",
      motherNodeId: "mother-density",
      motherPostId: "mother-en",
      motherStatus: "candidate",
      memberPostIds: creatorPosts.map(item => item.id),
      followedPostIds: ["zh-d"],
      explicitDerivativePostIds: [],
      inferredDerivativePostIds: [],
      sourcePostIds: creatorPosts.map(item => item.id),
      score: 75
    }]
  };
  const view = deriveGraphView(graph);
  const creatorView = deriveCreatorView(view, null, {
    graph,
    posts: creatorPosts,
    followedCreators: [{ handle: "@zh-d" }]
  });
  const defaults = creatorView.nodes.filter(node => node.creatorTier === "default");
  assert.ok(defaults.length <= 8);
  assert.ok(defaults.filter(node => node.language === "zh").length >= 4);
  assert.ok(defaults.filter(node => node.language === "en").length >= 2);
  assert.ok(defaults.some(node => node.handle === "@zh-d"));
  assert.ok(defaults.some(node => node.representativePostId === "en-hot"));
  assert.ok(defaults.some(node => node.representativePostId === "mother-en"));
});

test("关注博主7天回看进入话题但不改变当前热度", () => {
  const signal = change("Codex 增强桌面协作", "Codex");
  const currentPosts = [
    post("current-1", "@a", 1, "Codex desktop collaboration.", [signal], "升温"),
    post("current-2", "@b", 1.4, "Codex desktop workflow.", [signal]),
    post("current-3", "@c", .6, "Codex workflow update.", [signal]),
    post("current-4", "@d", .8, "Codex desktop teamwork expands.", [signal]),
    post("current-5", "@e", 1.1, "More Codex desktop collaboration.", [signal])
  ];
  const followedOld = post("followed-old", "@followed", 48, "我的 Codex 使用体验。", []);
  const base = buildTopicGraph(currentPosts, { window: "2h", now });
  const graph = buildTopicGraph([...currentPosts, followedOld], {
    window: "2h",
    now,
    followedCreators: [{ handle: "@followed" }],
    trendingKeywords: [{
      normalizedText: "Codex",
      confidence: .95,
      sourcePostIds: ["current-1", "current-2", "current-3", "current-4", "current-5", "followed-old"]
    }]
  });
  assert.equal(nodesOf(graph, "topic")[0].globalScore, nodesOf(base, "topic")[0].globalScore);
  const fallbackCluster = graph.clusters.find(cluster => cluster.followedPostIds.includes("followed-old"));
  assert.ok(fallbackCluster);
  assert.equal(fallbackCluster.windowFallback, true);
  assert.equal(graph.clusters.filter(cluster => cluster.followedPostIds.includes("followed-old")).length, 1);
});

test("母帖与加工帖子只记录在讨论簇中，不生成加工连线", () => {
  const signal = change("Codex 发布桌面语音", "Codex");
  const root = post("root", "@origin", 4, "Codex desktop voice launched.", [signal], "升温");
  const child = {
    ...post("child", "@reader", 2, "Quoted Codex desktop voice.", [signal]),
    provenance: { status: "confirmed", rootPostId: "root" },
    referencedPostId: "root"
  };
  const third = post("third", "@third", 1, "Codex voice discussion.", [signal]);
  const fourth = post("fourth", "@fourth", .5, "Codex voice workflow follow-up.", [signal], "升温");
  const fifth = post("fifth", "@fifth", .25, "Codex voice reaches more workflows.", [signal]);
  const sixth = post("sixth", "@sixth", .15, "Codex voice adoption keeps expanding.", [signal]);
  const graph = buildTopicGraph([root, child, third, fourth, fifth, sixth], { window: "2h", now });
  const cluster = graph.clusters[0];
  assert.ok(cluster.explicitDerivativePostIds.includes("child"));
  assert.deepEqual([...new Set(graph.edges.map(edge => edge.relationType))], ["cluster_source"]);
  const view = deriveGraphView(graph);
  const creatorView = deriveCreatorView(view, null, { graph, posts: [root, child, third, fourth, fifth, sixth], followedCreators: [] });
  assert.equal(creatorView.postNodes.length, 0);
  assert.ok(creatorView.nodes.every(node => node.representativePostId));
});

test("小节点根据真实帖子证据同时靠近多个大话题", () => {
  const topics = [{
    id: "topic-a",
    normalizedText: "Codex",
    sourcePostIds: ["shared", "a"]
  }, {
    id: "topic-b",
    normalizedText: "桌面自动化",
    sourcePostIds: ["shared", "b"]
  }, {
    id: "topic-c",
    normalizedText: "模型安全",
    sourcePostIds: ["c"]
  }];
  const affinities = computeTopicAffinities({
    id: "change",
    parentTopicId: "topic-a",
    normalizedText: "Codex 桌面自动化",
    sourcePostIds: ["shared"]
  }, topics);
  const byId = Object.fromEntries(affinities.map(item => [item.topicId, item]));
  assert.equal(byId["topic-a"].primary, true);
  assert.ok(byId["topic-a"].score >= .94);
  assert.ok(byId["topic-b"].score > 0);
  assert.equal(byId["topic-c"].score, 0);
});

test("没有帖子重叠或明确语义证据时不会产生空间关联", () => {
  const affinities = computeTopicAffinities({
    id: "post",
    normalizedText: "完全不同的内容",
    sourcePostIds: ["post-x"],
    handle: "@same-author"
  }, [{
    id: "topic",
    normalizedText: "Codex",
    sourcePostIds: ["post-y"],
    creatorHandles: ["@same-author"]
  }]);
  assert.equal(affinities[0].score, 0);
});

test("第一层所有行业话题都获得默认名称", () => {
  const graph = {
    nodes: Array.from({ length: 12 }, (_, index) => ({
      id: `topic-${index}`,
      nodeType: "topic",
      normalizedText: `话题 ${index}`,
      globalScore: 90 - index,
      creatorCount: 3,
      sourcePostIds: [`post-${index}`],
      childChangeIds: []
    })),
    edges: []
  };
  const view = deriveGraphView(graph);
  assert.equal(view.visibleTopics.length, 12);
  assert.ok(view.visibleTopics.every(topic => view.labelIds.has(topic.id)));
});

test("文字随画布渐进放大且层级比例稳定，为标签释放更多空间", () => {
  const far = graphLabelScale(.65);
  const normal = graphLabelScale(1);
  const detail = graphLabelScale(4);
  assert.ok(far > normal);
  assert.equal(normal, 1);
  assert.equal(detail, .5);
  assert.ok(.65 * far < normal);
  assert.ok(4 * detail > normal);
});

test("没有浏览、互动或点赞证据的帖子不能生成上榜话题", () => {
  const signal = change("Agent 扩展浏览器控制", "浏览器 Agent");
  const noViews = { ...post("no-views", "@a", .2, "Browser agent update.", [signal]), views: 0 };
  const noLikes = { ...post("no-likes", "@b", .3, "Browser agent update.", [signal]), likes: 0 };
  const noInteractions = {
    ...post("no-interactions", "@c", .4, "Browser agent update.", [signal]),
    replies: 0,
    reposts: 0,
    likes: 0,
    bookmarks: 0
  };
  assert.equal(hasRankableHeat(noViews), false);
  assert.equal(hasRankableHeat(noLikes), false);
  assert.equal(hasRankableHeat(noInteractions), false);
  const graph = buildTopicGraph([noViews, noLikes, noInteractions], { window: "24h", now });
  assert.equal(nodesOf(graph, "topic").length, 0);
  assert.equal(graph.coverage.postCount, 3);
  assert.equal(graph.coverage.rankablePostCount, 0);
  assert.equal(graph.coverage.excludedWithoutHeatCount, 3);
});

test("正式话题至少需要五条达到质量曝光线的去重帖子", () => {
  const signal = change("Agent 扩展浏览器控制", "浏览器 Agent");
  const strong = Array.from({ length: 5 }, (_, index) =>
    post(`quality-${index}`, `@quality-${index}`, .2 + index * .1, "Browser agent quality signal.", [signal], index === 0 ? "升温" : "普通")
  );
  const lowExposure = {
    ...post("low-exposure", "@low", .9, "Browser agent low exposure.", [signal]),
    views: 120
  };
  assert.equal(isHighQualityTopicPost(strong[0]), true);
  assert.equal(isHighQualityTopicPost(lowExposure), false);

  const insufficient = buildTopicGraph([...strong.slice(0, 4), lowExposure], { window: "2h", now });
  assert.equal(nodesOf(insufficient, "topic").length, 0);
  const candidate = insufficient.candidateDirections.find(item => item.normalizedText === signal.normalizedText);
  assert.equal(candidate.highQualityPostCount, 4);
  assert.ok(candidate.failures.includes("insufficient_high_quality_posts"));

  const qualified = buildTopicGraph(strong, { window: "2h", now });
  const qualifiedTopic = nodesOf(qualified, "topic")
    .find(item => item.normalizedText === signal.normalizedText);
  assert.ok(qualifiedTopic);
  assert.equal(qualifiedTopic.highQualityPostCount, 5);
  assert.equal(qualified.standard.directionMinimumHighQualityPosts, 5);
  assert.equal(qualified.standard.rankingEvidence.minimumViewsPerPost, 500);
});

test("具有曝光、互动和点赞的多作者证据才能形成话题", () => {
  const signal = change("Agent 扩展浏览器控制", "浏览器 Agent");
  const graph = buildTopicGraph([
    post("hot-a", "@a", .2, "Browser agent update.", [signal], "升温"),
    post("hot-b", "@b", .3, "Browser agent update.", [signal]),
    post("hot-c", "@c", .4, "Browser agent update.", [signal]),
    post("hot-d", "@d", .5, "Browser agent update.", [signal]),
    post("hot-e", "@e", .6, "Browser agent update.", [signal])
  ], { window: "2h", now });
  assert.equal(nodesOf(graph, "topic").length, 1);
  assert.equal(nodesOf(graph, "topic")[0].rankEligible, true);
  assert.ok(nodesOf(graph, "topic")[0].totalViews > 0);
  assert.ok(nodesOf(graph, "topic")[0].totalInteractions > 0);
  assert.ok(nodesOf(graph, "topic")[0].totalLikes > 0);
});

test("文字字号按照方向、母帖和加工帖形成稳定三级层级", () => {
  const topic = graphNodeTypography({ nodeType: "topic" }).label;
  const direction = graphNodeTypography({ nodeType: "change" }).label;
  const mother = graphNodeTypography({ nodeType: "creator", isSource: true }).label;
  const followed = graphNodeTypography({ nodeType: "creator", followed: true }).label;
  const derivative = graphNodeTypography({ nodeType: "creator" }).label;
  assert.ok(direction > topic);
  assert.ok(direction > mother);
  assert.ok(mother > followed);
  assert.equal(followed, derivative);
});

test("大话题中心点明显大于变化与普通博主点", () => {
  assert.ok(graphNodeRadius({ nodeType: "topic" }) > graphNodeRadius({ nodeType: "change" }));
  assert.ok(graphNodeRadius({ nodeType: "change" }) > graphNodeRadius({ nodeType: "creator" }));
  assert.ok(graphNodeRadius({ nodeType: "creator", isSource: true }) > graphNodeRadius({ nodeType: "creator" }));
});

test("母帖使用紧凑中心点与贴近圆环", () => {
  const mother = { nodeType: "creator", isSource: true };
  const coreRadius = graphNodeRadius(mother);
  const ringRadius = graphMotherRingRadius(mother);
  assert.equal(coreRadius, 3);
  assert.ok(ringRadius - coreRadius <= 2);
  assert.ok(ringRadius < 5);
});

test("话题名称与圆点保留安全间距且摘要保持紧凑层级", () => {
  const offsets = graphNodeTextOffsets({ nodeType: "topic" });
  assert.ok(offsets.labelY < 28);
  assert.ok(offsets.labelY > graphNodeRadius({ nodeType: "topic" }) + 14);
  assert.equal(Number((offsets.summaryY - offsets.labelY).toFixed(1)), 9);
});

test("所有层级的默认文字锚点都在自身圆点安全区之外", () => {
  const nodes = [
    { nodeType: "topic" },
    { nodeType: "change" },
    { nodeType: "creator", isSource: true },
    { nodeType: "creator" },
    { nodeType: "post" }
  ];
  nodes.forEach(node => {
    const safeDistance = graphNodeTextOffsets(node).labelY - graphNodeRadius(node);
    assert.ok(safeDistance >= 12.5);
  });
});

test("博主方向贡献热度只使用当前方向真实互动帖子", () => {
  const hot = creatorDirectionHeat([
    post("creator-hot", "@creator", 1, "中文方向热帖", [], "爆发"),
    post("creator-follow", "@creator", 2, "中文持续跟进", [], "升温")
  ], { window: "24h", now, maxPublicSignal: 5000 });
  assert.equal(hot.hasEngagement, true);
  assert.ok(hot.score > 0);
  assert.ok(hot.scoreBreakdown.growthStrength >= 75);
  assert.equal(hot.scoreBreakdown.relevantCoverage, 67);

  const noEvidence = creatorDirectionHeat([{
    ...post("creator-empty", "@creator", 1, "没有公开互动", []),
    views: 0,
    likes: 0,
    replies: 0,
    reposts: 0,
    bookmarks: 0
  }], { window: "24h", now });
  assert.equal(noEvidence.hasEngagement, false);
  assert.equal(noEvidence.score, 0);
});

test("最高热话题固定在画布中心，较冷话题向外散落且彼此留白", () => {
  const topics = Array.from({ length: 18 }, (_, index) => ({
    id: `topic-${index}`,
    nodeType: "topic",
    normalizedText: `AI 行业话题 ${index}`,
    globalScore: 96 - index * 4,
    creatorCount: 20 - index,
    sourcePostIds: [`post-${index}`]
  }));
  const positions = compactTopicLayout(topics);
  assert.deepEqual(positions.get("topic-0"), { x: 640, y: 360 });
  const distanceFromCenter = topic => {
    const point = positions.get(topic.id);
    return Math.hypot(point.x - 640, point.y - 360);
  };
  const hotAverage = topics.slice(1, 6).reduce((sum, topic) => sum + distanceFromCenter(topic), 0) / 5;
  const coolAverage = topics.slice(-5).reduce((sum, topic) => sum + distanceFromCenter(topic), 0) / 5;
  assert.ok(coolAverage > hotAverage);
  const pairDistances = topics.flatMap((topic, index) =>
    topics.slice(index + 1).map(other => {
      const a = positions.get(topic.id);
      const b = positions.get(other.id);
      return Math.hypot(a.x - b.x, a.y - b.y);
    })
  );
  assert.ok(Math.min(...pairDistances) > 82);
});

test("六个讨论方向围绕话题形成完整360度方向环", () => {
  const parent = { x: 640, y: 360 };
  const points = Array.from({ length: 6 }, (_, index) =>
    radialDirectionPoint(parent, index, 6, "topic-codex")
  );
  const centroid = points.reduce((value, point) => ({
    x: value.x + point.x / points.length,
    y: value.y + point.y / points.length
  }), { x: 0, y: 0 });
  assert.ok(Math.abs(centroid.x - parent.x) < .001);
  assert.ok(Math.abs(centroid.y - parent.y) < .001);
  assert.ok(points.every(point => Math.abs(Math.hypot(point.x - parent.x, point.y - parent.y) - 62) < .001));
  const sortedAngles = points.map(point => point.angle).sort((a, b) => a - b);
  const gaps = sortedAngles.slice(1).map((angle, index) => angle - sortedAngles[index]);
  assert.ok(gaps.every(gap => Math.abs(gap - Math.PI / 3) < .001));
});

test("讨论帖围绕具体方向形成均匀外环", () => {
  const center = { x: 420, y: 280 };
  const points = Array.from({ length: 8 }, (_, index) =>
    discussionOrbitPoint(center, index, 8, "cluster-codex", 74)
  );
  const centroid = points.reduce((value, point) => ({
    x: value.x + point.x / points.length,
    y: value.y + point.y / points.length
  }), { x: 0, y: 0 });
  assert.ok(Math.abs(centroid.x - center.x) < .001);
  assert.ok(Math.abs(centroid.y - center.y) < .001);
  assert.ok(points.every(point =>
    Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - 74) < .001
  ));
});

test("一至三个帖子严格按完整圆周等分归属于主题", () => {
  const center = { x: 420, y: 280 };
  const one = discussionOrbitPoint(center, 0, 1, "cluster-one", 40);
  assert.ok(Math.abs(Math.hypot(one.x - center.x, one.y - center.y) - 40) < .001);

  const two = Array.from({ length: 2 }, (_, index) =>
    discussionOrbitPoint(center, index, 2, "cluster-two", 40)
  );
  const twoAngles = two.map(point => point.angle).sort((a, b) => a - b);
  assert.ok(Math.abs(twoAngles[1] - twoAngles[0] - Math.PI) < .001);

  const three = Array.from({ length: 3 }, (_, index) =>
    discussionOrbitPoint(center, index, 3, "cluster-three", 40)
  );
  const threeAngles = three.map(point => point.angle).sort((a, b) => a - b);
  const gaps = [
    threeAngles[1] - threeAngles[0],
    threeAngles[2] - threeAngles[1],
    threeAngles[0] + Math.PI * 2 - threeAngles[2]
  ];
  assert.ok(gaps.every(gap => Math.abs(gap - Math.PI * 2 / 3) < .001));
});

test("账号较少时讨论簇自动靠近方向，账号增加后才扩大环绕半径", () => {
  assert.ok(discussionOrbitDistance(2) < discussionOrbitDistance(5));
  assert.ok(discussionOrbitDistance(5) < discussionOrbitDistance(8));
  assert.ok(discussionOrbitDistance(2) <= 34);
  assert.ok(discussionOrbitDistance(8) <= 54);
  assert.ok(discussionOrbitDistance(3, { followed: true }) <
    discussionOrbitDistance(3, { inferred: true }));
});

test("未成话题热帖以轻微随机疏密进入正式话题之外的外围星域", () => {
  const center = { x: 640, y: 360 };
  const points = Array.from({ length: 8 }, (_, index) =>
    ambientHotPostPoint(index, 8, `hot-${index}`, center)
  );
  assert.ok(points.every(point => Math.abs(point.x - center.x) >= 0));
  const radii = points.map(point => {
    const normalizedRadius = Math.hypot(
      (point.x - center.x) / 735,
      (point.y - center.y) / 414
    );
    return normalizedRadius;
  });
  assert.ok(radii.every(radius => radius > .86 && radius < 1.14));
  assert.ok(new Set(radii.map(radius => radius.toFixed(3))).size >= 6);
});

test("一百条外围热帖使用双层不规则星域且与正式讨论区保持分界", () => {
  const center = { x: 640, y: 360 };
  const points = Array.from({ length: 100 }, (_, index) =>
    ambientHotPostPoint(index, 100, `hot-${index}`, center)
  );
  const inner = points.filter((_, index) => index % 2 === 0);
  const outer = points.filter((_, index) => index % 2 === 1);
  assert.equal(inner.length, 50);
  assert.equal(outer.length, 50);
  const innerRadii = inner.map(point => Math.hypot(
    (point.x - center.x) / 735,
    (point.y - center.y) / 414
  ));
  const outerRadii = outer.map(point => Math.hypot(
    (point.x - center.x) / 815,
    (point.y - center.y) / 460
  ));
  assert.ok(innerRadii.every(radius => radius > .84 && radius < 1.16));
  assert.ok(outerRadii.every(radius => radius > .82 && radius < 1.18));
  assert.ok(new Set(innerRadii.map(radius => radius.toFixed(3))).size > 30);
  assert.ok(new Set(outerRadii.map(radius => radius.toFixed(3))).size > 30);
});

test("外围热帖按实际视口尺寸动态铺满四周星带", () => {
  const frame = { width: 1280, height: 720 };
  const points = Array.from({ length: 100 }, (_, index) =>
    ambientHotViewportPoint(index, 100, `viewport-hot-${index}`, frame)
  );
  const rendered = points.map(point => ({
    x: frame.width / 2 + (point.x - frame.width / 2) * .93,
    y: frame.height / 2 + (point.y - frame.height / 2) * .93
  }));
  assert.ok(rendered.every(point =>
    point.x >= 0 && point.x <= frame.width &&
    point.y >= 0 && point.y <= frame.height
  ));
  assert.ok(Math.min(...rendered.map(point => point.x)) < 30);
  assert.ok(Math.max(...rendered.map(point => point.x)) > frame.width - 30);
  assert.ok(Math.min(...rendered.map(point => point.y)) < 30);
  assert.ok(Math.max(...rendered.map(point => point.y)) > frame.height - 30);
});

test("升温节点的碰撞半径覆盖完整涟漪而非只计算实心点", () => {
  const normal = { nodeType: "creator" };
  const rising = { nodeType: "creator", hasAcceleratingPost: true };
  assert.ok(graphNodeCollisionRadius(rising) > graphNodeCollisionRadius(normal) * 1.8);
  assert.ok(graphNodeCollisionRadius(rising) * 2 + 4 > 28);
});

test("热帖形成正式话题后不再重复出现在外围候选层", () => {
  const topic = {
    id: "topic-established",
    nodeType: "topic",
    normalizedText: "已形成方向",
    globalScore: 82,
    chineseScore: 70,
    creatorCount: 3,
    sourcePostIds: ["established"]
  };
  const graph = {
    window: "24h",
    calculatedAt: now,
    nodes: [topic],
    edges: [],
    clusters: [],
    candidateDirections: [{ id: "candidate-outside", sourcePostIds: ["outside"] }]
  };
  const view = deriveGraphView(graph);
  const creatorView = deriveCreatorView(view, null, {
    graph,
    followedCreators: [],
    posts: [
      post("established", "@inside", 1, "已经形成正式讨论方向", [], "爆发"),
      post("outside", "@outside", 1, "AI Agent 尚未形成方向但正在升温", [], "升温"),
      post("unrelated-hot", "@unrelated", 1, "加密市场行情正在快速上涨", [], "爆发")
    ]
  });
  const ambient = creatorView.nodes.filter(node => node.ambientHotPost);
  assert.deepEqual(ambient.map(node => node.representativePostId), ["outside"]);
  assert.deepEqual(
    ambientHotPostsForGraph(graph, [
      post("established", "@inside", 1, "已经形成正式 AI 讨论方向", [], "爆发"),
      post("outside", "@outside", 1, "AI Agent 尚未形成方向但正在升温", [], "普通"),
      post("unrelated-hot", "@unrelated", 1, "加密市场行情正在快速上涨", [], "爆发")
    ]).map(item => item.id),
    ["outside"]
  );
});
