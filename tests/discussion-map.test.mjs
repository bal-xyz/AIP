import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscussionMap } from "../lib/discussion-map.mjs";

const now = "2026-07-23T12:00:00.000Z";
const change = (normalizedText, subject, category = "技术与能力") => ({
  normalizedText,
  subject,
  changeType: "行业变化",
  category,
  previousState: "此前",
  currentState: "现在",
  confidence: .95
});
const post = (id, handle, hoursAgo, signal, level = "普通") => ({
  id,
  handle,
  author: handle,
  text: `${signal.subject} ${signal.normalizedText}`,
  publishedAt: new Date(Date.parse(now) - hoursAgo * 3_600_000).toISOString(),
  extractedChanges: [signal],
  views: 50_000,
  replies: 40,
  reposts: 80,
  likes: 600,
  bookmarks: 50,
  analysis: { level, score: level === "爆发" ? 88 : level === "升温" ? 72 : 55 }
});

test("首页讨论图只返回具体焦点，大行业主题只保留为后台分类", () => {
  const signals = [
    change("Agent 扩展工具调用", "AI Agent", "技术与能力"),
    change("Agent 开始任务交付", "AI Agent", "应用场景"),
    change("Agent 开放插件生态", "AI Agent", "事件与发布"),
    change("Agent 调整使用定价", "AI Agent", "行业趋势"),
    change("Agent 出现安全争议", "AI Agent", "争议与风险"),
    change("Agent 增强浏览器控制", "AI Agent", "技术与能力")
  ];
  const posts = signals.flatMap((signal, signalIndex) =>
    Array.from({ length: 5 }, (_, index) =>
      post(`p-${signalIndex}-${index}`, `@creator-${signalIndex}-${index}`, .1 + signalIndex * .05 + index * .05, signal, index === 0 ? "升温" : "普通")
    )
  );
  const map = buildDiscussionMap(posts, { window: "24h", now, minimumTopicDirections: 6 });
  assert.ok(map.nodes.length >= 4);
  assert.ok(map.nodes.every(node => node.nodeType === "topic" && node.focusNode));
  assert.ok(map.nodes.every(node => node.normalizedText !== "AI 编程与 Agent 工作流"));
  assert.ok(map.nodes.some(node => node.industryTheme === "AI 编程与 Agent 工作流"));
  assert.equal(map.edges.length, 0);
});

test("至少五个高质量高热证据族才能作为内容簇进入，单条爆款不行", () => {
  const signal = change("Skill 开源后快速传播", "Browser Skill", "事件与发布");
  const hotCluster = Array.from({ length: 5 }, (_, index) =>
    post(`hot-${index}`, `@hot-${index}`, .1 + index * .08, signal, "爆发")
  );
  const map = buildDiscussionMap(hotCluster, { window: "24h", now, minimumTopicDirections: 6 });
  const promoted = map.nodes.find(node =>
    node.sourcePostIds?.length === 5 &&
    node.sourcePostIds.every(id => id.startsWith("hot-"))
  );
  assert.ok(promoted);
  assert.ok(["high_discussion", "high_heat_cluster", "corroborated_signal"].includes(promoted.admissionType));
  assert.equal(promoted.evidenceFamilyCount, 5);
  assert.equal(promoted.highQualityPostCount, 5);

  const single = buildDiscussionMap([hotCluster[0]], { window: "24h", now, minimumTopicDirections: 6 });
  assert.equal(single.nodes.length, 0);
  assert.ok(single.candidateSignals.length >= 1);
});

test("只有被至少两位独立作者明确引用的来源才成为已验证发起人", () => {
  const signal = change("Codex 接入桌面控制", "Codex", "事件与发布");
  const root = post("root", "@origin", 1, signal, "升温");
  const derivatives = Array.from({ length: 6 }, (_, index) => ({
    ...post(`follow-${index}`, `@follow-${index}`, .8 - index * .1, signal),
    ...(index < 2 ? {
      provenance: { status: "confirmed", rootPostId: "root" },
      referencedPostId: "root"
    } : {})
  }));
  const map = buildDiscussionMap([root, ...derivatives], { window: "24h", now, minimumTopicDirections: 6 });
  const cluster = map.clusters[0];
  assert.ok(cluster);
  assert.equal(cluster.motherPostId, "root");
  assert.equal(cluster.motherStatus, "confirmed");
  assert.equal(cluster.explicitDerivativePostIds.length, 2);
});
