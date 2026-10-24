import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscoveryEvents,
  buildDiscoveryPayload,
  DISCOVERY_NEW_STAGE_HOURS,
  ensureDiscoveryState,
  reconcileDiscoveryLifecycle,
  refreshSourceRegistry
} from "../lib/discovery-events.mjs";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function post(id, options = {}) {
  const subject = options.subject || "Codex";
  const change = options.change || "新增桌面控制";
  return {
    id,
    handle: options.handle || `@${id}`,
    author: options.author || id,
    text: options.text || `${subject} ${change}，这是 AI 编程 Agent 的真实更新。`,
    url: `https://x.com/${String(options.handle || id).replace("@", "")}/status/${id}`,
    publishedAt: options.publishedAt || new Date(NOW - 30 * 60_000).toISOString(),
    views: options.views ?? 1200,
    likes: options.likes ?? 18,
    replies: options.replies ?? 3,
    reposts: options.reposts ?? 2,
    topics: [subject, "AI 编程"],
    analysis: { confidence: options.confidence ?? .9, level: "普通" },
    externalUrls: options.externalUrls || [],
    referencedPostIds: options.referencedPostIds || [],
    extractedChanges: [{
      normalizedText: `${subject} ${change}`,
      subject,
      changeType: options.changeType || "能力升级",
      changeSummary: `${subject} ${change}`,
      category: "技术与能力",
      previousState: "此前不支持",
      currentState: change,
      confidence: options.confidence ?? .92
    }]
  };
}

function heatSnapshots(id, first = 1000, last = 3200) {
  return [
    { id: `${id}-1`, postId: id, capturedAt: new Date(NOW - 40 * 60_000).toISOString(), views: first, likes: 8, replies: 1, reposts: 1 },
    { id: `${id}-2`, postId: id, capturedAt: new Date(NOW - 20 * 60_000).toISOString(), views: last, likes: 40, replies: 9, reposts: 8 }
  ];
}

function options(extra = {}) {
  const state = ensureDiscoveryState({ creators: [], earlyEvents: [], sourceRegistry: [], eventAudit: [], validationTasks: [] });
  return {
    now: NOW,
    sourceRegistry: state.sourceRegistry,
    previousEvents: [],
    followedCreators: [],
    trendingKeywords: [],
    ...extra
  };
}

test("普通单账号传闻不能形成事件，可信官方单帖可以成为新出现", () => {
  const rumor = buildDiscoveryEvents([post("rumor", { handle: "@ordinary" })], [], options());
  assert.equal(rumor.length, 0);

  const official = buildDiscoveryEvents([post("official", { handle: "@openai", author: "OpenAI" })], [], options());
  assert.equal(official.length, 1);
  assert.equal(official[0].stage, "new");
  assert.equal(official[0].earliestSource.sourceType, "official");
});

test("事件必须由独立作者确认，同一作者重复发帖不能伪造扩散", () => {
  const repeated = [0, 1, 2].map(index => post(`repeat-${index}`, {
    handle: "@same",
    publishedAt: new Date(NOW - (20 + index) * 60_000).toISOString()
  }));
  assert.equal(buildDiscoveryEvents(repeated, [], options()).length, 0);

  const independent = [
    post("one", { handle: "@one", text: "Codex added desktop control for an AI coding agent." }),
    post("two", { handle: "@two", text: "中文实测：Codex 新增桌面控制，AI 编程 Agent 可以直接操作桌面。" }),
    post("three", { handle: "@one", referencedPostIds: ["one"] })
  ];
  const [event] = buildDiscoveryEvents(independent, [], options());
  assert.ok(event);
  assert.equal(event.creatorCount, 2);
  assert.equal(event.stage, "spreading");
});

test("三位作者与两小时动量形成即将升温，正式热帖后进入已命中", () => {
  const posts = [
    post("one", { handle: "@one" }),
    post("two", { handle: "@two" }),
    post("three", { handle: "@three" })
  ];
  const [near] = buildDiscoveryEvents(posts, [], options());
  assert.equal(near.stage, "near_rising");
  assert.ok(near.momentumRatio >= 2);

  const [graduated] = buildDiscoveryEvents(posts, heatSnapshots("one"), options());
  assert.equal(graduated.stage, "graduated");
  assert.ok(Number.isFinite(graduated.leadMinutes));
  const payload = buildDiscoveryPayload(posts, heatSnapshots("one"), options());
  assert.equal(payload.groups.history.length, 1);
  assert.equal(payload.groups.history[0].predictionStatus, "hit");
});

test("同一产品同一变化合并，不同变化拆分，并保留中英文来源", () => {
  const posts = [
    post("en", { handle: "@builder", text: "Codex adds desktop control to the AI coding agent." }),
    post("zh", { handle: "@relay", text: "Codex 新增桌面控制，AI 编程 Agent 可以操作桌面。" }),
    post("price", { handle: "@openai", author: "OpenAI", change: "调整 API 价格", changeType: "价格变化" })
  ];
  const events = buildDiscoveryEvents(posts, [], options());
  assert.equal(events.length, 2);
  const control = events.find(item => item.change.includes("桌面控制"));
  assert.equal(control.sourceCount, 2);
  assert.equal(control.enCreatorCount, 1);
  assert.equal(control.zhCreatorCount, 1);
});

test("发现视角正确筛选海外先兆，页面最多显示三十条", () => {
  const overseas = [
    post("en-one", { handle: "@first", text: "Codex adds desktop control for AI coding agents." }),
    post("en-two", { handle: "@second", text: "Codex desktop control changes the AI coding agent workflow." })
  ];
  const payload = buildDiscoveryPayload(overseas, [], options({ view: "overseas" }));
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].zhCreatorCount, 0);
  assert.ok(payload.items.length <= payload.standard.visibleLimit);
  assert.equal(payload.window, "72h");
  assert.equal(payload.lifecycleHours, 72);
});

test("发现事件使用统一七十二小时预测周期", () => {
  const withinWindow = post("within-window", {
    handle: "@openai",
    author: "OpenAI",
    publishedAt: new Date(NOW - 50 * 3_600_000).toISOString()
  });
  const outsideWindow = post("outside-window", {
    handle: "@openai",
    author: "OpenAI",
    publishedAt: new Date(NOW - 73 * 3_600_000).toISOString()
  });
  const events = buildDiscoveryEvents([withinWindow, outsideWindow], [], options());
  assert.equal(events.length, 1);
  assert.equal(events[0].earliestPostId, "within-window");
  assert.equal(Date.parse(events[0].predictionExpiresAt) - Date.parse(events[0].firstSeenAt), 72 * 3_600_000);
});

test("新出现只保留二十四小时，未扩散的旧信号移入历史", () => {
  const oldNewPost = post("old-new", {
    handle: "@openai",
    author: "OpenAI",
    publishedAt: new Date(NOW - 25 * 3_600_000).toISOString()
  });
  const payload = buildDiscoveryPayload([oldNewPost], [], options());

  assert.equal(DISCOVERY_NEW_STAGE_HOURS, 24);
  assert.equal(payload.standard.newStageHours, 24);
  assert.equal(payload.groups.new.length, 0);
  assert.ok(payload.groups.expired.some(item => item.earliestPostId === "old-new"));
});

test("生命周期会提前归档超过二十四小时仍未扩散的新事件", () => {
  const state = ensureDiscoveryState({
    creators: [],
    earlyEvents: [{
      id: "event-stale-new",
      normalizedTitle: "已经不新的信号",
      subject: "Codex",
      change: "新增能力",
      stage: "new",
      predictionStatus: "active",
      firstSeenAt: new Date(NOW - 25 * 3_600_000).toISOString(),
      predictionExpiresAt: new Date(NOW + 47 * 3_600_000).toISOString(),
      trackingStatus: "auto",
      sourcePostIds: ["old-new"],
      postEvidence: [],
      opportunityBreakdown: {}
    }],
    discoveryHistory: [],
    sourceRegistry: [],
    eventAudit: [],
    validationTasks: []
  });

  reconcileDiscoveryLifecycle(state, [], NOW);

  assert.equal(state.earlyEvents.length, 0);
  assert.ok(state.discoveryHistory.some(item => item.id === "event-stale-new" && item.predictionStatus === "expired"));
  assert.ok(state.eventAudit.some(item => item.detail.includes("24 小时")));
});

test("命中进入历史，七十二小时未命中自动记为失效", () => {
  const state = ensureDiscoveryState({
    creators: [],
    earlyEvents: [{
      id: "event-expiring",
      normalizedTitle: "失效预测",
      subject: "Codex",
      change: "新增能力",
      stage: "new",
      predictionStatus: "active",
      firstSeenAt: new Date(NOW - 73 * 3_600_000).toISOString(),
      predictionExpiresAt: new Date(NOW - 3_600_000).toISOString(),
      trackingStatus: "auto",
      sourcePostIds: ["old"],
      postEvidence: [],
      opportunityBreakdown: {}
    }],
    discoveryHistory: [],
    sourceRegistry: [],
    eventAudit: [],
    validationTasks: []
  });
  const hit = {
    ...state.earlyEvents[0],
    id: "event-hit",
    normalizedTitle: "命中预测",
    stage: "graduated",
    predictionStatus: "hit",
    firstSeenAt: new Date(NOW - 10 * 3_600_000).toISOString(),
    predictionExpiresAt: new Date(NOW + 62 * 3_600_000).toISOString(),
    graduatedAt: new Date(NOW).toISOString()
  };
  reconcileDiscoveryLifecycle(state, [hit], NOW);
  assert.equal(state.earlyEvents.length, 0);
  assert.equal(state.discoveryHistory.length, 2);
  assert.ok(state.discoveryHistory.some(item => item.id === "event-hit" && item.predictionStatus === "hit"));
  assert.ok(state.discoveryHistory.some(item => item.id === "event-expiring" && item.predictionStatus === "expired"));
  assert.ok(state.eventAudit.some(item => item.type === "prediction_expired"));
});

test("候选来源连续三次提供可验证首发后自动晋级重点源", () => {
  const state = ensureDiscoveryState({
    creators: [],
    earlyEvents: [],
    sourceRegistry: [{
      id: "source-builder",
      handle: "@builder",
      displayName: "Builder",
      sourceType: "maintainer",
      status: "candidate",
      verifiedSignalCount: 0,
      falseSignalCount: 0,
      verifiedEventIds: []
    }],
    eventAudit: [],
    validationTasks: []
  });
  const events = [1, 2, 3].map(index => ({
    id: `event-${index}`,
    stage: "graduated",
    leadMinutes: index * 10,
    earliestSource: { handle: "@builder" },
    postEvidence: [{ handle: "@builder", author: "Builder", sourceType: "maintainer", publishedAt: new Date(NOW - index * 60_000).toISOString() }]
  }));
  refreshSourceRegistry(state, events, NOW);
  const source = state.sourceRegistry.find(item => item.id === "source-builder");
  assert.equal(source.verifiedSignalCount, 3);
  assert.equal(source.status, "trusted");
  assert.ok(state.eventAudit.some(item => item.type === "source_auto_promoted"));
});

test("X 与抖音同名来源保持独立平台身份", () => {
  const state = ensureDiscoveryState({
    creators: [
      { platform: "x", handle: "@same", displayName: "X Same" },
      { platform: "douyin", handle: "@same", platformAuthorId: "same", displayName: "抖音 Same" }
    ],
    earlyEvents: [], sourceRegistry: [], eventAudit: [], validationTasks: []
  });
  const matches = state.sourceRegistry.filter(item => item.handle === "@same");
  assert.equal(matches.length, 2);
  assert.deepEqual(new Set(matches.map(item => item.platform)), new Set(["x", "douyin"]));
});
