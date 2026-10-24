import test from "node:test";
import assert from "node:assert/strict";
import { baselineFor, calibrateXThresholds, gradeWork, momentumStatus, ratePost, tierOf } from "../lib/grading.mjs";

const hour = 3_600_000;
const now = Date.parse("2026-07-31T12:00:00.000Z");

function history(handle = "@creator", platform = "douyin", count = 20, likes = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`,
    platform,
    handle,
    text: `历史作品 ${index}`,
    publishedAt: new Date(now - (index + 2) * 24 * hour).toISOString(),
    capturedAt: new Date(now - hour).toISOString(),
    likes
  }));
}

test("粉丝体量边界与抖音基准稳定", () => {
  assert.deepEqual(tierOf(9_999), { tier: "C", label: "素人", douyinMBase: 0.30 });
  assert.equal(tierOf(10_000).tier, "B");
  assert.equal(tierOf(100_000).tier, "A");
  assert.equal(tierOf(1_000_000).tier, "S");
  assert.equal(tierOf(0), null);
});

test("R 基线只使用目标发布前同平台同作者最近二十条有效作品", () => {
  const target = {
    id: "target",
    platform: "douyin",
    handle: "@creator",
    publishedAt: new Date(now - hour).toISOString(),
    likes: 800
  };
  const posts = [
    ...history(),
    { ...target, id: "future", publishedAt: new Date(now + hour).toISOString(), likes: 99999 },
    { id: "other", platform: "x", handle: "@creator", publishedAt: new Date(now - 2 * hour).toISOString(), likes: 99999 },
    { id: "repost", platform: "douyin", handle: "@creator", publishedAt: new Date(now - 3 * hour).toISOString(), likes: 99999, contentType: "repost" }
  ];
  const baseline = baselineFor(target, posts, { freezeAt: new Date(now).toISOString() });
  assert.equal(baseline.ready, true);
  assert.equal(baseline.samples.length, 20);
  assert.equal(baseline.baseline, 100);
  assert.ok(!baseline.samples.some(item => ["future", "other", "repost", "target"].includes(item.postId)));
});

test("基线使用冻结时点之前的最新快照而不是作品当前点赞", () => {
  const target = {
    id: "target",
    platform: "douyin",
    handle: "@creator",
    publishedAt: new Date(now - hour).toISOString(),
    likes: 800
  };
  const posts = history("@creator", "douyin", 5, 9_999);
  const snapshotsByPost = new Map(posts.map(post => [`douyin:${post.id}`, [
    { postId: post.id, platform: "douyin", capturedAt: new Date(now - 2 * hour).toISOString(), likes: 100 },
    { postId: post.id, platform: "douyin", capturedAt: new Date(now + hour).toISOString(), likes: 50_000 }
  ]]));
  const baseline = baselineFor(target, posts, { freezeAt: new Date(now).toISOString(), snapshotsByPost });
  assert.equal(baseline.baseline, 100);
  assert.ok(baseline.samples.every(sample => sample.value === 100));
});

test("普通等级不冻结证据，首次进入 T1 后才冻结", () => {
  const base = {
    id: "target",
    platform: "douyin",
    handle: "@creator",
    publishedAt: new Date(now - hour).toISOString(),
    capturedAt: new Date(now).toISOString()
  };
  const ordinary = ratePost({ ...base, likes: 100 }, {
    followers: 10_000,
    posts: history("@creator", "douyin", 5, 100),
    freezeAt: new Date(now).toISOString()
  });
  assert.equal(ordinary.grade, "ordinary");
  assert.equal(ordinary.evidence, null);
  const formal = ratePost({ ...base, likes: 2_000 }, {
    followers: 10_000,
    posts: history("@creator", "douyin", 5, 100),
    freezeAt: new Date(now).toISOString()
  });
  assert.equal(formal.grade, "T1");
  assert.ok(formal.evidence);
});

test("历史不足五条只生成候选", () => {
  const target = { id: "target", platform: "douyin", handle: "@creator", publishedAt: new Date(now).toISOString(), likes: 800 };
  const result = ratePost(target, { followers: 10_000, posts: history("@creator", "douyin", 4), freezeAt: new Date(now).toISOString() });
  assert.equal(result.grade, "candidate");
  assert.equal(result.reason, "insufficient_history");
});

test("R 与 M 双门槛严格区分 T1、T2、T3 和低质异常", () => {
  assert.equal(gradeWork(2, 0.08, 0.08).grade, "T1");
  assert.equal(gradeWork(4, 0.12, 0.08).grade, "T2");
  assert.equal(gradeWork(8, 0.24, 0.08).grade, "T3");
  assert.equal(gradeWork(8, 0.07, 0.08).grade, "low_quality");
  assert.equal(gradeWork(1.99, 1, 0.08).grade, "ordinary");
});

test("抖音正式评级冻结可复算证据且等级不自动下降", () => {
  const target = {
    id: "target",
    platform: "douyin",
    handle: "@creator",
    publishedAt: new Date(now - hour).toISOString(),
    capturedAt: new Date(now).toISOString(),
    likes: 24_000
  };
  const result = ratePost(target, {
    followers: 100_000,
    posts: history(),
    freezeAt: new Date(now).toISOString()
  });
  assert.equal(result.grade, "T3");
  assert.equal(result.r, 240);
  assert.equal(result.m, 0.24);
  assert.equal(result.evidence.samples.length, 20);
  assert.equal(result.evidence.evidenceHash.length, 64);

  const retained = ratePost({ ...target, likes: 100 }, {
    followers: 100_000,
    posts: history(),
    freezeAt: new Date(now).toISOString(),
    previousGrade: "T3"
  });
  assert.equal(retained.grade, "T3");
  assert.equal(retained.computedGrade, "ordinary");
});

test("X 每层同时满足天数、样本数和作者数才产生 P75 门槛", () => {
  const samples = Array.from({ length: 200 }, (_, index) => ({
    id: `x-${index}`,
    creatorId: `creator-${index % 20}`,
    followers: 50_000,
    likes: 100 + index,
    publishedAt: new Date(now - (15 * 24 * hour + index * 1000)).toISOString()
  }));
  const thresholds = calibrateXThresholds(samples, now);
  assert.equal(thresholds.B.ready, true);
  assert.ok(thresholds.B.mBase > 0);
  assert.equal(thresholds.C.ready, false);

  const insufficientCreators = calibrateXThresholds(samples.map(item => ({ ...item, creatorId: "one" })), now);
  assert.equal(insufficientCreators.B.ready, false);
});

test("X 未完成校准时保留 R 但不生成正式等级", () => {
  const target = { id: "target", platform: "x", handle: "@creator", publishedAt: new Date(now - hour).toISOString(), likes: 800 };
  const result = ratePost(target, {
    followers: 10_000,
    posts: history("@creator", "x"),
    xThresholds: { B: { ready: false } },
    freezeAt: new Date(now).toISOString()
  });
  assert.equal(result.grade, "candidate");
  assert.equal(result.reason, "x_threshold_uncalibrated");
  assert.equal(result.r, 8);
});

test("动量使用两小时窗口并区分升温、爆发、缺口和异常", () => {
  const snapshots = [
    { capturedAt: new Date(now - 4 * hour).toISOString(), likes: 100 },
    { capturedAt: new Date(now - 2 * hour).toISOString(), likes: 120 },
    { capturedAt: new Date(now).toISOString(), likes: 180 }
  ];
  assert.equal(momentumStatus(snapshots, { now, intervalMinutes: 15 }).status, "burst");
  assert.equal(momentumStatus(snapshots.slice(1), { now, intervalMinutes: 15 }).status, "observing");
  assert.equal(momentumStatus([
    { capturedAt: new Date(now - 4 * hour).toISOString(), likes: 100 },
    { capturedAt: new Date(now - 2 * hour).toISOString(), likes: 120 },
    { capturedAt: new Date(now).toISOString(), likes: 110 }
  ], { now, intervalMinutes: 15 }).status, "anomaly");
});

test("冷却需要连续两个窗口", () => {
  const snapshots = [
    { capturedAt: new Date(now - 4 * hour).toISOString(), likes: 100 },
    { capturedAt: new Date(now - 2 * hour).toISOString(), likes: 200 },
    { capturedAt: new Date(now).toISOString(), likes: 210 }
  ];
  const first = momentumStatus(snapshots, { now, intervalMinutes: 15, previousCoolingStreak: 0 });
  assert.equal(first.status, "steady");
  assert.equal(first.coolingStreak, 1);
  const second = momentumStatus(snapshots, { now, intervalMinutes: 15, previousCoolingStreak: 1 });
  assert.equal(second.status, "cooling");
});
