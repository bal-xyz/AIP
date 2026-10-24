import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard, evidenceState } from "../lib/dashboard.mjs";
import { StateDatabase } from "../lib/database.mjs";

const day = 24 * 3_600_000;
const now = Date.parse("2026-07-31T12:00:00.000Z");

test("证据完整度不虚构 R/M，缺失字段会明确列出", () => {
  const partial = evidenceState({ id: "p", text: "AI 发布", likes: 10 }, { followers: 100 }, [], []);
  assert.equal(partial.completeness, "partial");
  assert.ok(partial.missingEvidence.includes("历史基线"));
  assert.ok(partial.missingEvidence.includes("连续快照"));
  const complete = evidenceState(
    { id: "p", text: "AI 发布", likes: 10, followers: 100 },
    {},
    Array.from({ length: 5 }, (_, i) => ({ id: `h-${i}`, likes: i + 1 })),
    [{ capturedAt: "2026-07-31T10:00:00Z" }, { capturedAt: "2026-07-31T11:00:00Z" }]
  );
  assert.equal(complete.completeness, "complete");
  assert.deepEqual(complete.missingEvidence, []);
});

function stateWith(overrides = {}) {
  return {
    version: 6,
    collector: { status: "waiting_extension", lastRunAt: null, lastError: null },
    creators: [],
    industries: [],
    jobs: [],
    posts: [],
    snapshots: [],
    industrySignals: [],
    creatorCandidates: [],
    trendingKeywords: [],
    followUpQueue: [],
    earlyEvents: [],
    sourceRegistry: [],
    eventAudit: [],
    validationTasks: [],
    discoveryHistory: [],
    ...overrides
  };
}

test("生成看板时把正式等级证据和首次等级历史写入数据库", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-dashboard-grade-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const target = {
      id: "target",
      platform: "douyin",
      handle: "@creator",
      text: "OpenAI 发布新模型",
      publishedAt: new Date(now - 3_600_000).toISOString(),
      capturedAt: new Date(now).toISOString(),
      likes: 24_000,
      followers: 100_000
    };
    const history = Array.from({ length: 20 }, (_, index) => ({
      id: `history-${index}`,
      platform: "douyin",
      handle: "@creator",
      text: `历史作品 ${index}`,
      publishedAt: new Date(now - (index + 2) * day).toISOString(),
      capturedAt: new Date(now).toISOString(),
      likes: 100,
      followers: 100_000
    }));
    const state = stateWith({
      creators: [{ id: "creator", platform: "douyin", handle: "@creator", followers: 100_000 }],
      posts: [target, ...history],
      snapshots: [
        { postId: "target", platform: "douyin", capturedAt: new Date(now - 2 * 3_600_000).toISOString(), likes: 20_000 },
        { postId: "target", platform: "douyin", capturedAt: new Date(now).toISOString(), likes: 24_000 }
      ]
    });

    const dashboard = buildDashboard(state, database, { now });
    assert.equal(dashboard.hotPosts[0].quality.grade, "T3");
    assert.equal(dashboard.hotPosts[0].evidenceCompleteness, "complete");
    assert.ok(Array.isArray(dashboard.hotPosts[0].missingEvidence));
    assert.equal(dashboard.hotPosts[0].analysisState, "not_started");
    assert.ok(dashboard.hotPosts[0].availableActions.includes("run_l1"));
    assert.deepEqual(dashboard.summary.hotGradeCounts, { T1: 0, T2: 0, T3: 1 });
    assert.equal(dashboard.summary.hotAnalysisCompleteCount, 0);
    const evidence = database.db.prepare("SELECT * FROM grade_evidence WHERE post_key=?").get("douyin:target");
    const historyRow = database.db.prepare("SELECT * FROM grade_history WHERE post_key=?").get("douyin:target");
    assert.equal(evidence.grade, "T3");
    assert.equal(JSON.parse(evidence.sample_payload).length, 20);
    assert.equal(historyRow.grade, "T3");

    buildDashboard(state, database, { now: now + 60_000 });
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM grade_history WHERE post_key=?").get("douyin:target").count, 1);
  } finally {
    database.close();
  }
});

test("X 样本满足条件后生成并复用持久化 P75 阈值版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-dashboard-threshold-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const posts = Array.from({ length: 200 }, (_, index) => ({
      id: `x-${index}`,
      platform: "x",
      creatorId: `creator-${index % 20}`,
      handle: `@creator_${index % 20}`,
      text: "AI 模型动态",
      publishedAt: new Date(now - (index === 0 ? 15 * day : day + index * 1_000)).toISOString(),
      capturedAt: new Date(now).toISOString(),
      followers: 50_000,
      likes: 100 + index
    }));
    const state = stateWith({ posts });

    buildDashboard(state, database, { now });
    const threshold = database.db.prepare("SELECT * FROM threshold_versions WHERE platform='x' AND tier='B' AND active=1").get();
    assert.equal(threshold.sample_count, 200);
    assert.equal(threshold.creator_count, 20);
    assert.ok(threshold.m_base > 0);

    buildDashboard(state, database, { now: now + day });
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM threshold_versions WHERE platform='x' AND tier='B'").get().count, 1);
  } finally {
    database.close();
  }
});

test("看板分别展示双平台运行状态和队列统计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-dashboard-collector-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const state = stateWith({
      collectionSettings: { x: true, douyin: false },
      collector: {
        status: "connected",
        lastRunAt: new Date(now - 60_000).toISOString(),
        platforms: {
          x: { status: "collecting", phase: "scrolling", lastProgressAt: new Date(now - 60_000).toISOString() },
          douyin: { status: "disabled", phase: "paused", pausedReason: "platform_disabled" }
        }
      },
      jobs: [
        { id: "x-running", platform: "x", status: "running", startedAt: new Date(now - 60_000).toISOString() },
        { id: "dy-paused", platform: "douyin", status: "paused", pausedReason: "platform_disabled" }
      ]
    });
    const dashboard = buildDashboard(state, database, { now });
    assert.equal(Object.values(dashboard.summary.hotGradeCounts).reduce((sum, value) => sum + value, 0), dashboard.summary.hotPostCount);
    assert.ok(dashboard.summary.hotAnalysisCompleteCount <= dashboard.summary.hotPostCount);
    assert.equal(dashboard.health.platforms.x.healthy, true);
    assert.equal(dashboard.health.platforms.x.running, 1);
    assert.equal(dashboard.health.platforms.douyin.enabled, false);
    assert.equal(dashboard.health.platforms.douyin.paused, 1);
  } finally {
    database.close();
  }
});

test("看板单独统计关注博主采集队列", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-dashboard-followed-queue-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const state = stateWith({
      creators: [{ id: "followed", platform: "x", handle: "@followed" }],
      jobs: [
        { id: "followed-queued", platform: "x", targetType: "creator", targetId: "followed", status: "queued" },
        { id: "followed-running", platform: "x", targetType: "creator", handle: "@followed", status: "running" },
        { id: "other-queued", platform: "x", targetType: "creator", targetId: "other", status: "queued" }
      ]
    });
    const dashboard = buildDashboard(state, database, { now });
    assert.equal(dashboard.summary.followedQueuedJobs, 1);
    assert.equal(dashboard.summary.followedRunningJobs, 1);
    assert.equal(dashboard.summary.queuedJobs, 2);
  } finally {
    database.close();
  }
});
