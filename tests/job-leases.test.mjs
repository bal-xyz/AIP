import test from "node:test";
import assert from "node:assert/strict";
import { collectionJobKey, collectionRetryState, compareCollectionJobs, enqueueCollectionJob, finishJobLease, leaseJob, recoverExpiredLeases, selectCollectionJobs } from "../lib/job-leases.mjs";

test("采集任务使用稳定业务键阻止重复活跃任务", () => {
  const jobs = [{ id: "existing", targetType: "industry", targetId: "ai", platform: "x", query: "Codex", status: "queued" }];
  const duplicate = { id: "duplicate", targetType: "industry", targetId: "ai", platform: "x", query: "Codex", status: "queued" };
  const differentQuery = { id: "different", targetType: "industry", targetId: "ai", platform: "x", query: "Agent", status: "queued" };

  assert.equal(collectionJobKey(jobs[0]), collectionJobKey(duplicate));
  assert.deepEqual(enqueueCollectionJob(jobs, duplicate), { job: jobs[0], created: false });
  assert.equal(enqueueCollectionJob(jobs, differentQuery).created, true);
  assert.deepEqual(jobs.map(job => job.id), ["existing", "different"]);

  jobs[0].status = "paused";
  assert.equal(enqueueCollectionJob(jobs, duplicate).created, false, "暂停任务恢复前不能继续堆积重复任务");

  const pausedEvent = { id: "event", targetType: "event_track", eventId: "event-1", platform: "x", query: "旧标题", status: "paused" };
  const changedEvent = { id: "changed", targetType: "event_track", eventId: "event-1", platform: "x", query: "新标题", status: "queued" };
  assert.equal(enqueueCollectionJob([pausedEvent], changedEvent).created, false, "实体任务的查询变化不能绕过去重");
});

test("所有采集器共享插队和任务类型优先级", () => {
  const jobs = [
    { id: "industry", targetType: "industry", requestedAt: "2026-07-28T00:00:00.000Z" },
    { id: "creator", targetType: "creator", requestedAt: "2026-07-28T00:01:00.000Z" },
    { id: "boosted", targetType: "industry", queueBoostAt: "2026-07-28T00:02:00.000Z", requestedAt: "2026-07-28T00:02:00.000Z" }
  ];

  assert.deepEqual(jobs.sort(compareCollectionJobs).map(job => job.id), ["boosted", "creator", "industry"]);
});

test("等待时间补偿防止行业搜索长期饥饿，批量领取保留来源和发现配额", () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const source = { id: "source", targetType: "source_watch", requestedAt: "2026-08-08T10:00:00.000Z" };
  const industry = { id: "industry", targetType: "industry", requestedAt: "2026-08-08T06:00:00.000Z" };
  const creator = { id: "creator", targetType: "creator", requestedAt: "2026-08-08T11:59:00.000Z" };

  assert.deepEqual([source, industry].sort((a, b) => compareCollectionJobs(a, b, now)).map(job => job.id), ["industry", "source"]);
  assert.equal(selectCollectionJobs([source, industry, creator], 1, now)[0].id, "creator", "关注博主保持紧急优先级");
  assert.deepEqual(new Set(selectCollectionJobs([source, industry], 2, now).map(job => job.id)), new Set(["source", "industry"]));
});

test("领取任务会设置有限租约和尝试次数", () => {
  const job = { id: "job-1", status: "queued", attempts: 0 };
  leaseJob(job, Date.parse("2026-07-28T00:00:00.000Z"), 60_000);

  assert.equal(job.status, "running");
  assert.equal(job.startedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(job.leaseExpiresAt, "2026-07-28T00:01:00.000Z");
  assert.equal(job.attempts, 1);
  assert.equal(job.maxAttempts, 3);
});

test("过期租约自动重新排队，达到上限后明确失败", () => {
  const jobs = [
    { id: "retry", status: "running", attempts: 1, leaseExpiresAt: "2026-07-28T00:00:00.000Z", executorProvider: "6551", providerRole: "primary" },
    { id: "exhausted", status: "running", attempts: 3, maxAttempts: 3, leaseExpiresAt: "2026-07-28T00:00:00.000Z" },
    { id: "legacy", status: "running", attempts: 1, startedAt: "2026-07-28T00:00:00.000Z" },
    { id: "active", status: "running", attempts: 1, leaseExpiresAt: "2026-07-28T00:10:00.000Z" }
  ];

  const result = recoverExpiredLeases(jobs, Date.parse("2026-07-28T00:05:00.000Z"));

  assert.deepEqual(result, { recovered: 2, exhausted: 1 });
  assert.equal(jobs[0].status, "queued");
  assert.equal(jobs[0].executorProvider, null);
  assert.equal(jobs[0].providerRole, null);
  assert.equal(jobs[1].status, "failed");
  assert.equal(jobs[2].status, "queued");
  assert.equal(jobs[3].status, "running");
});

test("任务完成或明确失败时清除租约", () => {
  const job = { status: "running", leaseExpiresAt: "2026-07-28T00:01:00.000Z" };
  finishJobLease(job);
  assert.equal(job.leaseExpiresAt, null);
});

test("采集失败按十五分钟到六小时逐级退避，成功后恢复正常频率", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const failures = Array.from({ length: 4 }, (_, index) => ({
    status: "failed",
    finishedAt: new Date(now - index * 60_000).toISOString()
  }));

  const firstFailure = collectionRetryState(failures.slice(0, 1), 60 * 60_000, now);
  assert.equal(firstFailure.delayMs, 15 * 60_000);
  assert.equal(firstFailure.due, false);
  assert.equal(collectionRetryState(failures.slice(0, 1), 60 * 60_000, now + 15 * 60_000).due, true);
  assert.equal(collectionRetryState(failures.slice(0, 2), 60 * 60_000, now).delayMs, 30 * 60_000);
  assert.equal(collectionRetryState(failures.slice(0, 3), 60 * 60_000, now).delayMs, 60 * 60_000);
  assert.equal(collectionRetryState(failures, 60 * 60_000, now).delayMs, 6 * 60 * 60_000);

  const recovered = collectionRetryState([
    { status: "complete", finishedAt: new Date(now - 30 * 60_000).toISOString() },
    { status: "failed", finishedAt: new Date(now - 60 * 60_000).toISOString() }
  ], 60 * 60_000, now);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.due, false);
  assert.equal(recovered.nextAt, "2026-07-31T12:30:00.000Z");
});
