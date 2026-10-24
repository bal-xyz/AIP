import test from "node:test";
import assert from "node:assert/strict";
import { xCollectionSchedule } from "../lib/x-collection-schedule.mjs";

test("北京时间工作日高峰使用较短采集间隔", () => {
  const plan = xCollectionSchedule({}, Date.parse("2026-08-05T01:00:00.000Z"));
  assert.equal(plan.intervalMinutes, 20);
  assert.equal(plan.window, "peak");
});

test("北京时间周末非高峰自动放宽采集间隔", () => {
  const plan = xCollectionSchedule({}, Date.parse("2026-08-08T04:00:00.000Z"));
  assert.equal(plan.intervalMinutes, 180);
  assert.equal(plan.window, "off_peak");
});

test("热点升温时覆盖普通时段计划", () => {
  const plan = xCollectionSchedule({ earlyEvents: [{ stage: "burst", postEvidence: [{ url: "https://x.com/example/status/1" }] }] }, Date.parse("2026-08-04T02:00:00.000Z"));
  assert.equal(plan.intervalMinutes, 15);
  assert.equal(plan.window, "hotspot");
});

test("其他平台的爆款不会改变 X 采集频率", () => {
  const now = Date.parse("2026-08-05T01:00:00.000Z");
  const plan = xCollectionSchedule({
    posts: [{ platform: "douyin", publishedAt: new Date(now - 60_000).toISOString(), quality: { grade: "T3" } }],
    earlyEvents: [{ platform: "douyin", stage: "burst" }]
  }, now);
  assert.notEqual(plan.window, "hotspot");
  assert.equal(plan.intervalMinutes, 20);
});
