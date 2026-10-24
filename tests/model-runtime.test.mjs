import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../lib/database.mjs";
import { ModelRuntime, inputTokenUpperBound, validateL1, validateModelBaseUrl } from "../lib/model-runtime.mjs";

function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "aip-model-runtime-"));
  return {
    directory,
    database: new StateDatabase(join(directory, "test.sqlite")),
    close() {
      this.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const validL1 = {
  summary: "相对作者基线显著抬升。",
  factors: [{ type: "钩子", explanation: "标题给出明确结果", evidence: "正文首句包含结果" }],
  confidence: 0.8,
  caveats: [],
  life: "时效",
  life_reason: "绑定产品发布",
  follow_window_hours: 24
};

test("一级快评严格拒绝额外字段和缺少证据的因素", () => {
  assert.equal(validateL1(validL1), validL1);
  assert.throws(() => validateL1({ ...validL1, extra: true }));
  assert.throws(() => validateL1({ ...validL1, factors: [{ type: "钩子" }] }));
});

test("模型地址只允许 HTTPS 或精确本机 HTTP", () => {
  assert.equal(validateModelBaseUrl("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.throws(() => validateModelBaseUrl("http://localhost.evil.example/v1"));
  assert.throws(() => validateModelBaseUrl("http://127.0.0.1.evil.example/v1"));
  assert.throws(() => validateModelBaseUrl("http://localhost@evil.example/v1"));
  assert.ok(validateModelBaseUrl("https://api.example.com/v1").startsWith("https://"));
});

test("输入令牌保守上界至少覆盖完整 UTF-8 载荷和消息封装", () => {
  const system = "系统提示";
  const user = JSON.stringify({ text: "中文 evidence" });
  assert.equal(inputTokenUpperBound(system, user), Buffer.byteLength(system) + Buffer.byteLength(user) + 256);
});

test("预算和模型价格统一按人民币返回", () => {
  const fixture = databaseFixture();
  try {
    const runtime = new ModelRuntime(fixture.database, { dailyCny: 5 });
    const budget = runtime.budgetStatus();
    assert.equal(budget.currency, "CNY");
    assert.equal(budget.dailyCny, 5);
  } finally { fixture.close(); }
});

test("模型档案可复用到多个任务路由", () => {
  const fixture = databaseFixture();
  try {
    const runtime = new ModelRuntime(fixture.database);
    const profile = runtime.upsertProfile({
      name: "低成本通用模型", provider: "test", model: "cheap-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxInputTokens: 2000, maxOutputTokens: 500, enabled: true
    });
    runtime.upsertRoute({ taskType: "relevance", profileId: profile.id, provider: "legacy", model: "legacy", baseUrl: "https://api.example.com/v1", apiKeyEnv: "TEST_MODEL_KEY", priceVersion: "legacy", inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 1000, maxOutputTokens: 200, enabled: true });
    runtime.upsertRoute({ taskType: "l1", profileId: profile.id, provider: "legacy", model: "legacy", baseUrl: "https://api.example.com/v1", apiKeyEnv: "TEST_MODEL_KEY", priceVersion: "legacy", inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 1000, maxOutputTokens: 200, enabled: true });
    const routes = runtime.routes();
    assert.equal(routes.find(item => item.taskType === "relevance").model, "cheap-chat");
    assert.equal(routes.find(item => item.taskType === "l1").profileId, profile.id);
  } finally { fixture.close(); }
});

test("模型连接测试会校验返回 JSON，而不是只接受 HTTP 200", async () => {
  const fixture = databaseFixture();
  const previousKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = "test";
  try {
    const runtime = new ModelRuntime(fixture.database, {
      fetch: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] })
      })
    });
    const profile = runtime.upsertProfile({
      name: "测试模型", provider: "test", model: "test-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 1000, maxOutputTokens: 100, enabled: true
    });
    const result = await runtime.testProfile(profile.id);
    assert.equal(result.ok, true);
    assert.equal(fixture.database.db.prepare("SELECT last_test_status FROM model_profiles WHERE id=?").get(profile.id).last_test_status, "ok");
  } finally {
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    fixture.close();
  }
});

test("模型连接测试拒绝空 JSON 或错误测试结果", async () => {
  const fixture = databaseFixture();
  const previousKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = "test";
  try {
    const runtime = new ModelRuntime(fixture.database, {
      fetch: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "" } }] })
      })
    });
    const profile = runtime.upsertProfile({
      name: "空响应模型", provider: "test", model: "test-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 1000, maxOutputTokens: 100, enabled: true
    });
    await assert.rejects(() => runtime.testProfile(profile.id), /模型返回格式不符合测试要求/);
  } finally {
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    fixture.close();
  }
});

test("模型任务按内容版本幂等且结算到北京时间日预算", async () => {
  const fixture = databaseFixture();
  const previousKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = "test";
  try {
    const runtime = new ModelRuntime(fixture.database, {
      dailyUsd: 1,
      dailyVersions: 2,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(validL1) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        })
      })
    });
    runtime.upsertRoute({
      taskType: "l1",
      provider: "test",
      model: "test-chat",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY",
      apiStyle: "chat_completions",
      priceVersion: "test-v1",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maxInputTokens: 2000,
      maxOutputTokens: 500,
      enabled: true
    });
    const first = runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "p1", versionKey: "v1" });
    const duplicate = runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "p1", versionKey: "v1" });
    assert.equal(first.id, duplicate.id);
    const result = await runtime.runNext(() => ({ post: { id: "p1" } }));
    assert.equal(result.status, "complete");
    assert.equal(runtime.budgetStatus().versions, 1);
    assert.equal(fixture.database.db.prepare("SELECT status FROM analysis_tasks WHERE id=?").get(first.id).status, "complete");
  } finally {
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    fixture.close();
  }
});

test("失败任务重新激活时保留尝试次数并使用下一条用量流水", () => {
  const fixture = databaseFixture();
  try {
    const runtime = new ModelRuntime(fixture.database);
    runtime.upsertRoute({
      taskType: "l1", provider: "test", model: "test-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 1000, maxOutputTokens: 100,
      dailyBudgetCny: 5, dailyVersions: 100, enabled: true
    });
    const task = runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "retry-post", versionKey: "v1" });
    fixture.database.db.prepare("UPDATE analysis_tasks SET status='failed', attempts=1 WHERE id=?").run(task.id);
    fixture.database.db.prepare("INSERT INTO usage_ledger(id, budget_day, task_id, attempt, reserved_usd, status, created_at) VALUES('ledger-1', '2026-08-09', ?, 1, 0.01, 'settled', '2026-08-09T00:00:00.000Z')").run(task.id);

    const requeued = runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "retry-post", versionKey: "v1", manualTriggered: true });
    assert.equal(requeued.attempts, 1);
    const route = runtime.routes().find(item => item.taskType === "l1");
    const reservation = runtime.reserve(requeued, route);
    assert.equal(reservation.attempt, 2);
    assert.deepEqual(fixture.database.db.prepare("SELECT attempt FROM usage_ledger WHERE task_id=? ORDER BY attempt").all(task.id).map(row => row.attempt), [1, 2]);
  } finally { fixture.close(); }
});

test("未配置的高优先级任务不会阻塞可运行任务，手动确认可更新既有队列", async () => {
  const fixture = databaseFixture();
  const previousKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = "test";
  try {
    const runtime = new ModelRuntime(fixture.database, {
      dailyUsd: 1,
      fetch: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(validL1) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      })
    });
    runtime.upsertRoute({
      taskType: "l1", provider: "test", model: "test-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 2000, maxOutputTokens: 100, enabled: true
    });
    const l2 = runtime.enqueue({ taskType: "l2", entityType: "post", entityId: "p2", versionKey: "v1", priority: 40 });
    runtime.enqueue({ taskType: "l2", entityType: "post", entityId: "p2", versionKey: "v1", priority: 40, manualOverride: true });
    runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "p1", versionKey: "v1", priority: 20 });
    assert.equal(fixture.database.db.prepare("SELECT manual_override FROM analysis_tasks WHERE id=?").get(l2.id).manual_override, 1);
    const result = await runtime.runNext(() => ({ post: { id: "p1" } }));
    assert.equal(result.task.task_type, "l1");
    assert.equal(result.status, "complete");
  } finally {
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    fixture.close();
  }
});

test("执行前会校验密钥和预算，不满足条件的任务进入延后而不是运行中", async () => {
  const fixture = databaseFixture();
  const previousKey = process.env.TEST_MODEL_KEY;
  process.env.TEST_MODEL_KEY = "test";
  try {
    const runtime = new ModelRuntime(fixture.database, {
      dailyUsd: 0.01,
      dailyVersions: 1,
      fetch: async () => { throw new Error("不应发送模型请求"); }
    });
    runtime.upsertRoute({
      taskType: "l1", provider: "test", model: "test-chat", baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "TEST_MODEL_KEY", apiStyle: "chat_completions", priceVersion: "test-v1",
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxInputTokens: 10000, maxOutputTokens: 1000, dailyBudgetCny: 0.01, enabled: true
    });
    assert.equal(runtime.executionReadiness("l1").ready, false);
    const task = runtime.enqueue({ taskType: "l1", entityType: "post", entityId: "p-budget", versionKey: "v1" });
    const result = await runtime.runNext(() => ({ post: { id: "p-budget" } }));
    assert.equal(result.status, "deferred");
    const stored = fixture.database.db.prepare("SELECT status, status_reason FROM analysis_tasks WHERE id=?").get(task.id);
    assert.equal(stored.status, "deferred");
    assert.equal(stored.status_reason, "等待预算");
  } finally {
    if (previousKey === undefined) delete process.env.TEST_MODEL_KEY;
    else process.env.TEST_MODEL_KEY = previousKey;
    fixture.close();
  }
});
