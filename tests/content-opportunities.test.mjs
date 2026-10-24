import test from "node:test";
import assert from "node:assert/strict";
import { buildCollectorSchedule, buildContentIntelligence, buildContentOpportunities } from "../lib/content-opportunities.mjs";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

function post(id, options = {}) {
  return {
    id,
    handle: options.handle || `@${id}`,
    author: options.author || id,
    text: options.text || "Codex 浏览器自动化能力发布",
    url: options.url === null ? "" : `https://x.com/${id}/status/${id}`,
    publishedAt: options.publishedAt || "2026-07-26T10:00:00.000Z",
    views: options.views ?? 2000,
    likes: options.likes ?? 30,
    replies: options.replies ?? 6,
    reposts: options.reposts ?? 4,
    followed: Boolean(options.followed),
    topics: options.topics || ["Codex"],
    provenance: options.provenance || { status: "direct", rootPostId: null },
    rootSourceForPostIds: options.rootSourceForPostIds || [],
    analysis: {
      confidence: options.confidence ?? .9,
      baselineViews: options.baselineViews ?? 1000,
      level: options.level || "普通",
      shape: { type: options.shape || "观点", label: `${options.shape || "观点"}型`, confidence: .85, signals: ["明确结论"] },
      velocity: { count: 2, viewVelocity: 0, replyVelocity: 0, growthRatio: 0 }
    }
  };
}

function snapshots(id, first, last, minutes = 20) {
  return [
    { id: `${id}-s1`, postId: id, capturedAt: "2026-07-26T10:10:00.000Z", views: first.views, likes: first.likes, replies: first.replies, reposts: first.reposts || 0 },
    { id: `${id}-s2`, postId: id, capturedAt: new Date(Date.parse("2026-07-26T10:10:00.000Z") + minutes * 60_000).toISOString(), views: last.views, likes: last.likes, replies: last.replies, reposts: last.reposts || 0 }
  ];
}

test("热帖机会只根据真实快照判定升温和爆发", () => {
  const burst = post("burst", { views: 3000, likes: 50, replies: 8 });
  const rising = post("rising", { views: 1300, likes: 30, replies: 3 });
  const evidence = [
    ...snapshots("burst", { views: 1000, likes: 10, replies: 1 }, { views: 3000, likes: 50, replies: 8 }, 20),
    ...snapshots("rising", { views: 1000, likes: 10, replies: 1 }, { views: 1300, likes: 30, replies: 3 }, 20)
  ];
  const result = buildContentOpportunities([burst, rising], evidence, { window: "24h", now: NOW });

  assert.equal(result.groups.now.find(item => item.postId === "burst").heatStatus, "burst");
  assert.equal(result.groups.now.find(item => item.postId === "rising").heatStatus, "rising");
  assert.equal(result.standard.minimumSnapshotIntervalMinutes, 10);
});

test("单快照高互动只能进入候选，低置信度和无链接内容被拒绝", () => {
  const candidate = post("candidate", { views: 5000, likes: 80, replies: 20 });
  const lowConfidence = post("low", { confidence: .6, views: 9000, likes: 100, replies: 30 });
  const noUrl = post("no-url", { url: null, views: 9000, likes: 100, replies: 30 });
  const evidence = [
    { id: "candidate-s1", postId: "candidate", capturedAt: "2026-07-26T10:10:00.000Z", views: 5000, likes: 80, replies: 20, reposts: 10 },
    { id: "low-s1", postId: "low", capturedAt: "2026-07-26T10:10:00.000Z", views: 9000, likes: 100, replies: 30, reposts: 10 },
    { id: "no-url-s1", postId: "no-url", capturedAt: "2026-07-26T10:10:00.000Z", views: 9000, likes: 100, replies: 30, reposts: 10 }
  ];
  const result = buildContentOpportunities([candidate, lowConfidence, noUrl], evidence, { window: "24h", now: NOW });

  assert.deepEqual(result.groups.observe.map(item => item.postId), ["candidate"]);
  assert.equal(result.groups.observe[0].heatStatus, "candidate");
  assert.equal(result.groups.now.length, 0);
});

test("关注身份不改变真实热度，筛选和内容形态使用专用字段", () => {
  const tutorialText = "Codex 操作教程：第一步打开项目，然后选择任务，接着运行检查，最后点击发布。";
  const followed = post("followed", { followed: true, shape: "教程", text: tutorialText, views: 1300, replies: 6 });
  const normal = post("normal", { followed: false, shape: "教程", text: tutorialText, views: 1300, replies: 6 });
  const evidence = [
    ...snapshots("followed", { views: 1000, likes: 10, replies: 1 }, { views: 1300, likes: 30, replies: 6 }, 20),
    ...snapshots("normal", { views: 1000, likes: 10, replies: 1 }, { views: 1300, likes: 30, replies: 6 }, 20)
  ];
  const all = buildContentOpportunities([followed, normal], evidence, { window: "24h", now: NOW, sort: "view_velocity" });
  const filtered = buildContentOpportunities([followed, normal], evidence, { window: "24h", now: NOW, creator: "followed", shape: "tutorial" });

  assert.equal(all.items[0].heatEvidence.viewVelocity, all.items[1].heatEvidence.viewVelocity);
  assert.deepEqual(filtered.items.map(item => item.postId), ["followed"]);
});

test("深度分析不虚构评论和母帖，并生成三个差异化跟进切口", () => {
  const item = post("source", { text: "Codex 发布浏览器自动化能力", views: 3000, replies: 8 });
  const evidence = snapshots("source", { views: 1000, likes: 10, replies: 1 }, { views: 3000, likes: 50, replies: 8 }, 20);
  const intelligence = buildContentIntelligence([item], evidence, "source", { window: "24h", now: NOW });

  assert.equal(intelligence.provenanceChain.rootPost, null);
  assert.equal(intelligence.comments.available, false);
  assert.equal(intelligence.followUpAngles.length, 3);
  assert.equal(intelligence.whatHappened.length, 2);
  assert.ok(intelligence.whatHappened.every(value => value !== item.text));
  assert.ok(intelligence.riskFlags.some(value => value.includes("评论")));
});

test("热帖标题总结具体语义，不沿用表示、进展等句首式标题", () => {
  const tesla = post("tesla", {
    text: "特斯拉利润腰斩，现金流转负，钱全烧在 AI 和机器人上了。",
    topics: ["机器人"],
    views: 3000,
    replies: 8
  });
  const evidence = snapshots("tesla", { views: 1000, likes: 10, replies: 1 }, { views: 3000, likes: 50, replies: 8 }, 20);
  const result = buildContentOpportunities([tesla], evidence, { window: "24h", now: NOW });

  assert.equal(result.items[0].displayTitle, "AI投入拖累利润");
  assert.notEqual(result.items[0].displayTitle, "机器人进展");
});

test("采集调度区分页面同步、博主发现、行业发现和复采", () => {
  const opportunities = { items: [{ heatStatus: "burst", nextRecaptureAt: "2026-07-26T12:15:00.000Z" }] };
  const schedule = buildCollectorSchedule({
    collector: { status: "connected", lastRunAt: "2026-07-26T11:50:00.000Z" },
    jobs: [
      { status: "complete", targetType: "creator", finishedAt: "2026-07-26T11:40:00.000Z" },
      { status: "complete", targetType: "industry", finishedAt: "2026-07-26T11:30:00.000Z" }
    ]
  }, opportunities, NOW);

  assert.equal(schedule.uiRefreshSeconds, 60);
  assert.equal(schedule.nextCreatorDiscoveryAt, "2026-07-26T12:10:00.000Z");
  assert.equal(schedule.nextIndustryDiscoveryAt, "2026-07-26T12:30:00.000Z");
  assert.equal(schedule.nextRecaptureAt, "2026-07-26T12:15:00.000Z");
});

test("全量热帖不受2H、24H、7D限制，并按发布时间倒序排列", () => {
  const oldBurst = post("old-burst", {
    publishedAt: "2026-06-01T10:00:00.000Z",
    views: 5000,
    likes: 80,
    replies: 18
  });
  const recentRising = post("recent-rising", { views: 1300, likes: 30, replies: 3 });
  const evidence = [
    ...snapshots("old-burst", { views: 1000, likes: 10, replies: 1 }, { views: 5000, likes: 80, replies: 18 }, 20),
    ...snapshots("recent-rising", { views: 1000, likes: 10, replies: 1 }, { views: 1300, likes: 30, replies: 3 }, 20)
  ];
  const result = buildContentOpportunities([recentRising, oldBurst], evidence, { window: "all", sort: "latest", now: NOW });

  assert.equal(result.coverage.requestedHours, null);
  assert.deepEqual(result.items.map(item => item.postId), ["recent-rising", "old-burst"]);
});

test("全量模式不会把只偶然出现AI字样的无关高互动帖子收入热帖", () => {
  const unrelated = post("unrelated", {
    text: "这份声明与 AI 无关，主要讨论的是娱乐行业纠纷和法律责任。",
    topics: ["AI"],
    views: 5000,
    likes: 80,
    replies: 18
  });
  const evidence = snapshots("unrelated", { views: 1000, likes: 10, replies: 1 }, { views: 5000, likes: 80, replies: 18 }, 20);
  const result = buildContentOpportunities([unrelated], evidence, { window: "all", sort: "heat", now: NOW });

  assert.equal(result.items.length, 0);
});
