let busy = false;

async function settings() {
  const stored = await chrome.storage.local.get(["serverUrl", "collectorToken", "nodeId"]);
  if (!stored.nodeId) {
    stored.nodeId = crypto.randomUUID();
    await chrome.storage.local.set({ nodeId: stored.nodeId });
  }
  return {
    serverUrl: String(stored.serverUrl || "http://127.0.0.1:4173").replace(/\/+$/, ""),
    collectorToken: String(stored.collectorToken || "local-dev-collector"),
    nodeId: stored.nodeId
  };
}

async function request(path, options = {}) {
  const config = await settings();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${config.serverUrl}/api${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.collectorToken}`,
        "X-AIP-Node-ID": config.nodeId,
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { code: payload.code, status: response.status });
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("采集服务请求超时"), { code: "REQUEST_TIMEOUT" });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function registerDashboardBridge(serverUrl) {
  const scriptId = "aip-dashboard-bridge";
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
  if (!serverUrl) return;
  const url = new URL(serverUrl);
  if (url.protocol !== "https:") return;
  await chrome.scripting.registerContentScripts([{
    id: scriptId,
    matches: [`${url.origin}/*`],
    js: ["content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function keepServiceWorkerAlive() {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  return () => clearInterval(timer);
}

async function waitForTab(tabId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await wait(600);
  }
  throw new Error("平台页面加载超时");
}

async function collectorTab(platform, url) {
  if (platform !== "x") return chrome.tabs.create({ url, active: false });
  const stored = await chrome.storage.local.get(["xCollectorTabId"]);
  let tab = null;
  if (stored.xCollectorTabId) {
    try { tab = await chrome.tabs.get(Number(stored.xCollectorTabId)); } catch { tab = null; }
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false });
    await chrome.storage.local.set({ xCollectorTabId: tab.id });
    return tab;
  }
  await chrome.tabs.update(tab.id, { url, active: false });
  return tab;
}

async function progress(job, phase) {
  return request("/extension/progress", {
    method: "POST",
    body: JSON.stringify({ jobId: job.id, leaseNonce: job.leaseNonce, platform: job.platform || "x", phase })
  });
}

async function pageReadiness(tabId, platform) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [platform],
    func: currentPlatform => {
      const text = String(document.body?.innerText || "");
      if (/验证码|安全验证|访问频繁|操作过于频繁|verify you are human|challenge/i.test(text)) {
        return { ready: false, code: "CHALLENGE_REQUIRED", error: "平台要求完成验证或触发访问限制" };
      }
      if (/账号不存在|用户不存在|页面不存在|内容不存在|This account doesn.t exist|Page doesn.t exist/i.test(text)) {
        return { ready: false, code: "ACCOUNT_UNAVAILABLE", error: "账号或内容不存在、不可见" };
      }
      const selector = currentPlatform === "douyin"
        ? (/\/(?:video|note)\/\d+/.test(location.pathname)
          ? 'meta[name="description"], meta[property="og:description"], [data-e2e], h1'
          : 'a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="], [data-aweme-id], [data-e2e="search-result"], script#RENDER_DATA')
        : 'article[data-testid="tweet"], article, [data-testid="tweet"]';
      const hasPosts = Boolean(document.querySelector(selector));
      const hasXShell = currentPlatform !== "douyin" && Boolean(document.querySelector('[data-testid="primaryColumn"], [data-testid="UserName"], main[role="main"]'));
      return { ready: hasPosts, shellReady: hasXShell };
    }
  });
  return result || { ready: false };
}

async function waitForContent(tabId, platform, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await pageReadiness(tabId, platform);
    if (state.code) throw Object.assign(new Error(state.error), { code: state.code });
    if (state.ready) return;
    // X 的空账号页/无新帖页可能没有 article，但主内容区已经完成加载。
    // 给动态列表一个短暂稳定窗口，避免把“暂无新帖”误记为页面超时。
    if (state.shellReady && Date.now() - start >= 5000) return;
    await wait(600);
  }
  throw Object.assign(new Error("平台页面内容等待超时"), { code: "PAGE_TIMEOUT" });
}

function jobUrl(job) {
  if (job.targetUrl) return job.targetUrl;
  const platform = job.platform || "x";
  if (platform === "douyin") {
    if (["creator", "source_watch", "creator_backfill", "following_import"].includes(job.targetType)) {
      if (/^https?:\/\//.test(job.profileUrl || job.handle || "")) return job.profileUrl || job.handle;
      return `https://www.douyin.com/user/${encodeURIComponent(String(job.platformAuthorId || job.handle || "").replace(/^@/, ""))}`;
    }
    return `https://www.douyin.com/search/${encodeURIComponent(job.query || job.industry || "人工智能")}`;
  }
  if (["creator", "source_watch", "creator_backfill", "following_import"].includes(job.targetType)) {
    return `https://x.com/${String(job.handle || "").replace(/^@/, "")}`;
  }
  return `https://x.com/search?q=${encodeURIComponent(job.query || job.industry || "AI")}&src=typed_query&f=live`;
}

async function collectJob(job) {
  const platform = job.platform || "x";
  let tab = null;
  try {
    await progress(job, "opening_page");
    tab = await collectorTab(platform, jobUrl(job));
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await waitForTab(tab.id);
        await progress(job, "waiting_content");
        await waitForContent(tab.id, platform);
        await progress(job, "scrolling");
        const result = await chrome.tabs.sendMessage(tab.id, { type: "AIP_COLLECT", job });
        if (!result?.ok) throw Object.assign(new Error(result?.error || "页面中没有读取到作品"), { code: result?.code });
        await progress(job, "detail_enrichment");
        const posts = platform === "douyin" ? await enrichDouyinPosts(job, result.posts || []) : (result.posts || []);
        await progress(job, "submitting");
        await request("/extension/result", {
          method: "POST",
          body: JSON.stringify({
            jobId: job.id,
            leaseNonce: job.leaseNonce,
            platform: result.platform || job.platform || "x",
            capturedAt: new Date().toISOString(),
            profile: result.profile,
            posts,
            following: result.following || []
          })
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const transient = ["PAGE_TIMEOUT", "PARSER_CHANGED"].includes(error?.code);
        if (!transient || attempt === 1) throw error;
        await wait(2500);
      }
    }
    if (lastError) throw lastError;
  } catch (error) {
    await request("/extension/fail", {
      method: "POST",
      body: JSON.stringify({ jobId: job.id, leaseNonce: job.leaseNonce, platform, code: error.code || "COLLECT_FAILED", error: error.message || String(error) })
    }).catch(() => {});
  } finally {
    // X（平台）使用固定采集页，保留登录态与页面缓存；抖音详情页仍按任务关闭。
    if (platform !== "x" && tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function enrichDouyinPosts(job, posts) {
  const enriched = [];
  for (const post of posts.slice(0, Number(job.limit || 20))) {
    if (post.publishedAt && post.likes !== null && post.likes !== undefined) {
      enriched.push(post);
      continue;
    }
    const detailTab = await chrome.tabs.create({ url: post.url, active: false });
    try {
      await waitForTab(detailTab.id, 30000);
      await waitForContent(detailTab.id, "douyin", 20000);
      const detail = await chrome.tabs.sendMessage(detailTab.id, { type: "AIP_COLLECT", job: { ...job, targetType: "post_detail", limit: 1 } });
      const match = detail?.posts?.find(item => String(item.id) === String(post.id));
      enriched.push(match ? { ...post, ...match } : post);
    } catch {
      enriched.push(post);
    } finally {
      await chrome.tabs.remove(detailTab.id).catch(() => {});
    }
    await progress(job, "detail_enrichment");
  }
  const cutoff = job.backfillDays ? Date.now() - Number(job.backfillDays) * 86_400_000 : null;
  return enriched.filter(post => !cutoff || (Number.isFinite(Date.parse(post.publishedAt)) && Date.parse(post.publishedAt) >= cutoff));
}

async function runQueue() {
  if (busy) return { ok: true, state: "already_running" };
  busy = true;
  const stopKeepAlive = keepServiceWorkerAlive();
  try {
    const heartbeat = await request("/extension/heartbeat", { method: "POST", body: "{}" });
    let processed = 0;
    for (let index = 0; index < 12; index += 1) {
      const { job } = await request("/extension/jobs/next");
      if (!job) break;
      await collectJob(job);
      processed += 1;
      await wait(1200);
    }
    return { ok: true, nodeId: heartbeat.nodeId, state: "completed", processed };
  } catch (error) {
    console.warn("AIP collector unavailable", error);
    return { ok: false, error: error.message || String(error), code: error.code || null };
  } finally {
    stopKeepAlive();
    busy = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("aip-monitor", { periodInMinutes: 1 });
  settings().then(config => registerDashboardBridge(config.serverUrl)).catch(() => {});
  runQueue();
});
chrome.runtime.onStartup.addListener(() => {
  settings().then(config => registerDashboardBridge(config.serverUrl)).catch(() => {});
  runQueue();
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "aip-monitor") runQueue(); });
chrome.action.onClicked.addListener(runQueue);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AIP_RUN_QUEUE") {
    (async () => {
      const result = await runQueue();
      sendResponse?.(result);
    })().catch(error => sendResponse?.({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "AIP_EXTENSION_CONFIG") {
    const config = message.config || {};
    (async () => {
      if (config.serverUrl) {
        const url = new URL(config.serverUrl);
        if (url.protocol === "https:") {
          const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
          if (!granted) throw new Error("没有获得云端服务地址访问权限");
        }
      }
      await chrome.storage.local.set({
        ...(config.serverUrl ? { serverUrl: config.serverUrl } : {}),
        ...(config.collectorToken ? { collectorToken: config.collectorToken } : {}),
        ...(config.nodeId ? { nodeId: config.nodeId } : {})
      });
      await registerDashboardBridge(config.serverUrl || (await settings()).serverUrl);
      const heartbeat = await request("/extension/heartbeat", { method: "POST", body: "{}" });
      sendResponse?.({ ok: true, nodeId: heartbeat.nodeId });
      runQueue();
    })().catch(error => sendResponse?.({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});
