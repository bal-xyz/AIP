const $ = selector => document.querySelector(selector);

async function load() {
  const stored = await chrome.storage.local.get(["serverUrl", "collectorToken", "nodeId"]);
  $("#serverUrl").value = stored.serverUrl || "http://127.0.0.1:4173";
  $("#collectorToken").value = stored.collectorToken || "local-dev-collector";
  $("#nodeId").value = stored.nodeId || crypto.randomUUID();
}

async function save() {
  const serverUrl = $("#serverUrl").value.trim().replace(/\/+$/, "");
  const collectorToken = $("#collectorToken").value.trim();
  const nodeId = $("#nodeId").value.trim();
  const url = new URL(serverUrl);
  if (!collectorToken || !nodeId) throw new Error("请填写节点标识和采集令牌");
  if (url.protocol === "https:") {
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) throw new Error("未获得云端服务地址访问权限");
  } else if (!(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("非本机服务必须使用 HTTPS");
  }
  const response = await chrome.runtime.sendMessage({
    type: "AIP_EXTENSION_CONFIG",
    config: { serverUrl, collectorToken, nodeId }
  });
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有返回认证结果");
  $("#status").textContent = "配置已保存，节点认证成功";
}

$("#save").addEventListener("click", () => save().catch(error => { $("#status").textContent = error.message; }));
$("#run").addEventListener("click", () => {
  $("#status").textContent = "正在执行采集队列…";
  chrome.runtime.sendMessage({ type: "AIP_RUN_QUEUE" }, response => {
    const runtimeError = chrome.runtime.lastError?.message;
    if (runtimeError || !response?.ok) {
      $("#status").textContent = `采集失败：${runtimeError || response?.error || "扩展后台没有返回结果"}`;
      return;
    }
    $("#status").textContent = response.state === "already_running"
      ? "采集队列正在执行"
      : `采集完成，本轮处理 ${response.processed || 0} 个任务`;
  });
});
load().catch(error => { $("#status").textContent = error.message; });
