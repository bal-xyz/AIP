async function collect(job = {}) {
  const adapter = globalThis.AIPPlatforms.current();
  if (!adapter.authenticated()) {
    return { ok: false, code: "AUTH_REQUIRED", error: `${adapter.id === "douyin" ? "抖音" : "X"} 需要登录，请先完成登录` };
  }
  const result = await adapter.collect(job);
  if (result.posts.length || result.following?.length) {
    return { ok: true, platform: adapter.id, profile: result.profile, posts: result.posts, following: result.following || [] };
  }
  const pageText = String(document.body?.innerText || "");
  if (/验证码|安全验证|访问频繁|操作过于频繁|verify you are human|challenge/i.test(pageText)) {
    return { ok: false, code: "CHALLENGE_REQUIRED", error: "平台要求完成验证或触发访问限制" };
  }
  if (/账号不存在|用户不存在|页面不存在|内容不存在|This account doesn.t exist|Page doesn.t exist/i.test(pageText)) {
    return { ok: false, code: "ACCOUNT_UNAVAILABLE", error: "账号或内容不存在、不可见" };
  }
  if (/没有更多|暂无内容|没有找到|No results|Nothing to see here/i.test(pageText)) {
    return { ok: false, code: "NO_NEW_CONTENT", error: "页面访问成功，但当前没有新内容" };
  }
  const containers = document.querySelectorAll('article[data-testid="tweet"], article, [data-testid="tweet"]').length;
  if (!containers && document.querySelector('[data-testid="primaryColumn"], [data-testid="UserName"], main[role="main"]')) {
    return { ok: false, code: "NO_NEW_CONTENT", error: "X 页面已加载，但当前没有可见的新帖子" };
  }
  return {
    ok: false,
    code: "PARSER_CHANGED",
    error: containers
      ? `X 页面找到 ${containers} 个帖子容器，但未提取到正文或帖子链接；请刷新扩展后重试`
      : "X 页面没有找到帖子节点；请确认已登录并停留在搜索、主页或列表页后重试"
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "AIP_COLLECT") return false;
  collect(message.job).then(sendResponse).catch(error => sendResponse({ ok: false, code: "SCRIPT_ERROR", error: error.message || String(error) }));
  return true;
});

async function isDashboardOrigin() {
  if (location.origin === "http://127.0.0.1:4173" || location.origin === "http://localhost:4173") return true;
  const stored = await chrome.storage.local.get("serverUrl");
  try {
    return new URL(stored.serverUrl).origin === location.origin;
  } catch {
    return false;
  }
}

async function installDashboardBridge() {
  if (!(await isDashboardOrigin())) return;
  function replyToPage(message, response) {
    const runtimeError = chrome.runtime.lastError?.message;
    window.postMessage({
      type: "AIP_EXTENSION_RESPONSE",
      requestId: message.requestId,
      action: message.type,
      ok: Boolean(response?.ok) && !runtimeError,
      error: runtimeError || response?.error || null,
      nodeId: response?.nodeId || null,
      state: response?.state || null
    }, location.origin);
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    if (event.data?.type === "AIP_RUN_QUEUE") {
      chrome.runtime.sendMessage({ type: "AIP_RUN_QUEUE" }, response => replyToPage(event.data, response));
    }
    if (event.data?.type === "AIP_EXTENSION_CONFIG") {
      chrome.runtime.sendMessage(
        { type: "AIP_EXTENSION_CONFIG", config: event.data.config || {} },
        response => replyToPage(event.data, response)
      );
    }
  });
  window.postMessage({ type: "AIP_EXTENSION_READY" }, location.origin);
}

installDashboardBridge().catch(() => {});
