import test from "node:test";
import assert from "node:assert/strict";
import { analyzePosts, buildCreatorCandidates, buildIndustrySignals, buildSearchQueries, contentShape } from "../lib/analyzer.mjs";

const posts = [
  { id: "tutorial", handle: "@maker", text: "从0开始的保姆级 Vibe Coding 教程：5步做出产品", views: 120000, replies: 80, reposts: 350, likes: 1400, bookmarks: 2100, mediaType: "video", hasLink: false },
  { id: "opinion", handle: "@maker", text: "我的结论：现在做代码 Review 最强的是 Codex", views: 20000, replies: 120, reposts: 20, likes: 300, bookmarks: 60, mediaType: "none", hasLink: false },
  { id: "baseline", handle: "@maker", text: "今天继续做产品", views: 18000, replies: 8, reposts: 2, likes: 40, bookmarks: 3, mediaType: "none", hasLink: false },
  { id: "second-account", handle: "@builder", text: "Vibe Coding 新工具发布", views: 8000, replies: 10, reposts: 30, likes: 90, bookmarks: 20, mediaType: "image", hasLink: true }
];

test("内容形态基于每条帖子自身文本，不会串到相邻明细", () => {
  const analyzed = analyzePosts(posts);
  const byId = Object.fromEntries(analyzed.map(post => [post.id, post]));
  assert.equal(byId.tutorial.analysis.shape.type, "教程");
  assert.equal(byId.tutorial.analysis.shape.media, "视频");
  assert.equal(byId.opinion.analysis.shape.type, "观点");
  assert.equal(byId.secondAccount, undefined);
  assert.equal(byId["second-account"].analysis.shape.type, "观点");
  assert.match(byId.tutorial.analysis.reasonSummary, /收藏率|近期中位数/);
  assert.notEqual(byId.tutorial.analysis.reasonSummary, byId.baseline.analysis.reasonSummary);
});

test("爆火原因必须包含可复核数字证据", () => {
  const tutorial = analyzePosts(posts).find(post => post.id === "tutorial");
  assert.equal(tutorial.analysis.hot, true);
  assert.match(tutorial.analysis.evidence, /曝光 120,000/);
  assert.match(tutorial.analysis.evidence, /互动率/);
  assert.match(tutorial.analysis.evidence, /基线/);
});

test("行业信号使用命中账号数和真实帖子数计算置信度", () => {
  const analyzed = analyzePosts(posts);
  const [signal] = buildIndustrySignals([{ name: "AI 编程", keywords: ["Vibe Coding", "Codex"], excludedKeywords: [], thresholdAccounts: 2 }], analyzed);
  assert.equal(signal.accounts, 2);
  assert.equal(signal.mentions, 3);
  assert.equal(signal.confidence, "高");
  assert.equal(signal.trend, "爆发");
});

test("无匹配时不生成虚假行业热点", () => {
  const [signal] = buildIndustrySignals([{ name: "新能源", keywords: ["电池"], excludedKeywords: [], thresholdAccounts: 2 }], analyzePosts(posts));
  assert.equal(signal.mentions, 0);
  assert.equal(signal.trend, "暂无信号");
  assert.equal(signal.confidence, "低");
});

test("极低曝光不能仅凭互动率被判为走高", () => {
  const [post] = analyzePosts([{ id: "tiny", handle: "@tiny", text: "刚发布", views: 4, replies: 1, reposts: 0, likes: 0, bookmarks: null, bookmarksAvailable: false }]);
  assert.equal(post.analysis.ratios.interaction, .25);
  assert.equal(post.analysis.hot, false);
  assert.equal(post.analysis.level, "普通");
});

test("账号样本充足时，1.5倍基线属于升温，3倍属于爆发", () => {
  const analyzed = analyzePosts([
    { id: "base-a", handle: "@rise", text: "A", views: 1000, replies: 0, reposts: 0, likes: 0 },
    { id: "base-b", handle: "@rise", text: "B", views: 1000, replies: 0, reposts: 0, likes: 0 },
    { id: "base-c", handle: "@rise", text: "C", views: 1000, replies: 0, reposts: 0, likes: 0 },
    { id: "rise", handle: "@rise", text: "D", views: 1800, replies: 0, reposts: 0, likes: 0 },
    { id: "burst", handle: "@rise", text: "E", views: 4000, replies: 0, reposts: 0, likes: 0 }
  ]);
  assert.equal(analyzed.find(post => post.id === "rise").analysis.level, "升温");
  assert.equal(analyzed.find(post => post.id === "burst").analysis.level, "爆发");
});

test("纯函数可以独立识别内容形态", () => {
  const story = contentShape({
    text: "去年我离开大厂开始独立开发。起初连续失败，后来调整方向，最终做出了第一款产品，也终于实现了自由。",
    mediaType: "image"
  });
  const list = contentShape({
    text: "我整理了10个AI工具：\n1. Gemini\n2. DeepSeek\n3. Claude\n4. NotebookLM",
    mediaType: "image"
  });
  const opinion = contentShape({
    text: "为什么 AI 会取代一部分工作？我认为关键不是模型更强，而是任务交付成本已经低于人工。",
    mediaType: "none"
  });
  const tutorial = contentShape({
    text: "Kimi Slides 操作教程：第一步打开网站，然后上传文档，接着选择模板，最后点击生成并保存。",
    mediaType: "video"
  });
  assert.equal(story.type, "故事");
  assert.equal(list.type, "列表");
  assert.equal(opinion.type, "观点");
  assert.equal(tutorial.type, "教程");
  assert.equal(story.label, "故事型");
  assert.ok(story.confidence >= .56);
  assert.ok(tutorial.signals.includes("明确教学承诺"));
  assert.ok(Object.keys(tutorial.scores).every(type => ["故事", "列表", "观点", "教程"].includes(type)));
});

test("带编号的内容只有包含连续操作动作时才判为教程", () => {
  const roundup = contentShape({
    text: "AI工具推荐清单：\n1. Claude\n2. Gemini\n3. Codex\n4. Cursor"
  });
  const workflow = contentShape({
    text: "5步完成部署：第一步安装依赖，然后输入密钥，接着运行命令，最后点击发布。"
  });
  assert.equal(roundup.type, "列表");
  assert.equal(workflow.type, "教程");
});

test("故事型必须形成主体、时间推进和结果转折，第一人称本身不算故事", () => {
  const personalOpinion = contentShape({
    text: "我认为 Codex 现在更适合复杂任务，因为它的工具调用更稳定。"
  });
  const narrative = contentShape({
    text: "去年我第一次用 Agent 做产品。起初连续失败，后来重新设计工作流，最终完成了上线，也发现任务拆分才是关键。"
  });

  assert.equal(personalOpinion.type, "观点");
  assert.equal(narrative.type, "故事");
  assert.match(narrative.definition, /时间推进/);
  assert.ok(narrative.signals.includes("结果或转折"));
});

test("列表型需要真实并列结构，单独出现包括或分别不会被判为列表", () => {
  const mention = contentShape({
    text: "这次更新包括语音能力，但真正重要的是延迟下降，这意味着实时交互终于可用。"
  });
  const structured = contentShape({
    text: "AI 创作者需要关注三类工具：\n1. 研究工具\n2. 写作工具\n3. 分发工具"
  });

  assert.equal(mention.type, "观点");
  assert.equal(structured.type, "列表");
  assert.match(structured.definition, /三个/);
});

test("行业关键词生成多组窄查询，且每条任务可追溯", () => {
  const queries = buildSearchQueries({ keywords: ["Codex", "Claude Code"], language: "中英双语" });
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].keywords, ["Codex"]);
  assert.doesNotMatch(queries[0].query, /Codex OR Claude Code/);
  assert.ok(queries.every(item => item.category && item.reason && item.platform === "x"));
});

test("连续快照决定升温状态并保留快照证据", () => {
  const post = { id: "velocity", handle: "@new", text: "Codex workflow guide", views: 5000, replies: 20, reposts: 5, likes: 100, capturedAt: "2026-07-21T02:00:00.000Z" };
  const snapshots = [
    { id: "s1", postId: "velocity", capturedAt: "2026-07-21T01:00:00.000Z", views: 1000, replies: 2 },
    { id: "s2", postId: "velocity", capturedAt: "2026-07-21T02:00:00.000Z", views: 5000, replies: 20 }
  ];
  const [analyzed] = analyzePosts([post], snapshots, [{ keywords: ["Codex"] }], []);
  assert.equal(analyzed.analysis.level, "爆发");
  assert.equal(analyzed.analysis.input.snapshotIds.length, 2);
  assert.equal(analyzed.analysis.scoreBreakdown.relevance, 75);
});

test("未关注的高热作者进入候选池但不会自动关注", () => {
  const analyzed = analyzePosts([
    { id: "candidate-post", handle: "@unknown", author: "Unknown", text: "Codex guide", views: 5000, replies: 100, reposts: 50, likes: 200 }
  ], [], [{ keywords: ["Codex"] }], []);
  const [candidate] = buildCreatorCandidates(analyzed, [], []);
  assert.equal(candidate.status, "discovered");
  assert.equal(candidate.representativePostId, "candidate-post");
});
