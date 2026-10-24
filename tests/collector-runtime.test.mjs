import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureCollectorRuntime,
  pausePlatformJobs,
  platformEnabled,
  platformQueueSummary,
  resumePlatformJobs,
  strangerBackfillAllowed,
  expireStaleJobs
} from "../lib/collector-runtime.mjs";

function state() {
  return {
    collectionSettings: { x: true, douyin: true },
    collector: {},
    jobs: [
      { id: "x-queued", platform: "x", status: "queued", requestedAt: "2026-08-01T00:30:00.000Z" },
      { id: "x-running", platform: "x", status: "running", startedAt: "2026-08-01T00:40:00.000Z" },
      { id: "dy-queued", platform: "douyin", status: "queued", requestedAt: "2026-08-01T00:30:00.000Z" }
    ]
  };
}

test("平台运行态默认独立且双平台开启", () => {
  const value = state();
  ensureCollectorRuntime(value);
  assert.equal(platformEnabled(value, "x"), true);
  assert.equal(platformEnabled(value, "douyin"), true);
  assert.notEqual(value.collector.platforms.x, value.collector.platforms.douyin);
});

test("风险只暂停对应平台的排队任务且不打断运行任务", () => {
  const value = state();
  assert.equal(pausePlatformJobs(value, "x", "platform_risk"), 1);
  assert.equal(value.jobs.find(job => job.id === "x-queued").status, "paused");
  assert.equal(value.jobs.find(job => job.id === "x-running").status, "running");
  assert.equal(value.jobs.find(job => job.id === "dy-queued").status, "queued");
  assert.equal(platformEnabled(value, "x"), false);
  assert.equal(platformEnabled(value, "douyin"), true);
});

test("人工恢复只恢复同原因暂停的任务", () => {
  const value = state();
  pausePlatformJobs(value, "x", "platform_risk");
  Object.assign(value.jobs.find(job => job.id === "x-queued"), { executorProvider: "6551", providerRole: "primary" });
  value.jobs.push({ id: "x-disabled", platform: "x", status: "paused", pausedReason: "platform_disabled" });
  assert.equal(resumePlatformJobs(value, "x", "platform_risk"), 1);
  assert.equal(value.jobs.find(job => job.id === "x-queued").status, "queued");
  assert.equal(value.jobs.find(job => job.id === "x-queued").executorProvider, null);
  assert.equal(value.jobs.find(job => job.id === "x-queued").providerRole, null);
  assert.equal(value.jobs.find(job => job.id === "x-disabled").status, "paused");
});

test("平台队列汇总分别计算最近一小时成功率", () => {
  const value = state();
  value.jobs.push(
    { id: "x-ok", platform: "x", status: "complete", finishedAt: "2026-08-01T00:50:00.000Z" },
    { id: "x-fail", platform: "x", status: "failed", finishedAt: "2026-08-01T00:55:00.000Z" }
  );
  const summary = platformQueueSummary(value, "x", Date.parse("2026-08-01T01:00:00.000Z"));
  assert.equal(summary.queued, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.recentSuccessRate, 0.5);
});

test("陌生作者回溯按平台限制为每小时二十位", () => {
  const value = state();
  value.sourceRegistry = [{ id: "candidate", status: "candidate" }];
  value.jobs = Array.from({ length: 20 }, (_, index) => ({
    id: `watch-${index}`, platform: "x", targetType: "source_watch", sourceId: "candidate",
    status: "complete", startedAt: "2026-08-01T00:30:00.000Z"
  }));
  const candidate = { platform: "x", targetType: "source_watch", sourceId: "candidate" };
  assert.equal(strangerBackfillAllowed(value, candidate, Date.parse("2026-08-01T01:00:00.000Z")), false);
  assert.equal(strangerBackfillAllowed(value, { ...candidate, platform: "douyin" }, Date.parse("2026-08-01T01:00:00.000Z")), true);
});

test("官方与可信来源不占用陌生作者每小时限额", () => {
  const value = state();
  value.sourceRegistry = [
    { id: "official", status: "trusted", sourceType: "official" },
    { id: "candidate", status: "candidate", sourceType: "peer" }
  ];
  value.jobs = Array.from({ length: 20 }, (_, index) => ({
    id: `official-${index}`, platform: "x", targetType: "source_watch", sourceId: "official",
    status: "complete", startedAt: "2026-08-01T00:30:00.000Z"
  }));
  assert.equal(strangerBackfillAllowed(value, { platform: "x", targetType: "source_watch", sourceId: "candidate" }, Date.parse("2026-08-01T01:00:00.000Z")), true);
});

test("超过七天的排队采集任务标记为过期而不再领取", () => {
  const value = { jobs: [
    { id: "old", status: "queued", requestedAt: "2026-07-20T00:00:00.000Z" },
    { id: "fresh", status: "queued", requestedAt: "2026-08-03T00:00:00.000Z" }
  ] };
  const expired = expireStaleJobs(value, Date.parse("2026-08-04T00:00:00.000Z"));
  assert.deepEqual(expired, ["old"]);
  assert.equal(value.jobs[0].status, "expired");
  assert.equal(value.jobs[1].status, "queued");
});
