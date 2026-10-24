import test from "node:test";
import assert from "node:assert/strict";
import { buildEvents, extractEventFields } from "../lib/event-engine.mjs";

const now = Date.parse("2026-07-31T12:00:00.000Z");
const hour = 3_600_000;

function post(index, options = {}) {
  return {
    id: `post-${index}`,
    platform: options.platform || "x",
    handle: options.handle || `@author${index}`,
    author: options.author || `作者 ${index}`,
    text: options.text || "OpenAI 发布 GPT-6 新模型",
    publishedAt: new Date(now - (options.hoursAgo ?? 1) * hour).toISOString(),
    likes: options.likes || 1000,
    qualityGrade: options.grade || "T1",
    momentumStatus: options.momentum || "rising",
    sourceType: options.sourceType
  };
}

test("确定性字段提取不会依赖模型密钥", () => {
  assert.deepEqual(extractEventFields({ text: "OpenAI 正式发布 GPT-6 模型" }), {
    subject: "openai",
    action: "release",
    version: "gpt-6",
    change: "",
    confidence: 0.82,
    origin: "deterministic"
  });
  assert.equal(extractEventFields({ text: "今天聊聊人工智能工具" }), null);
});

test("具体产品纠正冲突主体且事件标题不重复产品名称", () => {
  assert.equal(extractEventFields({
    text: "DeepSeek V4 Flash 发布",
    eventFields: { subject: "openai", action: "release", version: "deepseek-v4" }
  }).subject, "deepseek");
  assert.equal(extractEventFields({
    text: "Codex 更新",
    eventFields: { subject: "anthropic", action: "upgrade", version: "codex" }
  }).subject, "codex");
  const [event] = buildEvents([{
    ...post(100),
    text: "xAI 发布 Grok 4.7",
    eventFields: { subject: "xai-grok", action: "release", version: "grok-4.7" }
  }], { now });
  assert.equal(event.title, "xAI Grok 4.7 正式发布");
});

test("单作者重复发帖不能伪造热点", () => {
  const posts = Array.from({ length: 12 }, (_, index) => post(index, { handle: "@same" }));
  const [event] = buildEvents(posts, { now });
  assert.equal(event.postCount, 12);
  assert.equal(event.authorCount, 1);
  assert.equal(event.stage, "candidate");
});

test("八条五作者且存在 T2 可形成热点", () => {
  const posts = Array.from({ length: 8 }, (_, index) => post(index, {
    handle: `@author${index % 5}`,
    grade: index === 0 ? "T2" : "T1",
    hoursAgo: 3 + index * 0.1
  }));
  const [event] = buildEvents(posts, { now });
  assert.equal(event.stage, "hot");
  assert.equal(event.authorCount, 5);
});

test("十二条八作者且两条 T2 与近期扩散可形成爆发热点", () => {
  const posts = Array.from({ length: 12 }, (_, index) => post(index, {
    handle: `@author${index % 8}`,
    grade: index < 2 ? "T2" : "T1",
    hoursAgo: index < 9 ? 1 : 3
  }));
  const [event] = buildEvents(posts, { now });
  assert.equal(event.acceleration.accelerating, true);
  assert.equal(event.stage, "burst");
});

test("不同具体变化不会因主体相同而合并", () => {
  const events = buildEvents([
    post(1, { text: "OpenAI 发布 GPT-6" }),
    post(2, { text: "OpenAI API 发生 INC-1234 大规模服务故障" })
  ], { now });
  assert.equal(events.length, 2);
  assert.notEqual(events[0].key, events[1].key);
});

test("结构化宽泛变化不能冒充具体产品，故障必须带事故标识", () => {
  assert.equal(extractEventFields({
    text: "DALL-E 4 发布",
    eventFields: { subject: "openai", action: "release", change: "image-generation" }
  }), null);
  assert.equal(extractEventFields({
    text: "欧洲接口故障",
    eventFields: { subject: "openai", action: "outage", change: "api-欧洲" }
  }), null);
  assert.equal(extractEventFields({
    text: "事故 INC-9921",
    eventFields: { subject: "openai", action: "outage", change: "INC-9921" }
  }).change, "inc-9921");
});

test("同一主体同一动作的不同具体产品不会误合并，宽泛变化停留在候选", () => {
  const events = buildEvents([
    post(1, { text: "OpenAI 发布 DALL-E 4 图像模型" }),
    post(2, { text: "OpenAI 发布 Sora Image 2 图像模型" })
  ], { now });
  assert.equal(events.length, 2);
  assert.notEqual(events[0].key, events[1].key);
  assert.equal(buildEvents([post(3, { text: "OpenAI 发布新的图像模型" })], { now }).length, 0);
});

test("覆盖缺口暂停冷却，两个有效窗口后才允许冷却", () => {
  const hotPosts = Array.from({ length: 8 }, (_, index) => post(index, {
    handle: `@author${index % 5}`,
    grade: index === 0 ? "T2" : "T1",
    hoursAgo: 2
  }));
  const [previous] = buildEvents(hotPosts, { now });
  assert.equal(previous.stage, "hot");

  const oldPosts = hotPosts.map(item => ({ ...item, publishedAt: new Date(now - 50 * hour).toISOString() }));
  const pending = buildEvents(oldPosts, {
    now: now + 49 * hour,
    initialWindowHours: 120,
    previousEvents: [previous],
    coverageWindows: [{ nodeHealthy: false, successRate: 0 }, { nodeHealthy: false, successRate: 0 }]
  })[0];
  assert.equal(pending.stage, "pending");

  const cooling = buildEvents(oldPosts, {
    now: now + 49 * hour,
    initialWindowHours: 120,
    previousEvents: [previous],
    coverageWindows: [
      { nodeHealthy: true, successRate: 0.9 },
      { nodeHealthy: true, successRate: 1 }
    ]
  })[0];
  assert.equal(cooling.stage, "cooling");
});
