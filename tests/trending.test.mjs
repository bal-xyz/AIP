import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrendingKeywords,
  enqueueTrendingJobs,
  extractChangeCandidates,
  extractTopicCandidates,
  selectHomepageKeywords
} from "../lib/trending.mjs";

const now = "2026-07-23T10:00:00.000Z";
const post = (id, handle, hoursAgo, text = "Codex 发布新功能", level = "普通") => ({
  id, handle, text, publishedAt: new Date(Date.parse(now) - hoursAgo * 3_600_000).toISOString(),
  analysis: { level }
});
const industry = [{ id: "ai", name: "AI", keywords: ["Codex"], excludedKeywords: [], language: "中英双语" }];

test("单一账号多条爆款不能制造活跃关键词", () => {
  const posts = Array.from({ length: 6 }, (_, index) => post(`p${index}`, "@same", index / 10, "Codex 发布新功能", "爆发"));
  const [keyword] = buildTrendingKeywords(posts, industry, [], { now });
  assert.equal(keyword.creatorCount24h, 1);
  assert.ok(!["active", "burst"].includes(keyword.status));
});

test("多账号集中讨论和两小时动量会形成可解释活跃词", () => {
  const posts = [
    post("a", "@one", .2, "Codex 发布新功能", "爆发"),
    post("b", "@two", .4, "Codex workflow 更新", "升温"),
    post("c", "@three", .8, "Codex review guide", "普通"),
    post("d", "@four", 1.2, "Codex 新教程", "普通")
  ];
  const [keyword] = buildTrendingKeywords(posts, industry, [], { now });
  assert.equal(keyword.status, "active");
  assert.equal(keyword.postCount24h, 4);
  assert.equal(keyword.creatorCount24h, 4);
  assert.equal(keyword.sourcePostIds.length, 4);
  assert.ok(keyword.score >= 60);
  assert.deepEqual(Object.keys(keyword.scoreBreakdown), ["coverage", "creatorDiversity", "momentum", "hotPostStrength", "freshness"]);
});

test("重复帖子 ID 只计算一次，连续两个下降窗口才冷却", () => {
  const posts = [
    post("a", "@one", .2), post("a", "@one", .2),
    post("b", "@two", .4), post("c", "@three", .6), post("d", "@four", .8)
  ];
  const [active] = buildTrendingKeywords(posts, industry, [], { now });
  assert.equal(active.postCount24h, 4);
  const [firstDrop] = buildTrendingKeywords([], industry, [{ ...active, status: "active", score: 80 }], { now: "2026-07-23T11:00:00.000Z" });
  assert.equal(firstDrop.status, "active");
  const [secondDrop] = buildTrendingKeywords([], industry, [firstDrop], { now: "2026-07-23T12:00:00.000Z" });
  assert.equal(secondDrop.status, "cooling");
});

test("达到门槛的热门词为双平台生成72小时高频追踪任务", () => {
  const state = {
    industries: industry,
    jobs: [],
    trendingKeywords: [{ id: "trend-codex", normalizedText: "Codex", status: "active", score: 75, creatorCount24h: 4 }]
  };
  let counter = 0;
  const makeId = () => `job-${++counter}`;
  enqueueTrendingJobs(state, makeId, Date.parse(now));
  enqueueTrendingJobs(state, makeId, Date.parse(now) + 1_000);
  assert.equal(state.jobs.length, 2);
  assert.deepEqual(new Set(state.jobs.map(job => job.platform)), new Set(["x", "douyin"]));
  assert.ok(state.jobs.every(job => job.targetType === "trend" && job.trendingKeywordId === "trend-codex"));
  assert.ok(state.jobs.every(job => Date.parse(job.expiresAt) - Date.parse(job.requestedAt) === 72 * 3_600_000));
});

test("一条帖子分别提取实体、能力、场景和趋势，不提取空泛词", () => {
  const candidates = extractTopicCandidates({
    id: "semantic-1",
    text: "Codex 增加桌面控制，AI 编程开始从生成代码转向完成任务"
  });
  assert.deepEqual(
    candidates.map(item => [item.normalizedText, item.kind, item.category]),
    [
      ["Codex", "entity", "模型与产品"],
      ["桌面自动化", "topic", "技术与能力"],
      ["Agent 任务交付", "topic", "行业趋势"],
      ["AI 编程智能体", "topic", "应用场景"]
    ]
  );
  assert.ok(candidates.every(item => item.sourcePostId === "semantic-1" && item.confidence >= .75));
});

test("模型子版本归入父主题，营销形容词和英文口语不生成候选", () => {
  const model = extractTopicCandidates({ id: "model", text: "GPT-5.6 Sol 很强" });
  assert.equal(model.length, 1);
  assert.equal(model[0].normalizedText, "GPT-5.6");
  assert.equal(model[0].parentTopic, "GPT-5.6");
  assert.deepEqual(extractTopicCandidates({ id: "noise", text: "Use this in July. Honestly, it is strong." }), []);
});

test("只点名聊天机器人但不讨论 AI 行业的帖子不会贡献实体热度", () => {
  assert.deepEqual(
    extractTopicCandidates({ id: "mention", text: "@grok what is the current flight status?" }),
    []
  );
  assert.ok(
    extractTopicCandidates({ id: "industry", text: "Grok 4.5 improves coding agent tool calls" })
      .some(item => item.normalizedText === "Grok 4.5")
  );
});

test("英文帖子同等形成行业主题并标注海外信号", () => {
  const posts = [
    post("en-1", "@one", .2, "GPT-5.6 escaped its sandbox during an AI safety benchmark", "爆发"),
    post("en-2", "@two", .4, "The model sandbox escape raises immediate AI safety concerns", "升温"),
    post("en-3", "@three", .8, "A sandbox escape turned an AI safety benchmark into a security incident", "普通")
  ];
  const result = buildTrendingKeywords(posts, industry, [], { now });
  const keyword = result.find(item => item.normalizedText === "模型越狱与沙箱逃逸");
  assert.ok(keyword);
  assert.ok(["active", "burst"].includes(keyword.status));
  assert.equal(keyword.signalOrigin, "海外信号");
  assert.deepEqual(keyword.sourceLanguageBreakdown, { zh: 0, en: 3, other: 0 });
});

test("首页最多展示三个模型产品，并保留更广的行业主题", () => {
  const active = (normalizedText, category, score) => ({
    id: normalizedText, normalizedText, category, score, status: "active",
    confidence: .9, postCount24h: score
  });
  const selected = selectHomepageKeywords([
    active("Model A", "模型与产品", 99),
    active("Model B", "模型与产品", 98),
    active("Model C", "模型与产品", 97),
    active("Model D", "模型与产品", 96),
    active("桌面自动化", "技术与能力", 95),
    active("模型推理成本", "行业趋势", 94),
    active("代码审查", "应用场景", 93)
  ]);
  assert.equal(selected.filter(item => item.category === "模型与产品").length, 3);
  assert.ok(!selected.some(item => item.normalizedText === "Model D"));
  assert.ok(selected.some(item => item.normalizedText === "模型推理成本"));
});

test("优先使用结构化 Skill 结果并保留归一和版本证据", () => {
  const posts = ["one", "two", "three"].map((handle, index) => ({
    ...post(`skill-${index}`, `@${handle}`, .2 + index * .1, "unstructured source", index === 0 ? "爆发" : "普通"),
    extractedTopics: [{
      normalizedText: "Agent 任务交付",
      originalText: "agent task execution",
      kind: "topic",
      category: "行业趋势",
      aliases: ["agent task execution"],
      parentTopic: null,
      confidence: .93
    }]
  }));
  const [keyword] = buildTrendingKeywords(posts, industry, [], {
    now,
    extractorSkillId: "extract-trending-keywords",
    extractorSkillVersion: "1.1.0",
    promptVersion: "semantic-bilingual-v1"
  });
  assert.equal(keyword.normalizedText, "Agent 任务交付");
  assert.equal(keyword.extractorSkillVersion, "1.1.0");
  assert.equal(keyword.promptVersion, "semantic-bilingual-v1");
  assert.deepEqual(keyword.originalTexts, ["agent task execution"]);
  assert.equal(keyword.sourcePostIds.length, 3);
});

test("变化提取器只把帖子明确表达的变化写入图谱", () => {
  const [change] = extractChangeCandidates({
    id: "change-voice",
    text: "OpenAI just brought ChatGPT Voice to desktop. You can now control your computer by voice while coordinating multiple agents across ChatGPT Work and Codex."
  });
  assert.equal(change.normalizedText, "Codex 接入桌面语音协作");
  assert.equal(change.subject, "Codex");
  assert.equal(change.changeType, "能力升级");
  assert.match(change.previousState, /文字输入/);
  assert.match(change.currentState, /语音/);
  assert.equal(change.sourcePostId, "change-voice");
});

test("只有品牌评价而没有状态变化时不生成变化节点", () => {
  assert.deepEqual(
    extractChangeCandidates({ id: "brand-only", text: "Codex is my favorite AI coding tool." }),
    []
  );
});

test("结构化变化 Skill 结果优先于规则兜底", () => {
  const [change] = extractChangeCandidates({
    id: "structured-change",
    text: "Codex voice desktop",
    extractedChanges: [{
      normalizedText: "推理服务切换到按需扩容",
      subject: "推理服务",
      changeType: "基础设施变化",
      category: "技术与能力",
      previousState: "固定算力池",
      currentState: "按请求量自动扩缩容",
      confidence: .96
    }]
  });
  assert.equal(change.normalizedText, "推理服务切换到按需扩容");
  assert.equal(change.subject, "推理服务");
  assert.equal(change.currentState, "按请求量自动扩缩容");
});
