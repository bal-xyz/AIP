import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", error => error.code === "EPERM" ? resolve(null) : reject(error));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("测试服务器没有启动");
}

async function request(base, path, options = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json();
  assert.equal(response.status, expected, JSON.stringify(payload));
  return payload;
}

const collectorHeaders = {
  "Authorization": "Bearer test-collector",
  "X-AIP-Node-ID": "test-node"
};

test("双平台任务使用节点租约提交，仪表盘只读取真实采集结果", async t => {
  const port = await freePort();
  if (port === null) return t.skip("当前沙箱禁止监听本机端口");
  const directory = await mkdtemp(join(tmpdir(), "aip-monitor-server-"));
  const statePath = join(directory, "state.json");
  const databasePath = join(directory, "state.sqlite");
  await writeFile(statePath, JSON.stringify({
    version: 6,
    collector: { status: "waiting_extension", lastRunAt: null, lastError: null },
    creators: [], industries: [], jobs: [], posts: [], snapshots: []
  }));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      AIP_PORT: String(port),
      AIP_STATE_PATH: statePath,
      AIP_DB_PATH: databasePath,
      AIP_COLLECTOR_TOKEN: "test-collector"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(base);

  const followed = await request(base, "/api/follows", {
    method: "POST",
    body: JSON.stringify({ platform: "x", handle: "@truth", displayName: "真实账号" })
  }, 201);
  assert.equal(followed.item.platform, "x");

  const next = await request(base, "/api/extension/jobs/next", { headers: collectorHeaders });
  assert.equal(next.job.handle, "@truth");
  assert.ok(next.job.leaseNonce);

  await request(base, "/api/extension/result", {
    method: "POST",
    headers: collectorHeaders,
    body: JSON.stringify({
      jobId: next.job.id,
      leaseNonce: next.job.leaseNonce,
      platform: "x",
      capturedAt: new Date().toISOString(),
      profile: { displayName: "真实账号", followers: 10000 },
      posts: [{
        id: "real-1",
        handle: "@truth",
        author: "真实账号",
        text: "OpenAI 发布新的 Codex 能力",
        url: "https://x.com/truth/status/1",
        likes: 900,
        replies: 50,
        reposts: 220,
        bookmarksAvailable: false
      }]
    })
  });

  const dashboard = await request(base, "/api/dashboard");
  assert.equal(dashboard.followedPosts.length, 1);
  assert.equal(dashboard.followedPosts[0].source, "x_browser_dom");
  assert.equal(dashboard.followedPosts[0].bookmarks, null);
  assert.equal(dashboard.followedPosts[0].aiRelevant, true);
  assert.equal(dashboard.hotPosts.length, 0, "历史样本不足时不能伪造正式热帖");

  const hotspotGraph = await request(base, "/api/hotspot-graph");
  assert.equal(hotspotGraph.window, "72h");
  assert.equal(hotspotGraph.summary.formalHotspotCount, 0);
  assert.ok(Array.isArray(hotspotGraph.clusters));
  assert.ok(Array.isArray(hotspotGraph.standalones));
  assert.ok(Array.isArray(hotspotGraph.coverage.coverageWindows));

  const spoofed = await request(base, "/api/extension/result", {
    method: "POST",
    headers: { ...collectorHeaders, "X-AIP-Node-ID": "other-node" },
    body: JSON.stringify({
      jobId: next.job.id,
      leaseNonce: next.job.leaseNonce,
      platform: "x",
      capturedAt: new Date().toISOString(),
      posts: [{ id: "conflict", text: "不同载荷", likes: 1 }]
    })
  }, 401);
  assert.match(spoofed.error, /令牌/);

  const late = await request(base, "/api/extension/result", {
    method: "POST",
    headers: collectorHeaders,
    body: JSON.stringify({
      jobId: next.job.id,
      leaseNonce: next.job.leaseNonce,
      platform: "douyin",
      capturedAt: new Date().toISOString(),
      posts: [{ id: "conflict", text: "不同载荷", likes: 1 }]
    })
  }, 409);
  assert.match(late.error, /不同载荷|租约/);
});

test("模型接口保存路由但不接收明文密钥", async t => {
  const port = await freePort();
  if (port === null) return t.skip("当前沙箱禁止监听本机端口");
  const directory = await mkdtemp(join(tmpdir(), "aip-monitor-model-"));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      AIP_PORT: String(port),
      AIP_STATE_PATH: join(directory, "missing.json"),
      AIP_DB_PATH: join(directory, "state.sqlite"),
      AIP_COLLECTOR_TOKEN: "test-collector"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(base);
  const saved = await request(base, "/api/model-routes", {
    method: "PUT",
    body: JSON.stringify({
      taskType: "l1",
      provider: "兼容接口",
      model: "example-chat",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "EXAMPLE_API_KEY",
      apiStyle: "chat_completions",
      priceVersion: "2026-07",
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 4,
      maxInputTokens: 8000,
      maxOutputTokens: 1200,
      enabled: true
    })
  });
  assert.equal(saved.item.apiKeyEnv, "EXAMPLE_API_KEY");
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  const budget = await request(base, "/api/analysis/budget");
  assert.equal(budget.versions, 0);
});

test("生产认证通过登录会话与 CSRF 令牌保护管理写接口", async t => {
  const port = await freePort();
  if (port === null) return t.skip("当前沙箱禁止监听本机端口");
  const directory = await mkdtemp(join(tmpdir(), "aip-monitor-auth-"));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      AIP_PORT: String(port),
      AIP_STATE_PATH: join(directory, "missing.json"),
      AIP_DB_PATH: join(directory, "state.sqlite"),
      AIP_REQUIRE_AUTH: "1",
      AIP_ADMIN_PASSWORD: "admin-password",
      AIP_COLLECTOR_TOKEN: "test-collector"
    },
    stdio: "ignore"
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(base);

  const denied = await fetch(`${base}/api/dashboard`);
  assert.equal(denied.status, 401);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "admin-password" })
  });
  assert.equal(login.status, 200);
  const loginPayload = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.ok(loginPayload.csrf);

  const readable = await fetch(`${base}/api/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(readable.status, 200);
  const missingCsrf = await fetch(`${base}/api/follows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ platform: "x", handle: "@blocked" })
  });
  assert.equal(missingCsrf.status, 403);
  const written = await fetch(`${base}/api/follows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginPayload.csrf },
    body: JSON.stringify({ platform: "x", handle: "@allowed" })
  });
  assert.equal(written.status, 201);
});
