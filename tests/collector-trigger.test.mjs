import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("手动采集同时创建服务器任务并等待扩展真实回执", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(html, /id="collectButton"/);
  assert.match(app, /api\("\/collect", \{ method: "POST"/);
  assert.match(app, /extensionRequest\("AIP_RUN_QUEUE"\)/);
  assert.match(app, /AIP_EXTENSION_RESPONSE/);
  assert.match(app, /本地采集扩展未响应/);
  assert.match(content, /type: "AIP_EXTENSION_RESPONSE"/);
  assert.match(content, /requestId: message\.requestId/);
});

test("扩展配置只有心跳认证成功后才回执并启动队列", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const configBranch = background.slice(background.indexOf('message?.type === "AIP_EXTENSION_CONFIG"'));

  assert.match(configBranch, /chrome\.storage\.local\.set/);
  assert.match(configBranch, /request\("\/extension\/heartbeat"/);
  assert.match(configBranch, /sendResponse\?\.\(\{ ok: true, nodeId: heartbeat\.nodeId \}\)/);
  assert.match(configBranch, /runQueue\(\)/);
});

test("扩展使用页面就绪条件、阶段进度和结构化错误而非固定五秒等待", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(background, /waitForContent\(tab\.id, platform\)/);
  assert.doesNotMatch(background, /await wait\(5000\)/);
  for (const phase of ["opening_page", "waiting_content", "scrolling", "detail_enrichment", "submitting"]) {
    assert.match(background, new RegExp(`progress\\(job, "${phase}"\\)`));
  }
  for (const code of ["NO_NEW_CONTENT", "AUTH_REQUIRED", "CHALLENGE_REQUIRED", "ACCOUNT_UNAVAILABLE", "PARSER_CHANGED", "PAGE_TIMEOUT"]) {
    assert.match(`${background}\n${content}`, new RegExp(code));
  }
  assert.match(background, /let tab = null;\s*try \{\s*await progress\(job, "opening_page"\)/s);
  assert.match(background, /Number\.isFinite\(Date\.parse\(post\.publishedAt\)\)/);
});

test("X 采集任务复用固定标签页，抖音任务仍独立关闭", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(background, /async function collectorTab\(platform, url\)/);
  assert.match(background, /chrome\.storage\.local\.get\(\["xCollectorTabId"\]\)/);
  assert.match(background, /chrome\.tabs\.update\(tab\.id, \{ url, active: false \}\)/);
  assert.match(background, /if \(platform !== "x" && tab\?\.id\) await chrome\.tabs\.remove/);
});

test("扩展执行队列时保持 MV3 后台服务存活", () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /chrome\.runtime\.getPlatformInfo\(\)/);
  assert.match(background, /const stopKeepAlive = keepServiceWorkerAlive\(\)/);
  assert.match(background, /stopKeepAlive\(\)/);
});

test("扩展请求挂起时会中止网络连接并释放超时计时器", async () => {
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const start = background.indexOf("async function request(");
  const requestSource = background.slice(start, background.indexOf("\nasync function registerDashboardBridge", start));
  let timeoutCleared = false;
  const createRequest = new Function("settings", "fetch", "AbortController", "setTimeout", "clearTimeout", `${requestSource}; return request;`);
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false, listeners: [] };
    }
    abort() {
      this.signal.aborted = true;
      for (const listener of this.signal.listeners) listener();
    }
  }
  const request = createRequest(
    async () => ({ serverUrl: "http://127.0.0.1:4173", collectorToken: "token", nodeId: "node" }),
    (_url, options) => new Promise((_resolve, reject) => {
      options.signal.listeners.push(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
    FakeAbortController,
    callback => { queueMicrotask(callback); return 1; },
    () => { timeoutCleared = true; }
  );

  await assert.rejects(request("/extension/heartbeat"), error => error.code === "REQUEST_TIMEOUT");
  assert.equal(timeoutCleared, true);
});

test("任务进度、结果和失败上报拒绝跨平台载荷", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.equal((server.match(/PLATFORM_MISMATCH/g) || []).length, 3);
  assert.match(server, /followers: input\.profile\?\.followers != null && Number\.isFinite\(Number\(input\.profile\.followers\)\)/);
});

test("候选作者转重点关注后使用十五分钟频率并保留平台", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const start = server.indexOf('url.pathname.startsWith("/api/candidates/")');
  const branch = server.slice(start, server.indexOf("\n  if (", start + 1));
  assert.match(branch, /platform: candidate\.platform \|\| "x"|const platform = candidate\.platform \|\| "x"/);
  assert.match(branch, /frequency: "15分钟"/);
});

test("扩展配置页显示真实队列结果和错误", () => {
  const options = readFileSync(new URL("../extension/options.js", import.meta.url), "utf8");
  assert.match(options, /!response\?\.ok/);
  assert.match(options, /采集失败/);
  assert.match(options, /response\.processed/);
});

test("手动采集保留运行中任务，旧规则默认覆盖双平台", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const collectStart = server.indexOf('url.pathname === "/api/collect"');
  const collectBranch = server.slice(collectStart, server.indexOf("\n  if (", collectStart + 1));

  assert.match(collectBranch, /enqueueDueJobs\(state, input\.targetId \|\| true\)/);
  assert.doesNotMatch(collectBranch, /state\.jobs\s*=\s*state\.jobs\.filter/);
  assert.match(server, /:\s*\["x", "douyin"\]/);
});

test("平台开关同时约束任务生成、领取和管理页面", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");

  assert.match(server, /url\.pathname === "\/api\/collection-settings"/);
  assert.match(server, /platformEnabled\(state, creator\.platform \|\| "x"\)/);
  assert.match(server, /value\.status === "queued" && platformEnabled\(state, value\.platform \|\| "x"\)/);
  assert.match(server, /job\.status = "paused"/);
  assert.match(app, /settingsCard\("采集平台"/);
  assert.match(app, /\[\["x", "X"\], \["douyin", "抖音"\]\]/);
  assert.match(app, /api\("\/collection-settings", \{ method: "PUT"/);
  assert.match(app, /new EventSource\("\/api\/events"\)/);
  assert.match(app, /setInterval\(load, 30_000\)/);
});

test("6551 主采集器异常时允许已配置的浏览器副采集器接管", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /secondaryProvider === "extension" && primaryProvider !== "extension"/);
  assert.match(server, /\["waiting_extension", "degraded", "error", "auth_required"\]/);
});

test("6551 配额不足时关注任务重新排队并切换浏览器扩展", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /insufficient\\s\+quota/);
  assert.match(server, /6551 配额不足，已切换浏览器扩展低频接管/);
  assert.match(server, /job\.status = "queued"/);
  assert.match(server, /job\.executorProvider = "extension"/);
  assert.match(server, /state\.collectionSettings\?\.xSecondaryProvider === "extension"/);
  assert.match(server, /providerBlockedUntil/);
});

test("6551 配额不足不会继续让云端采集器领取任务", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /providerBlockedUntil = new Date\(Date\.now\(\) \+ 30 \* 60_000\)/);
  assert.match(server, /if \(Number\.isFinite\(providerBlockedUntil\) && providerBlockedUntil > Date\.now\(\)\) return/);
  assert.match(server, /quotaBlockActive/);
});

test("服务启动时会把最近的配额失败任务重新排队", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /reconcileRecentQuotaFailures/);
  assert.match(server, /finishedAt \|\| job\.startedAt \|\| job\.requestedAt/);
  assert.match(server, /errorCode !== "6551_QUOTA_EXHAUSTED"/);
  assert.match(server, /const initialState = await readState\(\)/);
});

test("6551 采集器停用后不再领取任务并执行请求速率限制", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /registryItem\.enabled === false/);
  assert.match(server, /requestsPerMinute/);
  assert.match(server, /externalCollectorRequestTimes/);
});

test("6551 领取任务后清除一次性插队标记", () => {
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /job\.queueBoostAt = null;\s+leaseJob\(job, Date\.now\(\), undefined, externalCollectorNodeId\)/);
});

test("采集状态并发刷新时在接口返回后替换旧面板，避免重复显示", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const collectorBranch = app.slice(app.indexOf('state.settingsTab === "collector"'), app.indexOf('state.settingsTab === "notifications"'));

  assert.ok(collectorBranch.indexOf('await api("/collection-settings")') < collectorBranch.indexOf("target.replaceChildren()"));
});

test("云端看板只为已配置的加密服务域名注册扩展桥接", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const content = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
  const options = readFileSync(new URL("../extension/options.js", import.meta.url), "utf8");

  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(!manifest.content_scripts[0].matches.includes("https://*/*"));
  assert.match(background, /registerContentScripts/);
  assert.match(background, /matches: \[`\$\{url\.origin\}\/\*`\]/);
  assert.match(content, /new URL\(stored\.serverUrl\)\.origin === location\.origin/);
  assert.match(options, /type: "AIP_EXTENSION_CONFIG"/);
});
