import { mountHotspotGraph } from "./hotspot-graph.js?v=20260808-focus-reset";

const state = {
  dashboard: null,
  hotspotGraph: null,
  hotspotGraphError: "",
  tab: "events",
  eventWindow: "72h",
  platform: "all",
  gradeSelection: ["T3", "T2", "T1"],
  evidence: "all",
  analysisFilter: "all",
  momentumFilter: "all",
  timeFilter: "7d",
  query: "",
  settingsTab: "terms",
  editingRuleId: "",
  extensionReady: false,
  graphLayoutSignature: "",
  graphDataSignature: "",
  detailSelection: null,
  csrf: "",
  queueItems: [],
  queueSummary: null,
  queueType: "all",
  queueTask: "all",
  queuePlatform: "all",
  queueStatus: "all",
  queueQuery: ""
};

const extensionRequests = new Map();
let dashboardReloadTimer = null;
let liveUpdatesStarted = false;
let graphResizeTimer = null;
let settingsRenderSeq = 0;
let graphCoverageIssueStreak = 0;
let graphCoverageManualExpanded = false;
let pageLoadPromise = null;
let queueLoadSeq = 0;
const inflightGetRequests = new Map();
const settingsDataCache = { terms: null, models: null, collector: null };
const settingsDataFingerprint = {};
const settingsDataFetchedAt = {};
// 设置页数据由写操作主动失效；较长缓存避免打开抽屉或后台心跳反复读取数据库。
const SETTINGS_CACHE_TTL = 5 * 60_000;
let settingsDisplayedTab = "";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function settingsCacheFresh(key) {
  return Boolean(settingsDataCache[key]) && Date.now() - Number(settingsDataFetchedAt[key] || 0) < SETTINGS_CACHE_TTL;
}

function invalidateSettingsCache(key) {
  if (!key) return;
  settingsDataFetchedAt[key] = 0;
  settingsDataFingerprint[key] = "";
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return new Intl.NumberFormat("zh-CN").format(number);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDuration(start, end = Date.now()) {
  const from = new Date(start).getTime(); const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "时间未知";
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}分${seconds % 60}秒` : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function formatPublishedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function isEnglishPost(post) {
  const text = String(post?.text || "");
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return latin >= 12 && latin > chinese * 2;
}

function formatRefreshTime(value = Date.now()) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(value);
}

function dayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

function stageLabel(stage) {
  return ({ burst: "爆发热点", hot: "热点", spreading: "开始扩散", new: "新出现", cooling: "冷却", pending: "待确认" })[stage] || "观察中";
}

function reasonLabel(reason) {
  return ({
    missing_followers: "缺少粉丝数",
    insufficient_history: "历史作品不足 5 条",
    x_threshold_uncalibrated: "X 赞粉比门槛尚未校准",
    missing_likes: "缺少点赞数"
  })[reason] || "尚未满足正式评级证据";
}

function qualityLabel(quality = {}) {
  const grade = quality.grade || "ordinary";
  const label = quality.label || ({ candidate: "候选", low_quality: "低质异常", ordinary: "普通" })[grade] || "";
  return grade.startsWith("T") ? `${grade} ${label}`.trim() : label;
}

function evidenceLabel(post) {
  return ({ complete: "证据完整", partial: "证据不完整", pending: "待补证据", invalid: "证据无效" })[post.evidenceCompleteness] || "证据待核";
}

function evidenceCopy(post) {
  const missing = post.missingEvidence || [];
  return missing.length ? `${evidenceLabel(post)} · 缺少：${missing.join("、")}` : evidenceLabel(post);
}

function qualityEvidenceCopy(post) {
  const quality = post.quality || {};
  const missing = post.missingEvidence || [];
  const r = Number.isFinite(Number(quality.r)) ? `账号相对倍数 ${Number(quality.r).toFixed(2)}` : missing.includes("历史基线") ? "账号相对倍数待补历史基线" : "账号相对倍数未计算";
  const m = Number.isFinite(Number(quality.m)) ? `赞粉比 ${Number(quality.m).toFixed(3)}` : missing.includes("粉丝数") ? "赞粉比待补粉丝数" : "赞粉比未计算";
  const tier = quality.tier ? `粉丝层级 ${quality.tier}` : "粉丝层级未确定";
  return `${r} · ${m} · ${tier}`;
}

function momentumDisplayLabel(post) {
  const status = post.momentum?.status;
  return ({ burst: "爆发中", rising: "升温中", cooling: "冷却中", observing: "动量观察中", insufficient: "动量快照不足", gap: "动量数据缺口", stale: "动量数据过期" })[status]
    || (post.momentum?.label === "数据不足" ? "动量快照不足" : post.momentum?.label || "动量待观察");
}

function analysisLabel(post) {
  return ({ complete: "一级快评已完成", running: "一级快评中", queued: "一级快评排队中", failed: "一级快评失败", not_started: "一级快评未运行" })[post.analysisState] || "一级快评未运行";
}

function actionLabel(action) {
  return ({
    collect_creator: "采集作者资料",
    baseline_watch: "加入基线观察",
    increase_recollect: "提高复采频率",
    extract_content: "重新提取内容",
    view_error: "查看采集错误",
    run_l1: "运行一级快评"
  })[action] || action;
}

async function runEvidenceAction(post, action) {
  if (action === "run_l1") {
    const task = await queueAnalysis(post.id, "l1");
    if (task?.id) openPost({ ...post, analysisState: "queued", analysisTaskId: `analysis:${task.id}` });
    return;
  }
  if (["collect_creator", "baseline_watch", "increase_recollect"].includes(action)) {
    await api(`/posts/${encodeURIComponent(post.id)}/follow-up`, { method: "POST", body: JSON.stringify({ action }) });
    toast(action === "collect_creator" ? "已安排采集作者资料" : action === "baseline_watch" ? "已加入基线观察" : "已提高复采频率");
    await load();
    return;
  }
  if (action === "extract_content") return queueTranscript(post.id);
  if (action === "view_error") return openPost(post);
}

function toast(message) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("show"), 2200);
}

function extensionRequest(type, payload = {}, timeoutMs = 5000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      extensionRequests.delete(requestId);
      reject(new Error("本地采集扩展未响应，请确认扩展已经加载并刷新本页面"));
    }, timeoutMs);
    extensionRequests.set(requestId, { resolve, reject, timer });
    window.postMessage({ type, requestId, ...payload }, location.origin);
  });
}

window.addEventListener("message", event => {
  if (event.source !== window) return;
  if (event.data?.type === "AIP_EXTENSION_READY") {
    state.extensionReady = true;
    return;
  }
  if (event.data?.type !== "AIP_EXTENSION_RESPONSE") return;
  const pending = extensionRequests.get(event.data.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  extensionRequests.delete(event.data.requestId);
  if (event.data.ok) pending.resolve(event.data);
  else pending.reject(new Error(event.data.error || "本地采集扩展执行失败"));
});

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const requestKey = method === "GET" ? path : "";
  if (requestKey && inflightGetRequests.has(requestKey)) return inflightGetRequests.get(requestKey);
  const request = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), method === "GET" ? 15_000 : 30_000);
    const { signal: callerSignal, ...requestOptions } = options;
    try {
      const response = await fetch(`/api${path}`, {
        ...requestOptions,
        signal: callerSignal || controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(state.csrf && !["GET", "HEAD"].includes(method) ? { "X-CSRF-Token": state.csrf } : {}),
          ...(options.headers || {})
        }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `请求失败（${response.status}）`);
        Object.assign(error, payload, { status: response.status });
        throw error;
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("请求超时，已保留上次数据，请稍后重试");
      if (error instanceof TypeError && /fetch/i.test(error.message || "")) throw new Error("服务连接失败，请确认本地服务正在运行");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  if (requestKey) {
    inflightGetRequests.set(requestKey, request);
    request.then(
      () => { if (inflightGetRequests.get(requestKey) === request) inflightGetRequests.delete(requestKey); },
      () => { if (inflightGetRequests.get(requestKey) === request) inflightGetRequests.delete(requestKey); }
    );
  }
  return request;
}

function setButtonBusy(button, busy, busyLabel = "处理中…") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.classList.add("is-busy");
    button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.classList.remove("is-busy");
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  }
}

function matches(post, { ignoreGrade = false } = {}) {
  if (state.platform !== "all" && post.platform !== state.platform) return false;
  const formalGrade = ["T1", "T2", "T3"].includes(post.quality?.grade);
  if (!ignoreGrade && state.gradeSelection.length < 3 && (!formalGrade || !state.gradeSelection.includes(post.quality?.grade))) return false;
  if (state.tab === "posts") {
    if (state.evidence !== "all" && post.evidenceCompleteness !== state.evidence) return false;
    if (state.analysisFilter === "complete" && post.analysisState !== "complete") return false;
    if (state.analysisFilter === "processing" && !["queued", "running"].includes(post.analysisState)) return false;
    if (state.analysisFilter === "not_started" && !["not_started", "failed"].includes(post.analysisState)) return false;
    if (state.momentumFilter !== "all") {
      const momentum = post.momentum?.status || "insufficient";
      if (state.momentumFilter === "insufficient" ? !["insufficient", "observing", "gap", "stale"].includes(momentum) : momentum !== state.momentumFilter) return false;
    }
    if (state.timeFilter !== "all") {
      const age = Date.now() - new Date(post.publishedAt || post.capturedAt).getTime();
      const limit = state.timeFilter === "24h" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
      if (!Number.isFinite(age) || age < 0 || age > limit) return false;
    }
  }
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return `${post.text || ""} ${post.handle || ""} ${post.author || ""} ${(post.topics || []).join(" ")} ${(post.entities || []).join(" ")} ${post.product || ""}`.toLowerCase().includes(query);
}

function setBadge(parent, text, className = "") {
  parent.append(node("span", className, text));
}

function postCard(post, candidate = false) {
  const card = node("article", "post-card");
  card.tabIndex = 0;
  const contentLayer = node("div", "post-card-layer post-card-content");
  const head = node("div", "post-head");
  const author = node("div", "author");
  author.append(node("span", "avatar", String(post.author || post.displayName || post.handle || "?").slice(0, 1).toUpperCase()));
  const identity = node("div");
  const name = node("b", "", post.author || post.displayName || post.handle || "未知作者");
  name.append(node("small", "", post.handle || ""));
  name.append(node("small", "post-platform-label", post.platform === "douyin" ? "抖音" : "X"));
  identity.append(name);
  author.append(identity);
  head.append(author);
  head.append(node("time", "post-time", formatPublishedTime(post.publishedAt || post.capturedAt)));
  if (post.url || post.sourceUrl) {
    const original = node("a", "post-original-link", "原帖");
    original.href = safeExternalUrl(post.url || post.sourceUrl);
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    original.addEventListener("click", event => event.stopPropagation());
    head.append(original);
  }
  contentLayer.append(head, node("p", "post-text", post.text || "正文尚未采集"));
  const judgement = node("div", "post-card-judgement badge-row post-judgement-line");
  setBadge(judgement, candidate ? "候选" : qualityLabel(post.quality), `grade-pill grade-${post.quality?.grade || "candidate"}`);
  setBadge(judgement, momentumDisplayLabel(post), "momentum-pill");
  const analysisMarker = node("span", `analysis-marker analysis-marker-${post.analysisState || "not_started"}`, analysisLabel(post));
  judgement.append(analysisMarker);
  contentLayer.append(judgement);
  const evidenceLayer = node("div", "post-card-layer post-card-evidence");
  const foot = node("div", "post-foot");
  foot.append(node("span", "", `${formatNumber(post.likes)} 赞`));
  if (post.bookmarks !== null && post.bookmarks !== undefined) foot.append(node("span", "", `${formatNumber(post.bookmarks)} 收藏`));
  const reason = `${qualityEvidenceCopy(post)} · ${evidenceCopy(post)}`;
  foot.append(node("span", "reason", reason));
  evidenceLayer.append(foot);
  const actionRow = node("div", "post-card-actions");
  for (const action of (post.availableActions || []).filter(item => item !== "run_l1").slice(0, 2)) {
    const button = node("button", "post-action-button", actionLabel(action));
    button.type = "button";
    button.addEventListener("click", async event => { event.stopPropagation(); button.disabled = true; try { await runEvidenceAction(post, action); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
    actionRow.append(button);
  }
  if (post.availableActions?.includes("run_l1") && !["queued", "running"].includes(post.analysisState)) {
    const button = node("button", "post-action-button post-action-primary", "运行一级快评");
    button.type = "button";
    button.addEventListener("click", async event => { event.stopPropagation(); button.disabled = true; try { await runEvidenceAction(post, "run_l1"); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
    actionRow.append(button);
  }
  // 操作跟随判定信息显示，避免在卡片底部再生成一块孤立按钮区。
  contentLayer.append(actionRow);
  card.append(contentLayer, evidenceLayer);
  card.addEventListener("click", () => { try { openPost(post); } catch (error) { console.error("作品详情打开失败", error); toast("作品详情暂时无法打开，请稍后重试"); } });
  card.addEventListener("keydown", event => { if (event.key !== "Enter") return; try { openPost(post); } catch (error) { console.error("作品详情打开失败", error); toast("作品详情暂时无法打开，请稍后重试"); } });
  return card;
}

function renderPostStream(target, posts, candidate = false) {
  target.replaceChildren();
  const groups = new Map();
  const visiblePosts = posts.filter(matches).sort((a, b) => new Date(b.publishedAt || b.capturedAt).getTime() - new Date(a.publishedAt || a.capturedAt).getTime());
  for (const post of visiblePosts) {
    const key = dayKey(post.publishedAt || post.capturedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  for (const [day, items] of groups) {
    const group = node("section", `date-group${target.id === "hotPostStream" ? " is-flat" : ""}`);
    const label = node("div", "date-label");
    label.append(node("b", "", day), node("span", "", `${items.length} 条`));
    const cards = node("div", "date-posts");
    for (const post of items) cards.append(postCard(post, candidate));
    group.append(label, cards);
    target.append(group);
  }
  return [...groups.values()].reduce((sum, items) => sum + items.length, 0);
}

function renderEvents() {
  const graph = state.hotspotGraph;
  const summary = graph?.summary || {};
  const coverage = graph?.coverage || {};
  const enabledPlatforms = Object.entries(coverage.platforms || {}).filter(([, item]) => item.enabled !== false);
  const unhealthyPlatform = enabledPlatforms.find(([, item]) => item.healthy !== true || item.pausedReason || item.lastError);
  const failedWindow = [...(coverage.coverageWindows || [])].reverse().find(item => item.scheduled > 0 && (item.nodeHealthy !== true || item.successRate < .8));
  const queuedCount = (coverage.coverageWindows || []).reduce((sum, item) => sum + Number(item.queued || 0), 0);
  const runningCount = (coverage.coverageWindows || []).reduce((sum, item) => sum + Number(item.running || 0), 0);
  const collectionPending = queuedCount > 0 || runningCount > 0;
  const coverageReason = unhealthyPlatform
    ? `${unhealthyPlatform[0] === "douyin" ? "抖音" : "X"}${unhealthyPlatform[1].lastError ? `：${unhealthyPlatform[1].lastError}` : unhealthyPlatform[1].pausedReason ? `：${unhealthyPlatform[1].pausedReason}` : "采集节点未在线"}`
    : failedWindow
      ? `最近采集窗口成功率 ${Math.round(Number(failedWindow.successRate || 0) * 100)}%（${failedWindow.completed}/${failedWindow.scheduled}）`
      : "最近采集窗口不完整";
  $("#graphSummaryHeadline").textContent = state.hotspotGraphError
    ? "读取失败"
    : Number(summary.todayPostCount || 0) || Number(summary.todayHotspotCount || 0)
      ? `${Number(summary.todayPostCount || 0)} 帖 · ${Number(summary.todayHotspotCount || 0)} 热点`
      : "暂无今日热点";
  $("#graphSummaryPosts").textContent = `${Number(summary.todayPostCount || 0)} 条`;
  $("#graphSummaryPersistent").textContent = `${Number(summary.persistentPostCount || 0)} 条`;
  $("#graphSummaryHotspots").textContent = `${Number(summary.todayHotspotCount || 0)} 个`;
  $("#graphSummaryForming").textContent = `${Number(summary.todayFormingCount || 0)} 个`;
  const coverageMessage = state.hotspotGraphError
    ? `采集情况：热点数据读取失败 · ${state.hotspotGraphError}`
    : collectionPending
      ? `采集中 · ${runningCount ? `执行中 ${runningCount} 条` : "等待采集"}${queuedCount ? ` · 排队 ${queuedCount} 条` : ""}`
    : coverage.complete
      ? `采集情况：正常 · 最近采集 ${coverage.lastSuccessAt ? formatTime(coverage.lastSuccessAt) : "尚无成功采集"}`
      : `采集情况：${coverageReason}`;
  const coverageNode = $("#graphCoverage");
  const coverageLabel = "采集情况";
  coverageNode.querySelector("span").textContent = coverageLabel;
  $("#graphCoverageMessage .graph-coverage-copy").textContent = coverageMessage;
  coverageNode.title = coverageMessage;
  coverageNode.setAttribute("aria-label", coverageMessage);
  const coverageIssue = Boolean(state.hotspotGraphError) || (coverage.complete !== true && !collectionPending);
  graphCoverageIssueStreak = coverageIssue ? graphCoverageIssueStreak + 1 : 0;
  coverageNode.classList.toggle("warning", coverageIssue);
  const coverageIsland = $("#graphCoverageIsland");
  coverageIsland.classList.toggle("warning", coverageIssue);
  const autoExpanded = coverageIssue && graphCoverageIssueStreak >= 2;
  const expanded = autoExpanded || graphCoverageManualExpanded;
  coverageIsland.classList.toggle("is-expanded", expanded);
  $("#graphCoverageMessage").hidden = !expanded;
  const filtered = graph || {};
  const graphContainer = $("#hotspotGraph");
  const graphDataSignature = JSON.stringify({
    window: state.eventWindow,
    clusters: (filtered.clusters || []).map(cluster => [cluster.id, cluster.directionId, cluster.visiblePostKeys]),
    standalones: (filtered.standalones || []).map(post => [post.platform, post.id])
  });
  const graphLayoutSignature = JSON.stringify({
    data: graphDataSignature,
    size: [graphContainer.clientWidth, graphContainer.clientHeight]
  });
  const animate = graphDataSignature !== state.graphDataSignature;
  const remount = graphLayoutSignature !== state.graphLayoutSignature;
  state.graphLayoutSignature = graphLayoutSignature;
  state.graphDataSignature = graphDataSignature;
  if (remount || !graphContainer.querySelector("svg")) {
    const mounted = mountHotspotGraph(graphContainer, filtered, {
      animate,
      onClusterSelect: openEvent,
      onPostSelect: openPost,
      onFocusClear: () => {
        state.detailSelection = null;
        toggleDrawer($("#detailDrawer"), false);
      },
      onViewChange: changed => { $("#resetGraphView").hidden = !changed; },
      onInteract: dismissGraphHint
    });
    $("#resetGraphView").hidden = true;
    if (mounted && $("#graphSearchInput").value.trim()) renderGraphSearchResults();
  } else {
    graphContainer.querySelector("svg")?.updateGraphData?.(filtered);
  }
  refreshOpenGraphDetail(filtered);
  showEmpty(false);
}

function dismissGraphHint() {
  const hint = $("#graphHint");
  hint?.classList.add("is-dismissed");
  sessionStorage.setItem("aip-graph-hint-seen", "1");
}

function renderGraphSearchResults() {
  const input = $("#graphSearchInput");
  const results = $("#graphSearchResults");
  const graph = $("#hotspotGraph svg");
  const matches = graph?.searchNodes?.(input.value) || [];
  results.replaceChildren();
  if (!input.value.trim()) {
    results.hidden = true;
    return matches;
  }
  if (!matches.length) {
    results.append(node("div", "graph-search-empty", "没有匹配的热点或作者"));
  } else {
    for (const match of matches) {
      const button = node("button");
      button.type = "button";
      button.dataset.nodeKey = match.key;
      button.setAttribute("role", "option");
      button.append(node("small", "", match.kind), node("span", "", match.label));
      results.append(button);
    }
  }
  results.hidden = false;
  return matches;
}

function renderPosts() {
  const hot = renderPostStream($("#hotPostStream"), state.dashboard?.hotPosts || []);
  const pending = (state.dashboard?.pendingEvidence || []).filter(matches);
  $("#pendingEvidenceCount").textContent = pending.length;
  $("#pendingEvidenceGrid").replaceChildren(...pending.slice(0, 60).map(post => postCard(post, !["T1", "T2", "T3"].includes(post.quality?.grade))));
  const candidates = (state.dashboard?.candidates || []).filter(matches);
  $("#candidateCount").textContent = candidates.length;
  const candidateGrid = $("#candidateGrid");
  candidateGrid.replaceChildren(...candidates.slice(0, 60).map(post => postCard(post, true)));
  showEmpty(hot === 0 && candidates.length === 0 && pending.length === 0);
}

function renderFollowing() {
  const rail = $("#creatorRail");
  rail.replaceChildren();
  const creators = state.dashboard?.creators || [];
  for (const creator of creators) {
    const chip = node("article", "creator-chip");
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-label", `查看 ${creator.displayName || creator.handle || "关注账号"}`);
    chip.append(node("span", "avatar", String(creator.displayName || creator.handle || "?").slice(0, 1)));
    chip.append(node("b", "", creator.displayName || creator.handle || "待采集账号"));
    chip.append(node("small", "", `${creator.platform === "douyin" ? "抖音" : "X"} · ${creator.frequency || "1小时"}`));
    const open = () => openCreatorDrawer({ creatorId: creator.id, handle: creator.handle, author: creator.displayName, platform: creator.platform });
    chip.addEventListener("click", open);
    chip.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    rail.append(chip);
  }
  const count = renderPostStream($("#followingStream"), state.dashboard?.followedPosts || []);
  $("#followingCreatorCount").textContent = creators.length;
  $("#followingPostCount").textContent = `${count} 条`;
  showEmpty(count === 0);
}

function queueStatusLabel(item) {
  if (item.status === "deferred") {
    const reason = String(item.statusReason || item.error || "");
    if (reason.includes("预算")) return "排队中";
    if (reason.includes("模型")) return "等待模型配置";
    if (reason.includes("有效分析窗口") || reason.includes("超过")) return "已过期";
    return "等待条件";
  }
  return ({ queued: "排队中", running: "执行中", leased: "执行中", collecting: "执行中", complete: "已完成", success: "已完成", failed: "失败", paused: "已暂停", cancelled: "已取消", ignored: "已忽略", waiting_extension: "等待采集节点", waiting_model: "等待模型配置", waiting_budget: "预算不足", waiting_manual: "等待手动执行" })[item.status] || item.status || "未知";
}

function isExpiredQueueItem(item) {
  if (item?.status !== "deferred") return false;
  const reason = String(item.statusReason || item.error || "");
  return reason.includes("有效分析窗口") || reason.includes("已超过一级快评");
}

function queueDiagnosticText(item) {
  const text = String(item?.statusReason || item?.error || "");
  if (item?.source === "collector" && /6551.*(?:配额|额度|余额)|(?:配额|额度|余额).*6551/i.test(text)) {
    return item.collectorRuntime?.configured === false ? "等待采集器配置" : "采集器暂不可用";
  }
  return text;
}

function queuePostLookup(item) {
  const posts = [...(state.dashboard?.hotPosts || []), ...(state.dashboard?.candidates || []), ...(state.dashboard?.followedPosts || [])];
  const post = posts.find(post => String(post.id) === String(item.postId || item.entityId));
  if (post || !item.postId) return post;
  return { id: item.postId, platform: item.platform || "x", author: item.author || item.displayName || "未知作者", displayName: item.displayName || item.author || "未知作者", handle: item.handle || "", profileUrl: item.profileUrl || "", avatarUrl: item.avatarUrl || "", text: item.text || item.object || "正文尚未采集", publishedAt: item.publishedAt, url: item.postUrl || "" };
}

function queueCreatorLookup(item) {
  const creators = state.dashboard?.creators || [];
  const post = queuePostLookup(item);
  return creators.find(creator => String(creator.id) === String(item.creatorId || "") || (item.handle && String(creator.handle || "").replace(/^@/, "").toLowerCase() === String(item.handle).replace(/^@/, "").toLowerCase() && (creator.platform || "x") === (item.platform || "x")) || (post?.handle && String(creator.handle || "").replace(/^@/, "").toLowerCase() === String(post.handle).replace(/^@/, "").toLowerCase() && (creator.platform || "x") === (post.platform || "x"))) || (item.author ? { id: item.creatorId || "", displayName: item.displayName || item.author, handle: item.handle || "", profileUrl: item.profileUrl || "", avatarUrl: item.avatarUrl || "", platform: item.platform || "x", status: "observing" } : null);
}

async function openCreatorDrawer(item) {
  const creator = queueCreatorLookup(item);
  if (!creator) return openQueueDetail(item);
  const posts = [...(state.dashboard?.hotPosts || []), ...(state.dashboard?.candidates || []), ...(state.dashboard?.followedPosts || [])].filter(post => String(post.creatorId || "") === String(creator.id) || (post.handle && String(post.handle).replace(/^@/, "").toLowerCase() === String(creator.handle || "").replace(/^@/, "").toLowerCase() && (post.platform || "x") === (creator.platform || "x"))).sort((a, b) => new Date(b.publishedAt || b.capturedAt || 0) - new Date(a.publishedAt || a.capturedAt || 0)).slice(0, 8);
  const body = $("#drawerBody"); body.replaceChildren(); $("#drawerEyebrow").textContent = "关注博主"; $("#drawerTitle").textContent = creator.displayName || creator.handle || "博主详情";
  const overview = node("section", "evidence-block");
  overview.append(node("span", "", `${creator.platform === "douyin" ? "抖音" : "X"} · ${creator.handle || "账号未知"}`));
  overview.append(node("h3", "creator-drawer-name", creator.displayName || creator.handle || "未知博主"));
  overview.append(node("p", "", `关注状态：${creator.status === "followed" ? "已关注" : "未关注"} · 采集频率：${creator.frequency || "1小时"}`));
  if (creator.profileUrl || creator.handle) { const profile = node("a", "creator-profile-link", creator.profileUrl || `@${creator.handle}`); profile.href = safeExternalUrl(creator.profileUrl || (creator.platform === "douyin" ? `https://www.douyin.com/user/${creator.handle}` : `https://x.com/${String(creator.handle).replace(/^@/, "")}`)); profile.target = "_blank"; profile.rel = "noopener noreferrer"; overview.append(profile); }
  const creatorActions = node("div", "drawer-actions drawer-actions-primary");
  if (creator.status === "followed" && creator.id) {
    const unfollow = node("button", "mini-button", "取消关注");
    unfollow.addEventListener("click", async event => {
      event.stopPropagation();
      setButtonBusy(unfollow, true, "取消中…");
      try {
        await api(`/creators/${encodeURIComponent(creator.id)}`, { method: "DELETE", body: "{}" });
        toggleDrawer($("#detailDrawer"), false);
        toast("已取消关注");
        await load();
      } catch (error) {
        toast(error.message || "取消关注失败");
        setButtonBusy(unfollow, false);
      }
    });
    creatorActions.append(unfollow);
  } else {
    const follow = node("button", "mini-button", "关注作者");
    follow.addEventListener("click", async event => { event.stopPropagation(); await api("/follows", { method: "POST", body: JSON.stringify({ platform: creator.platform, handle: creator.handle, displayName: creator.displayName, profileUrl: creator.profileUrl }) }); toast("已加入关注"); await load(); openCreatorDrawer({ ...item, creatorId: creator.id }); });
    creatorActions.append(follow);
  }
  overview.append(creatorActions); body.append(overview);
  const recent = node("section", "evidence-block"); recent.append(node("span", "", "近期帖子"));
  if (posts.length) posts.forEach(post => { const button = node("button", "ranked-post-button", `${formatTime(post.publishedAt || post.capturedAt)} · ${String(post.text || "正文尚未采集").slice(0, 120)}`); button.addEventListener("click", () => openPost(post)); recent.append(button); });
  else recent.append(node("p", "", "暂无已采集帖子"));
  body.append(recent); toggleDrawer($("#detailDrawer"), true);
}

const QUEUE_TYPE_META = [
  ["collector", "采集任务"], ["l1", "一级快评"], ["l2", "二级深析"],
  ["relevance", "相关性复核"], ["event", "热点归并"], ["asr", "逐字稿"]
];

function renderQueueTypeCards(summary) {
  const grid = $("#queueTypeGrid"); if (!grid) return;
  const byTaskType = summary?.byTaskType || {};
  grid.replaceChildren(...QUEUE_TYPE_META.map(([taskType, label]) => {
    const stats = byTaskType[taskType] || { total: 0, completed: 0, queued: 0, running: 0, failed: 0 };
    const reasons = state.queueItems.filter(item => item.taskType === taskType && ["queued", "deferred"].includes(item.status)).map(item => item.statusReason).filter(Boolean);
    const reason = reasons.length ? reasons.sort((a, b) => reasons.filter(value => value === b).length - reasons.filter(value => value === a).length)[0] : stats.queued ? "等待工作器领取" : "暂无排队任务";
    const progress = stats.total ? Math.min(100, Math.round(stats.completed / stats.total * 100)) : 0;
    const activeItems = state.queueItems.filter(item => item.taskType === taskType && ["queued", "waiting_extension", "running"].includes(item.status));
    const activeQueued = activeItems.filter(item => ["queued", "waiting_extension"].includes(item.status)).length;
    const waitingExtension = activeItems.filter(item => item.status === "waiting_extension").length;
    const activeRunning = activeItems.filter(item => item.status === "running").length;
    const deferredItems = state.queueItems.filter(item => item.taskType === taskType && item.status === "deferred");
    const card = node("button", `queue-type-card${state.queueTask === taskType ? " is-selected" : ""}`, "");
    card.type = "button";
    card.setAttribute("aria-pressed", state.queueTask === taskType ? "true" : "false");
    card.addEventListener("click", () => {
      state.queueTask = state.queueTask === taskType ? "all" : taskType;
      renderQueue();
    });
    const heading = node("div", "queue-type-heading"); heading.append(node("strong", "", label), node("span", `queue-type-state${activeRunning ? " is-running" : ""}`, activeRunning ? "执行中" : waitingExtension ? "等待采集节点" : activeQueued ? "排队中" : deferredItems.length ? "等待条件" : "当前无执行任务"));
    const active = activeQueued + activeRunning + deferredItems.length;
    const count = node("div", "queue-type-count"); count.append(node("b", "", String(active)), node("span", "", "当前任务"));
    const bar = node("div", "queue-type-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `${label}今日完成率`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(progress));
    const fill = node("span"); fill.style.width = `${progress}%`; if (activeRunning) fill.classList.add("is-running"); bar.append(fill);
    const meta = node("div", "queue-type-meta"); meta.append(node("span", "", `今日 ${stats.total}`), node("span", "", `完成 ${stats.completed}`), node("span", "", `排队 ${activeQueued}`), node("span", "", `等待节点 ${waitingExtension}`), node("span", "", `执行 ${activeRunning}`), node("span", "", `等待条件 ${deferredItems.length}`), node("span", "", `失败 ${stats.failed}`), node("b", "", `今日完成率 ${progress}%`));
    card.append(heading, count, bar, meta, node("small", "queue-type-reason", `当前：${reason}`)); return card;
  }));
}

function renderQueueCard(item, visibleItems) {
    const card = node("article", `queue-card queue-${item.status}`);
    card.tabIndex = 0;
    const position = `队列第 ${visibleItems.findIndex(active => active.id === item.id) + 1} 位 / 共 ${visibleItems.length} 位`;
    const title = node("div", "queue-card-title"); title.append(node("strong", "", item.label || item.taskType), node("small", "", `${item.id} · ${position}`));
    const status = node("span", `queue-status queue-status-${item.status}`, queueStatusLabel(item));
    const author = node("button", "queue-card-author", "");
    if (item.author) { const avatar = item.avatarUrl ? node("img", "avatar queue-avatar-image") : node("span", "avatar", item.avatar || item.author.slice(0, 1).toUpperCase()); if (item.avatarUrl) { avatar.src = item.avatarUrl; avatar.alt = ""; } author.append(avatar, node("b", "", `${item.author} · ${item.platform === "douyin" ? "抖音" : "X"}`)); author.addEventListener("click", event => { event.stopPropagation(); openCreatorDrawer(item); }); } else { author.hidden = true; }
    const object = node("div", "queue-card-object", item.object || `对象 ${item.entityId || "未知"}`);
    const taskNature = item.source === "analysis" ? "分析任务" : "待采集任务 · 完成后写入帖子库";
    const meta = node("div", "queue-card-meta", `${taskNature} · ${item.entityId || "对象未知"} · ${item.platform || "平台未知"} · ${item.automatic ? "自动" : "手动"} · 执行器 ${item.executor || "待分配"} · 模型 ${item.model || "未配置"} · 等待 ${formatDuration(item.createdAt, item.startedAt || (item.status === "running" ? Date.now() : item.finishedAt || Date.now()))} · 执行 ${item.attempts || 0} 次`);
    if (item.promotedAt) meta.textContent += " · 已插队";
    const diagnostic = queueDiagnosticText(item);
    if (diagnostic) meta.textContent += ` · ${diagnostic}`;
    const actions = node("div", "queue-card-actions");
    card.addEventListener("click", event => { if (event.target.closest("button")) return; const post = item.objectType === "post" || item.postId ? queuePostLookup(item) : null; post ? openPost(post) : openQueueDetail(item); });
    card.addEventListener("keydown", event => { if (event.target.closest("button") || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); const post = item.objectType === "post" || item.postId ? queuePostLookup(item) : null; post ? openPost(post) : openQueueDetail(item); });
    const detail = node("button", "mini-button", "查看任务"); detail.addEventListener("click", event => { event.stopPropagation(); openQueueDetail(item); }); actions.append(detail);
    if (item.status === "queued") { const promote = node("button", "mini-button", "插队"); promote.addEventListener("click", event => { event.stopPropagation(); queueAction(item, "promote"); }); actions.append(promote); }
    if (["queued", "waiting_model", "waiting_budget", "waiting_manual"].includes(item.status)) { const pause = node("button", "mini-button", "暂停"); pause.addEventListener("click", event => { event.stopPropagation(); queueAction(item, "pause"); }); actions.append(pause); }
    if (item.status === "paused") { const resume = node("button", "mini-button", "恢复"); resume.addEventListener("click", event => { event.stopPropagation(); queueAction(item, "resume"); }); actions.append(resume); }
    if (["failed", "cancelled"].includes(item.status)) { const retry = node("button", "mini-button", "重试"); retry.addEventListener("click", event => { event.stopPropagation(); queueAction(item, "retry"); }); actions.append(retry); }
    if (item.source === "collector" && item.collectorRuntime) title.append(node("small", "queue-collector-runtime", `${item.collectorRuntime.name} · ${item.collectorRuntime.label}`));
    card.append(title, status, author, object, meta, actions); return card;
}

function renderQueue() {
  const list = $("#queueList"); if (!list) return;
  const items = state.queueItems.filter(item => !isExpiredQueueItem(item)).sort((a, b) => {
    const stateRank = { running: 0, queued: 1, waiting_extension: 2, deferred: 3 };
    const rank = item => stateRank[item.status] ?? 9;
    const rankDiff = rank(a) - rank(b);
    if (rankDiff) return rankDiff;
    const aTime = new Date(a.startedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.startedAt || b.createdAt || 0).getTime();
    return aTime - bTime;
  });
  const activeStatuses = new Set(["queued", "running", "waiting_extension", "deferred"]);
  const activeItems = items.filter(item => activeStatuses.has(item.status));
  const visibleItems = state.queueTask === "all" ? activeItems : activeItems.filter(item => item.taskType === state.queueTask);
  const counts = activeItems.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  const summary = state.queueSummary?.today || { total: 0, completed: 0, queued: 0, running: 0, failed: 0, byTaskType: {} };
  $("#queueSummary").textContent = `当前 ${activeItems.length} 项真实任务 · 排队 ${counts.queued || 0} · 等待节点 ${counts.waiting_extension || 0} · 执行中 ${counts.running || 0}${state.queueTask === "all" ? " · 点击上方卡片筛选类型" : ` · 当前查看：${QUEUE_TYPE_META.find(([id]) => id === state.queueTask)?.[1] || state.queueTask}`}`;
  renderQueueTypeCards(summary);
  $("#queueUpdatedAt").textContent = `最近更新 ${formatRefreshTime()}`;
  const groups = QUEUE_TYPE_META.map(([taskType, label]) => [taskType, label, visibleItems.filter(item => item.taskType === taskType)]).filter(([, , groupItems]) => groupItems.length);
  list.replaceChildren(...groups.map(([taskType, label, groupItems]) => {
    const group = node("section", "queue-group");
    const heading = node("header", "queue-group-heading"); heading.append(node("h3", "", label), node("span", "", `${groupItems.length} 项活动任务`)); group.append(heading, ...groupItems.map(item => renderQueueCard(item, visibleItems))); return group;
  }));
  if (!visibleItems.length) list.append(node("p", "queue-empty", state.queueTask === "all" ? "当前没有排队中或执行中的任务" : "该类型当前没有排队中或执行中的任务"));
}

async function openQueueDetail(item) {
  try { item = (await api(`/queue/${encodeURIComponent(item.id)}`)).item || item; } catch { /* 列表对象仍可展示 */ }
  const body = $("#drawerBody"); body.replaceChildren(); $("#drawerEyebrow").textContent = "队列任务"; $("#drawerTitle").textContent = item.label || item.taskType;
  const block = node("section", "evidence-block"); block.append(node("span", "", "任务状态"), node("h3", "", queueStatusLabel(item)), node("p", "", `任务编号：${item.id}\n任务类型：${item.label || item.taskType}\n关联对象：${item.entityId || "未知"}\n平台：${item.platform || "未知"}\n执行器：${item.executor || "待分配"}\n模型：${item.model || "未配置"}\n执行方式：${item.automatic ? "自动" : "手动"}\n优先级：${item.priority ?? "未知"}\n创建时间：${formatTime(item.createdAt)}\n开始时间：${formatTime(item.startedAt)}\n完成时间：${formatTime(item.finishedAt)}\n等待时长：${formatDuration(item.createdAt, item.startedAt || item.finishedAt || Date.now())}\n执行次数：${item.attempts || 0}\n最近节点：${item.workerId || item.leaseNodeId || "未分配"}`)); const diagnostic = queueDiagnosticText(item); if (diagnostic) block.append(node("p", "", diagnostic)); body.append(block); toggleDrawer($("#detailDrawer"), true);
}

async function loadQueue() {
  const loadSeq = ++queueLoadSeq;
  try {
    const payload = await api(`/queue?type=${encodeURIComponent(state.queueType)}&status=all&window=7d`);
    if (loadSeq !== queueLoadSeq) return;
    state.queueItems = (payload.items || []).filter(item => !isExpiredQueueItem(item));
    state.queueSummary = payload.summary || null;
    if (state.tab === "queue") renderQueue();
  } catch (error) {
    if (loadSeq !== queueLoadSeq) return;
    if (state.queueItems.length) toast(`队列刷新失败，已保留上次状态：${error.message}`);
    else if ($("#queueList")) $("#queueList").replaceChildren(node("p", "queue-empty", `队列读取失败：${error.message}`));
  }
}

async function queueAction(item, action) { try { await api(`/queue/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: "{}" }); toast(action === "promote" ? "任务已插队" : action === "pause" ? "任务已暂停" : action === "resume" ? "任务已恢复" : "任务已重试"); await loadQueue(); } catch (error) { toast(error.message); } }

function renderSummary() {
  const summary = state.dashboard?.summary || {};
  const metrics = [
    ["关注博主", summary.followedCreatorCount, "当前监控账号"],
    ["关注动态", summary.followedPostCount, "已采集公开作品"],
    ["关注热帖", (state.dashboard?.followedPosts || []).filter(post => ["T1", "T2", "T3"].includes(post.quality?.grade)).length, "通过正式热度筛选"],
    ["待采任务", summary.queuedJobs, "等待扩展执行"],
    ["证据完整", summary.evidenceCompleteCount, "指标和历史证据齐全"],
    ["待补证据", summary.pendingEvidenceCount, "等待采集或复采"]
  ];
  const valueIds = ["eventCount", "hotPostCount", "creatorCount", "queueCount", "metricValue5", "metricValue6"];
  metrics.forEach((metric, index) => {
    $(`#metricLabel${index + 1}`).textContent = metric[0];
    $(`#${valueIds[index]}`).textContent = formatNumber(metric[1]);
    $(`#metricDetail${index + 1}`).textContent = metric[2];
  });
  $("#metricStrip").hidden = state.tab !== "following";
  const scopedHotPosts = (state.dashboard?.hotPosts || []).filter(post => matches(post, { ignoreGrade: true }));
  const counts = Object.fromEntries(["T1", "T2", "T3"].map(grade => [grade, scopedHotPosts.filter(post => post.quality?.grade === grade).length]));
  const hotTotal = scopedHotPosts.length;
  $("#hotContextBar").hidden = state.tab !== "posts";
  $("#hotContextSummary").textContent = `${formatNumber(hotTotal)} 条正式热帖 · ${state.timeFilter === "24h" ? "最近 24 小时" : state.timeFilter === "all" ? "全部时间" : "最近 7 天"}`;
  $("#hotContextUpdated").textContent = `最近更新 ${formatRefreshTime()}`;
  $("#hotStats").hidden = state.tab !== "posts";
  $("#hotStatsTotal").textContent = formatNumber(hotTotal);
  $("#hotAnalysisProgress").textContent = `一级快评完成 ${formatNumber(scopedHotPosts.filter(post => post.analysisState === "complete").length)} / ${formatNumber(hotTotal)}`;
  for (const grade of ["T3", "T2", "T1"]) {
    $(`#hotGrade${grade}`).textContent = formatNumber(counts[grade] || 0);
    const segment = $(`[data-grade-segment="${grade}"]`);
    segment.style.flexGrow = Math.max(Number(counts[grade] || 0), 0.01);
    segment.setAttribute("aria-pressed", state.gradeSelection.includes(grade) ? "true" : "false");
    segment.title = `${grade} ${grade === "T3" ? "现象级" : grade === "T2" ? "爆款" : "小爆"}：${counts[grade] || 0} 条`;
  }
  $("#candidateCount").textContent = formatNumber(summary.candidateCount);
  const health = state.dashboard?.health || {};
  $("#liveDot").classList.toggle("healthy", health.collectorHealthy);
  const platformValues = Object.values(health.platforms || {});
  const paused = platformValues.filter(item => item.pausedReason).length;
  $("#liveLabel").textContent = health.collectorHealthy
    ? "采集节点在线"
    : paused ? `${paused} 个平台已暂停` : "采集节点未连接";
  const unhealthyPlatforms = Object.entries(health.platforms || {}).filter(([, item]) => item.enabled !== false && !item.healthy).map(([platform]) => platform === "douyin" ? "抖音" : "X");
  const coverageQueued = (health.coverageWindows || []).reduce((sum, item) => sum + Number(item.queued || 0), 0);
  const coverageRunning = (health.coverageWindows || []).reduce((sum, item) => sum + Number(item.running || 0), 0);
  const coveragePending = coverageQueued > 0 || coverageRunning > 0;
  const coverageProblem = !health.coverageComplete && !coveragePending;
  $("#coverageCard").hidden = state.tab !== "posts";
  $("#coverageCard").classList.toggle("warning", coverageProblem);
  $("#coverageCard").classList.toggle("critical", coverageProblem && !health.lastSuccessAt);
  $("#coverageValue").textContent = coveragePending ? (coverageRunning ? "采集中" : "排队中") : health.coverageComplete ? "数据覆盖正常" : `${unhealthyPlatforms.join("、") || "数据"}覆盖不足`;
  $("#coverageDetail").textContent = coveragePending
    ? `${coverageRunning ? `执行中 ${coverageRunning} 条` : "等待采集"}${coverageQueued ? ` · 排队 ${coverageQueued} 条` : ""}`
    : `${health.lastSuccessAt ? `最近采集 ${formatTime(health.lastSuccessAt)}` : "尚无成功采集"} · 点击查看`;
  $("#followingContextBar").hidden = state.tab !== "following";
  const followingCollectionState = health.collectorStatus === "collecting" || coverageRunning > 0
    ? "正在采集"
    : coverageQueued > 0 ? "等待采集" : health.collectorHealthy ? "当前空闲" : "采集未连接";
  $("#followingCollectionState").className = `following-collection-state${followingCollectionState === "正在采集" ? " is-active" : followingCollectionState === "等待采集" ? " is-waiting" : followingCollectionState === "采集未连接" ? " is-offline" : ""}`;
  $("#followingCollectionLabel").textContent = followingCollectionState;
  $("#followingCollectionQueue").textContent = `队列 ${formatNumber(summary.followedQueuedJobs)} · 执行中 ${formatNumber(summary.followedRunningJobs)}`;
  $("#followingContextSummary").textContent = `${formatNumber(summary.followedCreatorCount)} 位博主 · ${formatNumber(summary.followedPostCount)} 条已采动态`;
  $("#followingContextUpdated").textContent = `最近更新 ${formatRefreshTime()}`;
}

function showEmpty(show) {
  $("#emptyState").hidden = !show;
}

function render() {
  renderSummary();
  if (state.tab === "events") renderEvents();
  if (state.tab === "posts") renderPosts();
  if (state.tab === "following") renderFollowing();
  if (state.tab === "queue") renderQueue();
}

function detailMetric(label, value) {
  const block = node("div");
  block.append(node("b", "", value), node("small", "", label));
  return block;
}

function inlineTaskAction(post, label, level, transcript = false) {
  const wrap = node("div", "inline-task-action");
  const button = node("button", "mini-button", label);
  const status = node("div", "analysis-queue-status");
  status.hidden = true;
  const bar = node("span", "analysis-queue-bar");
  const statusLabel = node("small", "", "");
  status.append(bar, statusLabel);
  button.type = "button";
  button.addEventListener("click", async event => {
    event.stopPropagation();
    button.disabled = true;
    try {
      const task = transcript ? await queueTranscript(post.id) : await queueAnalysis(post.id, level);
      if (task?.id) trackAnalysisTask(task.id, post.id, statusLabel, status);
    } catch (error) {
      status.hidden = false;
      statusLabel.textContent = error.message || "任务创建失败";
    } finally {
      button.disabled = false;
    }
  });
  wrap.append(button, status);
  return wrap;
}

function openPost(post) {
  const current = [
    ...(state.dashboard?.hotPosts || []),
    ...(state.dashboard?.candidates || []),
    ...(state.dashboard?.followedPosts || []),
    ...(state.dashboard?.pendingEvidence || [])
  ].find(item => String(item.id) === String(post?.id) && (item.platform || "x") === (post?.platform || "x"));
  if (current) post = { ...post, ...current };
  state.detailSelection = { type: "post", key: `${post.platform || "x"}:${post.id}` };
  $("#drawerEyebrow").textContent = "作品证据";
  $("#drawerTitle").textContent = post.author || post.displayName || post.handle || "作品详情";
  const body = $("#drawerBody");
  body.replaceChildren();
  const overview = node("section", "evidence-block");
  overview.append(node("span", "", "正文"));
  overview.append(node("p", "", post.text || "正文尚未采集"));
  overview.append(node("time", "evidence-time", `发布于 ${formatPublishedTime(post.publishedAt || post.capturedAt)}`));
  if (isEnglishPost(post)) {
    const translation = node("div", "evidence-translation");
    translation.append(node("span", "", "中文翻译"));
    translation.append(node("p", "", post.translationZh || post.translatedText || post.latestAnalysis?.translation_zh || "中文翻译尚未生成，运行一级快评后自动补全。"));
    overview.append(translation);
  }
  const metrics = node("div", "evidence-metrics");
  metrics.append(
    detailMetric("点赞", formatNumber(post.likes)),
    detailMetric("收藏", formatNumber(post.bookmarks)),
    detailMetric("粉丝", formatNumber(post.followers ?? post.creatorFollowers))
  );
  overview.append(metrics);
  body.append(overview);
  const evidence = node("section", "evidence-block");
  evidence.append(node("span", "", "证据完整度"), node("h3", "", evidenceLabel(post)));
  evidence.append(node("p", "", post.missingEvidence?.length ? `当前仍缺少：${post.missingEvidence.join("、")}` : "正文、指标、作者和连续快照均已具备。"));
  if (post.analysisState && post.analysisState !== "not_started") evidence.append(node("p", "", `${analysisLabel(post)}${post.analysisError ? ` · ${post.analysisError}` : ""}`));
  const evidenceActions = node("div", "drawer-actions evidence-actions");
  for (const action of post.availableActions || []) {
    const button = node("button", `mini-button${action === "run_l1" ? " accent-action" : ""}`, actionLabel(action));
    button.type = "button";
    button.addEventListener("click", async event => { event.stopPropagation(); button.disabled = true; try { await runEvidenceAction(post, action); } catch (error) { toast(error.message); } finally { button.disabled = false; } });
    evidenceActions.append(button);
  }
  if (evidenceActions.childElementCount) evidence.append(evidenceActions);
  body.append(evidence);
  const grade = node("section", "evidence-block");
  grade.append(node("span", "", "热度判定"), node("h3", "", `${post.quality?.grade || "候选"} · ${post.quality?.label || reasonLabel(post.quality?.reason)}`));
  grade.append(node("p", "", `${qualityEvidenceCopy(post)}。${post.quality?.ready ? "首次评级证据已冻结。" : `当前评级受限：${reasonLabel(post.quality?.reason)}`}`));
  if (post.quality?.evidence) {
    grade.append(node("p", "", `冻结时间：${formatPublishedTime(post.quality.evidence.frozenAt)} · 基线样本：${post.quality.evidence.samples?.length || 0} 条 · 基线中位数：${formatNumber(post.quality.evidence.baseline)}`));
  }
  body.append(grade);
  const history = node("section", "evidence-block");
  history.append(node("span", "", "历史指标"));
  const historyItems = (Array.isArray(post.metricHistory) ? post.metricHistory : []).slice(0, 6);
  if (!historyItems.length) history.append(node("p", "", "暂无连续指标快照"));
  else {
    const chart = node("div", "history-chart");
    const points = [...historyItems].reverse();
    const maxLikes = Math.max(...points.map(item => Number(item.likes || 0)), 1);
    points.forEach(item => {
      const column = node("div", "history-chart-column");
      const bar = node("span", "history-chart-bar");
      bar.style.height = `${Math.max(10, Math.round(Number(item.likes || 0) / maxLikes * 100))}%`;
      bar.title = `${formatPublishedTime(item.capturedAt)} · 点赞 ${formatNumber(item.likes)}${item.bookmarks === null ? "" : ` · 收藏 ${formatNumber(item.bookmarks)}`}`;
      column.append(bar, node("small", "", formatPublishedTime(item.capturedAt)));
      chart.append(column);
    });
    history.append(chart);
  }
  body.append(history);
  const analysis = node("section", "evidence-block");
  analysis.append(node("span", "", "为什么爆了"));
  analysis.append(node("p", "", post.latestAnalysis?.summary || "一级快评尚未完成。配置模型接口后，正式热帖会自动进入分析队列。"));
  if (Array.isArray(post.latestAnalysis?.factors)) {
    for (const factor of post.latestAnalysis.factors) analysis.append(node("p", "", `• ${factor.explanation || factor}`));
  }
  if (post.latestAnalysis) {
    const systemScore = post.analysisConfidence ? Math.round(Number(post.analysisConfidence.score || 0) * 100) : null;
    const modelScore = Math.round(Number(post.latestAnalysis.confidence || 0) * 100);
    const meta = node("small", "analysis-result-meta", `模型置信度 ${modelScore}% · 证据置信度 ${systemScore ?? "—"}% · ${post.latestAnalysis.life || "未分类"}`);
    analysis.append(meta);
  } else if (post.analysisConfidence) {
    analysis.append(node("small", "analysis-result-meta", `证据置信度 ${Math.round(Number(post.analysisConfidence.score || 0) * 100)}% · 等待一级快评结果`));
  }
  if (post.analysisConfidence?.components) {
    const c = post.analysisConfidence.components;
    analysis.append(node("small", "analysis-evidence-detail", `数据 ${Math.round(c.data * 100)} · R 值 ${Math.round(c.relative * 100)} · 破圈 ${Math.round(c.breakout * 100)} · 内容 ${Math.round(c.content * 100)} · 跨作者 ${Math.round(c.crossAuthor * 100)}`));
  }
  analysis.append(inlineTaskAction(post, post.analysisState === "complete" ? "重新运行一级快评" : "运行一级快评", "l1"));
  body.append(analysis);
  const deep = node("section", "evidence-block analysis-result-block");
  deep.append(node("span", "", "二级深析"));
  if (post.deepAnalysis) {
    const deepFields = [
      ["钩子拆解", post.deepAnalysis.hook],
      ["内容结构", post.deepAnalysis.structure],
      ["受众触发点", post.deepAnalysis.audience_triggers],
      ["可复制要素", post.deepAnalysis.replicable],
      ["不可复制上下文", post.deepAnalysis.non_replicable],
      ["改编建议", post.deepAnalysis.adaptation]
    ];
    for (const [label, value] of deepFields) {
      if (value === undefined || value === null || value === "") continue;
      const row = node("div", "analysis-result-row");
      row.append(node("b", "", label));
      row.append(node("p", "", Array.isArray(value) ? value.join("；") : String(value)));
      deep.append(row);
    }
    const systemScore = post.deepAnalysisConfidence ? Math.round(Number(post.deepAnalysisConfidence.score || 0) * 100) : null;
    deep.append(node("small", "analysis-result-meta", `模型置信度 ${Math.round(Number(post.deepAnalysis.confidence || 0) * 100)}% · 证据置信度 ${systemScore ?? "—"}%`));
  } else {
    const stateCopy = { running: "二级深析进行中", queued: "二级深析已排队", failed: `二级深析失败${post.deepAnalysisError ? `：${post.deepAnalysisError}` : ""}` };
    deep.append(node("p", "", stateCopy[post.deepAnalysisState] || "尚未运行。点击旁边按钮后显示结果。"));
  }
  deep.append(inlineTaskAction(post, post.deepAnalysis ? "重新运行二级深析" : "运行二级深析", "l2"));
  body.append(deep);
  const hasVideoEvidence = post.platform !== "x" && (post.videoUrl || (Array.isArray(post.mediaUrls) && post.mediaUrls.length));
  if (post.platform !== "x" && (hasVideoEvidence || post.transcriptStatus !== "not_requested")) {
    const transcript = node("section", "evidence-block transcript-result-block");
    transcript.append(node("span", "", "视频逐字稿"));
    if (post.transcriptStatus === "complete" && post.transcript) transcript.append(node("p", "", post.transcript));
    else if (post.transcriptStatus === "metadata_only") transcript.append(node("p", "", post.transcriptError || "未发现可验证的视频直链，暂不能提取逐字稿。"));
    else if (post.transcriptStatus === "failed") transcript.append(node("p", "", post.transcriptError || "逐字稿提取失败，可重试。"));
    else transcript.append(node("p", "", "逐字稿尚未完成。"));
    transcript.append(inlineTaskAction(post, post.transcriptStatus === "complete" ? "重新提取逐字稿" : "提取逐字稿", "asr", true));
    body.append(transcript);
  }
  const actionArea = node("section", "drawer-action-area");
  const primaryGroup = node("div", "drawer-action-group drawer-action-group-primary");
  const primaryHeader = node("div", "drawer-action-header");
  primaryHeader.append(node("strong", "", "帖子操作"), node("span", "", "保存、访问与作者关系"));
  const primaryActions = node("div", "drawer-actions drawer-actions-primary");
  const follow = node("button", "mini-button", "加入跟进");
  follow.addEventListener("click", async () => {
    await api(`/posts/${encodeURIComponent(post.id)}/follow-up`, { method: "POST", body: "{}" });
    toast("已提高复采优先级并进入分析队列");
  });
  primaryActions.append(follow);
  if (post.url || post.sourceUrl) {
    const original = node("a", "mini-button", "打开原帖");
    original.href = safeExternalUrl(post.url || post.sourceUrl);
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    primaryActions.append(original);
  }
  if (!post.followed) {
    const follow = node("button", "mini-button", "关注作者");
    follow.addEventListener("click", () => followPostAuthor(post));
    primaryActions.append(follow);
  }
  primaryGroup.append(primaryHeader, primaryActions);
  actionArea.append(primaryGroup);
  body.append(actionArea);
  toggleDrawer($("#detailDrawer"), true);
}

function openEvent(event) {
  state.detailSelection = { type: "event", key: String(event.id) };
  $("#drawerEyebrow").textContent = event.formal ? "热点事件" : "正在聚集";
  $("#drawerTitle").textContent = event.title || "事件详情";
  const body = $("#drawerBody");
  body.replaceChildren();
  const lifecycle = node("section", "evidence-block");
  lifecycle.append(node("span", "", "当前阶段"), node("h3", "", stageLabel(event.stage)));
  lifecycle.append(node("p", "", event.stageReason || event.reason || event.upgradeReason || "阶段由帖子数、独立作者、热帖等级和传播速度共同决定。"));
  body.append(lifecycle);
  if (!event.formal && event.progress) {
    const progress = node("section", "evidence-block");
    progress.append(node("span", "", "形成进度"), node("h3", "", `${event.progress.posts}/8 帖 · ${event.progress.authors}/5 作者`));
    const missing = [];
    if (event.progress.missingPosts) missing.push(`还需 ${event.progress.missingPosts} 条相关帖子`);
    if (event.progress.missingAuthors) missing.push(`还需 ${event.progress.missingAuthors} 位独立作者`);
    if (event.progress.missingHotSignal) missing.push(event.progress.missingHotSignal);
    progress.append(node("p", "", missing.length ? missing.join("；") : "已经达到正式热点门槛，等待下一次确定性重算。"));
    body.append(progress);
  }
  const sources = node("section", "evidence-block");
  sources.append(node("span", "", "传播证据"));
  sources.append(node("p", "", `${event.postCount || 0} 条去重帖子，${event.authorCount || 0} 位独立作者。中文 ${event.languageCounts?.zh || 0} 条，英文 ${event.languageCounts?.en || 0} 条；X ${event.platformCounts?.x || 0} 条，抖音 ${event.platformCounts?.douyin || 0} 条。最早可信来源：${event.earliestSource?.handle || event.earliestSource?.author || "待确认"}。`));
  body.append(sources);
  const timeline = node("section", "evidence-block");
  timeline.append(node("span", "", "传播时间线"));
  timeline.append(node("p", "", `${formatTime(event.firstSeenAt)} 首次出现 · ${formatTime(event.lastSeenAt)} 最近传播${event.acceleration?.accelerating ? " · 最近两小时仍在加速" : ""}`));
  body.append(timeline);
  const examples = node("section", "evidence-block");
  examples.append(node("span", "", "相关帖子榜单"));
  for (const post of event.posts || event.representativePosts || []) {
    const grade = qualityLabel(post.quality) || "支撑帖";
    const button = node("button", "ranked-post-button", `${grade} · ${post.author || post.handle || "作者"} · ${String(post.text || "").slice(0, 54)}`);
    button.addEventListener("click", () => openPost(post));
    examples.append(button);
  }
  body.append(examples);
  toggleDrawer($("#detailDrawer"), true);
}

function refreshOpenGraphDetail(graph) {
  if (!state.detailSelection || $("#detailDrawer").getAttribute("aria-hidden") === "true") return;
  if (state.detailSelection.type === "event") {
    const event = (graph.clusters || []).find(item => String(item.id) === state.detailSelection.key);
    if (event) {
      openEvent(event);
    } else {
      state.detailSelection = null;
      toggleDrawer($("#detailDrawer"), false);
    }
    return;
  }
  const posts = [
    ...(graph.clusters || []).flatMap(cluster => cluster.posts || []),
    ...(graph.standalones || [])
  ];
  const post = posts.find(item => `${item.platform || "x"}:${item.id}` === state.detailSelection.key);
  if (post) {
    openPost(post);
  } else {
    state.detailSelection = null;
    toggleDrawer($("#detailDrawer"), false);
  }
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "#";
  } catch {
    return "#";
  }
}

async function queueAnalysis(postId, level) {
  try {
    const result = await api(`/posts/${encodeURIComponent(postId)}/analyze/${level}`, { method: "POST", body: "{}" });
    toast(level === "l2" ? "二级深析已进入手动队列" : "一级快评已进入队列");
    return result.task;
  } catch (error) {
    if (level === "l2" && error.confirmationRequired) {
      const approved = window.confirm(`${error.message}\n\n仍要作为手动超预算任务入队吗？`);
      if (!approved) return;
      const result = await api(`/posts/${encodeURIComponent(postId)}/analyze/l2`, { method: "POST", body: JSON.stringify({ confirmedOverBudget: true }) });
      toast("二级深析已按手动超预算任务入队");
      return result.task;
    }
    toast(error.message);
  }
}

async function trackAnalysisTask(taskId, postId, label, container) {
  container.hidden = false; label.textContent = "排队中…";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const payload = await api("/analysis/tasks");
      const task = (payload.items || []).find(item => item.id === taskId);
      if (!task) return;
      const ahead = task.status === "queued" ? (payload.items || []).filter(item => item.status === "queued" && item.createdAt <= task.createdAt).length - 1 : 0;
      const working = task.taskType === "l2" ? "深度拆解" : task.taskType === "asr" ? "逐字稿" : "快评";
      const text = task.status === "queued" ? `排队中 · 前面 ${Math.max(0, ahead)} 个任务` : task.status === "running" ? `${working}中` : task.status === "complete" ? `${working}完成` : task.status === "failed" ? "处理失败" : task.status === "cancelled" ? "已取消" : task.status;
      label.textContent = task.error ? `${text}：${task.error}` : text;
      container.classList.toggle("is-running", task.status === "queued" || task.status === "running");
      if (task.status === "complete") {
        await load();
        const updated = [
          ...(state.dashboard?.hotPosts || []),
          ...(state.dashboard?.candidates || []),
          ...(state.dashboard?.followedPosts || []),
          ...(state.dashboard?.pendingEvidence || [])
        ].find(item => String(item.id) === String(postId));
        if (updated) openPost(updated);
        return;
      }
      if (["failed", "cancelled"].includes(task.status)) return;
    } catch { label.textContent = "状态读取失败，任务仍在后台处理"; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  label.textContent = "任务仍在处理中，可稍后查看结果";
}

async function queueTranscript(postId) {
  try {
    const result = await api(`/posts/${encodeURIComponent(postId)}/transcript`, { method: "POST", body: "{}" });
    toast(result.task.status === "metadata_only" ? "尚无视频直链，已等待采集器补充" : "逐字稿任务已入队");
    return result.task;
  } catch (error) { toast(error.message); }
}

async function followPostAuthor(post) {
  try {
    await api("/follows", {
      method: "POST",
      body: JSON.stringify({ platform: post.platform, handle: post.handle, displayName: post.author || post.displayName, profileUrl: post.profileUrl })
    });
    toast("已加入关注并安排首次采集");
    await load();
  } catch (error) { toast(error.message); }
}

function toggleDrawer(drawer, open) {
  drawer.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.style.overflow = open ? "hidden" : "";
}

function settingsCard(title, copy) {
  const card = node("section", "settings-card");
  const header = node("header");
  const text = node("div", "settings-card-heading");
  text.append(node("h3", "", title), node("p", "", copy));
  header.append(text);
  card.append(header);
  return card;
}

function modelField(label, control) {
  const field = node("label", "model-field");
  field.append(node("span", "", label), control);
  return field;
}

function monitoringRuleInput(rule, terms) {
  return {
    id: rule.id,
    name: rule.name,
    category: rule.category,
    terms,
    excludedTerms: rule.excludedTerms || [],
    platforms: rule.platforms,
    languages: rule.languages,
    priority: rule.priority,
    enabled: true
  };
}

async function saveRuleTerms(rule, terms, message) {
  const cleaned = [...new Set(terms.map(value => String(value).trim()).filter(Boolean))];
  if (!cleaned.length) return toast("每个词组至少保留一个监控词");
  await api("/monitoring-rules", { method: "POST", body: JSON.stringify(monitoringRuleInput(rule, cleaned)) });
  toast(message);
  invalidateSettingsCache("terms");
  renderSettings();
}

async function saveRuleExclusions(rule, terms, message) {
  const cleaned = [...new Set(terms.map(value => String(value).trim()).filter(Boolean))];
  await api("/monitoring-rules", { method: "POST", body: JSON.stringify({ ...monitoringRuleInput(rule, rule.terms), excludedTerms: cleaned }) });
  toast(message);
  invalidateSettingsCache("terms");
  renderSettings();
}

function monitoringTerm(rule, term, kind = "term") {
  const item = node("span", `monitoring-term ${kind === "exclude" ? "monitoring-exclusion" : ""}`);
  const label = node("span", "monitoring-term-label", term);
  const actions = node("span", "monitoring-term-actions");
  const edit = node("button", "monitoring-term-edit");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 1024 1024");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M808.96 341.2992a32.9728 32.9728 0 0 0 0-47.7696L730.4704 215.04a32.9728 32.9728 0 0 0-47.7696 0l-61.44 61.44 129.6384 129.6384L808.96 341.2992zM204.8 689.5616V819.2h129.6896l375.5008-378.88-129.6384-129.6896L204.8 689.4592v0.1024z");
  path.setAttribute("fill", "currentColor");
  icon.append(path);
  edit.append(icon);
  edit.type = "button";
  edit.setAttribute("aria-label", `编辑 ${term}`);
  edit.addEventListener("click", () => {
    const input = node("input", "monitoring-term-input");
    input.value = term;
    item.classList.add("is-editing");
    item.replaceChildren(input);
    let saving = false;
    let cancelled = false;
    const commit = async () => {
      if (saving || cancelled) return;
      const value = input.value.trim();
      if (!value || value === term) return renderSettings();
      saving = true;
      try {
        const values = kind === "exclude" ? (rule.excludedTerms || []) : rule.terms;
        const save = kind === "exclude" ? saveRuleExclusions : saveRuleTerms;
        await save(rule, values.map(value => value === term ? input.value : value), kind === "exclude" ? "排除词已更新" : "监控词已更新");
      } catch (error) {
        saving = false;
        toast(`更新失败：${error.message}`);
        renderSettings();
      }
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") { cancelled = true; renderSettings(); }
    });
    input.addEventListener("blur", commit);
    input.focus();
    input.select();
  });
  const remove = node("button", "monitoring-term-remove", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `删除 ${term}`);
  remove.addEventListener("click", async () => {
    if (!window.confirm(`删除监控词“${term}”？`)) return;
    try {
      const values = kind === "exclude" ? (rule.excludedTerms || []) : rule.terms;
      const save = kind === "exclude" ? saveRuleExclusions : saveRuleTerms;
      await save(rule, values.filter(value => value !== term), kind === "exclude" ? "排除词已删除" : "监控词已删除");
    } catch (error) { toast(`删除失败：${error.message}`); }
  });
  actions.append(edit, remove);
  item.append(label, actions);
  return item;
}

function addMonitoringTerm(rule, kind = "term") {
  const isExclude = kind === "exclude";
  const add = node("button", "monitoring-term-add", isExclude ? "+ 添加排除词" : "+ 添加");
  add.type = "button";
  add.setAttribute("aria-label", `向“${rule.name}”添加监控词`);
  add.title = "添加词语";
  add.addEventListener("click", () => {
    const input = node("input", "monitoring-term-input");
    input.placeholder = "输入新监控词";
    add.replaceWith(input);
    let saving = false;
    let cancelled = false;
    const commit = async () => {
      if (saving || cancelled) return;
      const value = input.value.trim();
      if (!value) return renderSettings();
      saving = true;
      try {
        if (isExclude) await saveRuleExclusions(rule, [...(rule.excludedTerms || []), value], "新排除词已保存");
        else await saveRuleTerms(rule, [...rule.terms, value], "新词已加入监控并安排补采");
      } catch (error) {
        saving = false;
        toast(`添加失败：${error.message}`);
        renderSettings();
      }
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") { cancelled = true; renderSettings(); }
    });
    input.addEventListener("blur", commit);
    input.focus();
  });
  return add;
}

function editMonitoringRule(rule) {
  const isEditing = state.editingRuleId === rule.id;
  const edit = node("button", `monitoring-rule-edit${isEditing ? " is-complete" : ""}`, isEditing ? "完成" : undefined);
  if (!isEditing) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 1024 1024");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    for (const data of [
      ["M838.460952 817.127619H233.569524V212.23619h396.190476v48.761905h-347.428571v507.367619h507.367619V459.702857h48.761904v357.424762z", "#8a8a8a"],
      ["M500.175238 547.84l331.008-331.02019 34.486857 34.486857-331.008 331.008z", "#8a8a8a"]
    ]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", data[0]);
      path.setAttribute("fill", data[1]);
      icon.append(path);
    }
    edit.append(icon);
  }
  edit.type = "button";
  edit.setAttribute("aria-label", `编辑“${rule.name}”`);
  edit.title = isEditing ? "完成编辑" : "编辑名称和词语";
  edit.addEventListener("click", () => {
    state.editingRuleId = state.editingRuleId === rule.id ? "" : rule.id;
    renderSettings();
  });
  return edit;
}

function editableRuleName(rule) {
  const input = node("input", "monitoring-rule-name-input");
  input.value = rule.name;
  input.setAttribute("aria-label", "趋势名称");
  let saving = false;
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") { state.editingRuleId = ""; renderSettings(); }
  });
  input.addEventListener("blur", async () => {
    const name = input.value.trim();
    if (saving || !name || name === rule.name) return;
    saving = true;
    try {
      await api("/monitoring-rules", { method: "POST", body: JSON.stringify({ ...monitoringRuleInput(rule, rule.terms), name }) });
      toast("趋势名称已更新");
      renderSettings();
    } catch (error) {
      saving = false;
      toast(`更新失败：${error.message}`);
    }
  });
  return input;
}

async function renderSettings() {
  const renderId = ++settingsRenderSeq;
  const renderTab = state.settingsTab;
  const stale = () => renderId !== settingsRenderSeq || state.settingsTab !== renderTab;
  const target = $("#settingsBody");
  target.dataset.view = renderTab;
  if (settingsDisplayedTab !== renderTab || !target.children.length) {
    target.replaceChildren(node("p", "settings-loading", `${renderTab === "models" ? "正在读取模型配置" : renderTab === "collector" ? "正在读取采集管理" : renderTab === "notifications" ? "正在读取通知设置" : "正在读取监控词"}…`));
    settingsDisplayedTab = renderTab;
  }
  try {
    if (state.settingsTab === "terms") {
      let items;
      if (settingsCacheFresh("terms")) items = settingsDataCache.terms;
      else try {
        ({ items } = await api("/monitoring-rules"));
        settingsDataCache.terms = items;
        settingsDataFetchedAt.terms = Date.now();
      } catch (error) {
        if (!settingsDataCache.terms) throw error;
        items = settingsDataCache.terms;
        toast(`监控词读取失败，已显示上次数据：${error.message}`);
      }
      if (stale()) return;
      const termsFingerprint = JSON.stringify({ items, suggestions: state.hotspotGraph?.clusters || [] });
      if (settingsDataFingerprint.terms === termsFingerprint && target.children.length) return;
      settingsDataFingerprint.terms = termsFingerprint;
      target.replaceChildren();
      const systemRuleIds = new Set(["rule-subjects", "rule-general", "rule-events", "rule-domains"]);
      const activeItems = items.filter(rule => rule.enabled !== false);
      for (const rule of activeItems) {
        const isEditing = state.editingRuleId === rule.id;
        const card = settingsCard(rule.name, `${rule.platforms.join(" / ")} · 版本 ${rule.version} · ${rule.enabled ? "已启用" : "已停用"}`);
        card.classList.toggle("is-rule-editing", isEditing);
        const heading = card.querySelector(".settings-card-heading");
        const title = heading.querySelector("h3");
        const titleRow = node("div", "rule-title-row");
        title.replaceWith(titleRow);
        titleRow.append(isEditing ? editableRuleName(rule) : title, editMonitoringRule(rule));
        const meta = node("div", "rule-meta-row");
        meta.append(node("span", `rule-origin ${systemRuleIds.has(rule.id) ? "is-system" : "is-manual"}`, systemRuleIds.has(rule.id) ? "系统预置" : "手动添加"));
        heading.append(meta);
        const tags = node("div", "tag-list");
        for (const term of rule.terms) tags.append(monitoringTerm(rule, term));
        tags.append(addMonitoringTerm(rule));
        card.append(tags);
        const exclusions = node("div", "rule-exclusions");
        exclusions.append(node("span", "rule-exclusions-label", "排除词"));
        const exclusionTags = node("div", "tag-list");
        for (const term of (rule.excludedTerms || [])) exclusionTags.append(monitoringTerm(rule, term, "exclude"));
        if (isEditing) exclusionTags.append(addMonitoringTerm(rule, "exclude"));
        exclusions.append(exclusionTags);
        card.append(exclusions);
        target.append(card);
      }
      const suggestions = (state.hotspotGraph?.clusters || [])
        .filter(item => Number(item.postCount || 0) >= 3 && Number(item.authorCount || 0) >= 2)
        .sort((a, b) => Number(b.formal) - Number(a.formal) || Number(b.heat || 0) - Number(a.heat || 0))
        .slice(0, 8);
      if (suggestions.length) {
        const suggestionCard = settingsCard("热点自动监控", "达到多作者聚集条件后自动进入，不需要手动添加。");
        suggestionCard.classList.add("settings-suggestion-card");
        const suggestionList = node("div", "settings-suggestion-list");
        for (const suggestion of suggestions) {
          const item = node("div", "settings-suggestion-item");
          const copy = node("div");
          copy.append(node("b", "", suggestion.title), node("small", "", `${suggestion.postCount || 0} 帖 · ${suggestion.authorCount || 0} 作者 · ${suggestion.formal ? "正式热点" : "正在聚集"}`));
          item.append(copy, node("span", `auto-monitor-state ${suggestion.formal ? "is-formal" : ""}`, suggestion.formal ? "重点跟踪" : "自动跟踪"));
          suggestionList.append(item);
        }
        suggestionCard.append(suggestionList);
        target.append(suggestionCard);
      }
      const form = settingsCard("新增监控词组", "保存后安排最近 7 天的低优先级补采，不阻塞实时任务。");
      form.classList.add("settings-card-create");
      const name = node("input"); name.placeholder = "名称";
      const terms = node("input"); terms.placeholder = "多个词使用逗号分隔";
      const nameField = node("label", "settings-field");
      nameField.append(node("span", "", "词组名称"), name);
      const termsField = node("label", "settings-field settings-field-wide");
      termsField.append(node("span", "", "监控词"), terms);
      const button = node("button", "accent-button", "保存并补采 7 天");
      button.addEventListener("click", async () => {
        const list = terms.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
        if (!name.value.trim() || !list.length) return toast("请填写名称和监控词");
        await api("/monitoring-rules", { method: "POST", body: JSON.stringify({ name: name.value, category: "domain", terms: list, platforms: ["x", "douyin"], languages: ["zh", "en"], enabled: true }) });
        toast("监控词已保存");
        invalidateSettingsCache("terms");
        renderSettings();
      });
      const fields = node("div", "settings-create-fields");
      fields.append(nameField, termsField);
      const footer = node("div", "settings-create-footer");
      footer.append(node("span", "", "覆盖 X 与抖音 · 中文与英文"), button);
      form.append(fields, footer);
      target.append(form);
    }
    if (state.settingsTab === "models") {
      const cached = settingsDataCache.models;
      let routePayload;
      let profilesPayload;
      let usagePayload;
      if (settingsCacheFresh("models")) ({ routePayload, profilesPayload, usagePayload } = cached);
      else {
        const [routesResult, profilesResult, usageResult] = await Promise.allSettled([api("/model-routes"), api("/model-profiles"), api("/model-usage")]);
        routePayload = routesResult.status === "fulfilled" ? routesResult.value : cached?.routePayload;
        profilesPayload = profilesResult.status === "fulfilled" ? profilesResult.value : cached?.profilesPayload;
        usagePayload = usageResult.status === "fulfilled" ? usageResult.value : (cached?.usagePayload || { items: [] });
        if (!routePayload || !profilesPayload) {
          const failed = [routesResult, profilesResult].find(result => result.status === "rejected");
          throw failed?.reason || new Error("模型配置读取失败");
        }
        if (usageResult.status === "rejected") toast(`模型调用记录读取失败，模型档案仍可用：${usageResult.reason?.message || "暂时不可用"}`);
        settingsDataCache.models = { routePayload, profilesPayload, usagePayload };
        settingsDataFetchedAt.models = Date.now();
      }
      const { items, taskTypes } = routePayload;
      if (stale()) return;
      const modelsFingerprint = JSON.stringify({ routePayload, profilesPayload, usagePayload });
      if (settingsDataFingerprint.models === modelsFingerprint && target.children.length) return;
      settingsDataFingerprint.models = modelsFingerprint;
      const profiles = profilesPayload.items || [];
      target.replaceChildren();
      const usage = usagePayload.items || [];
      const modelList = node("section", "model-list");
      const modelListHeading = node("div", "model-list-heading");
      modelListHeading.append(node("h3", "model-list-title", "模型管理"));
      const addModel = node("button", "model-add", "+ 添加模型"); addModel.type = "button"; modelListHeading.append(addModel);
      modelList.append(modelListHeading);
      if (!profiles.length) modelList.append(node("p", "model-empty", "还没有模型，使用下面的表单添加第一个模型。"));
      for (const profile of profiles) {
        const card = node("article", profile.enabled ? "model-summary-card" : "model-summary-card model-summary-disabled");
        card.dataset.profileId = profile.id;
        const bound = items.filter(item => item.profileId === profile.id).map(item => taskTypes.find(type => type.id === item.taskType)?.label || item.taskType);
        const activity = usage.find(item => item.provider === profile.provider && item.model === profile.model);
        const head = node("div", "model-summary-head");
        head.append(node("strong", "", profile.name), node("small", "", `${profile.provider} / ${profile.model}`));
        const state = node("span", profile.enabled ? (profile.hasApiKey ? "model-health-ok" : "model-health-missing") : "model-health-disabled", profile.enabled ? (profile.hasApiKey ? "已启用 · 密钥已配置" : "已启用 · 缺少密钥") : "已停用");
        const toggle = node("button", profile.enabled ? "model-remove" : "model-enable", profile.enabled ? "停用" : "启用"); toggle.type = "button"; toggle.title = profile.enabled ? "停用模型" : "启用模型";
        toggle.addEventListener("click", async () => {
          if (profile.enabled && !window.confirm(`停用模型“${profile.name}”？`)) return;
          await api(profile.enabled ? `/model-profiles/${encodeURIComponent(profile.id)}` : `/model-profiles/${encodeURIComponent(profile.id)}/enable`, { method: profile.enabled ? "DELETE" : "POST", body: profile.enabled ? undefined : "{}" });
          toast(profile.enabled ? "模型已停用" : "模型已启用"); invalidateSettingsCache("models"); renderSettings();
        });
        const meta = node("div", "model-summary-meta");
        meta.append(node("span", "", bound.length ? bound.join("、") : "未绑定业务"), node("span", "", activity ? `调用 ${activity.calls} 次 · 费用 ¥${Number(activity.estimatedCny ?? activity.estimatedUsd ?? 0).toFixed(4)}` : "暂无调用记录"), state, toggle);
        card.append(head, meta); modelList.append(card);
      }
      target.append(modelList);
      const profileCard = settingsCard("模型配置", "模型档案可被多个任务路由复用；接口密钥会加密保存。");
      profileCard.classList.add("model-editor-card");
      profileCard.hidden = true;
      const profileSelect = node("select");
      profileSelect.append(node("option", "", "选择已有模型档案"));
      for (const profile of profiles) profileSelect.append(Object.assign(node("option", "", `${profile.name} · ${profile.provider} / ${profile.model}`), { value: profile.id }));
      const profileName = node("input"); profileName.placeholder = "模型档案名称";
      const profileProvider = node("input"); profileProvider.placeholder = "供应商";
      const profileApiStyle = node("select");
      profileApiStyle.append(
        Object.assign(node("option", "", "OpenAI 兼容接口"), { value: "chat_completions" }),
        Object.assign(node("option", "", "Anthropic 兼容接口"), { value: "anthropic" })
      );
      const profileModel = node("input"); profileModel.placeholder = "模型名称";
      const profileBaseUrl = node("input"); profileBaseUrl.placeholder = "接口基础地址，例如 https://你的服务/v1";
      const profileKeyEnv = node("input"); profileKeyEnv.type = "password"; profileKeyEnv.placeholder = "直接粘贴接口密钥";
      let profileKeyChanged = false;
      profileKeyEnv.addEventListener("focus", () => { if (!profileKeyChanged && profileKeyEnv.value) profileKeyEnv.select(); });
      profileKeyEnv.addEventListener("input", () => { profileKeyChanged = true; });
      profileApiStyle.addEventListener("change", () => {
        profileBaseUrl.placeholder = profileApiStyle.value === "anthropic" ? "Anthropic 接口地址，例如 https://api.deepseek.com/anthropic" : "OpenAI 接口地址，例如 https://api.deepseek.com";
      });
      const profilePriceVersion = node("input"); profilePriceVersion.placeholder = "价格版本，例如 2026-08";
      const profileInputPrice = node("input"); profileInputPrice.type = "number"; profileInputPrice.min = "0"; profileInputPrice.step = "0.001"; profileInputPrice.placeholder = "例如 1.00 元 / 百万令牌";
      const profileCacheHitPrice = node("input"); profileCacheHitPrice.type = "number"; profileCacheHitPrice.min = "0"; profileCacheHitPrice.step = "0.001"; profileCacheHitPrice.placeholder = "例如 0.02 元 / 百万令牌";
      const profileOutputPrice = node("input"); profileOutputPrice.type = "number"; profileOutputPrice.min = "0"; profileOutputPrice.step = "0.001"; profileOutputPrice.placeholder = "例如 2.00 元 / 百万令牌";
      const profileMaxInput = node("input"); profileMaxInput.type = "number"; profileMaxInput.min = "1"; profileMaxInput.placeholder = "例如 1000000（1M）"; profileMaxInput.value = 8000;
      const profileMaxOutput = node("input"); profileMaxOutput.type = "number"; profileMaxOutput.min = "1"; profileMaxOutput.placeholder = "例如 384000（384K）"; profileMaxOutput.value = 1200;
      const profileSave = node("button", "mini-button", "保存模型档案");
      const profileTest = node("button", "mini-button", "测试连接");
      const profileClose = node("button", "mini-button", "关闭"); profileClose.type = "button";
      const profileActions = node("div", "model-profile-actions"); profileActions.append(profileSave, profileClose);
      const profileTestRow = node("div", "model-test-row"); profileTestRow.append(profileTest);
      const profileProgress = node("div", "model-test-progress"); profileProgress.hidden = true;
      const profileProgressBar = node("span", "model-test-progress-bar"); profileProgress.append(profileProgressBar);
      const profileTestStatus = node("p", "model-test-status", "");
      profileTestRow.append(profileTestStatus, profileProgress);
      profileSelect.addEventListener("change", () => {
        const selected = profiles.find(profile => profile.id === profileSelect.value);
        if (!selected) return;
        profileName.value = selected.name; profileProvider.value = selected.provider; profileModel.value = selected.model;
        profileApiStyle.value = selected.apiStyle || "chat_completions";
        profileBaseUrl.value = selected.baseUrl; profileKeyEnv.value = selected.apiKeyMasked || ""; profileKeyChanged = false;
        profilePriceVersion.value = selected.priceVersion; profileInputPrice.value = selected.inputUsdPerMillion;
        profileCacheHitPrice.value = selected.cacheHitUsdPerMillion ?? "";
        profileOutputPrice.value = selected.outputUsdPerMillion; profileMaxInput.value = selected.maxInputTokens; profileMaxOutput.value = selected.maxOutputTokens;
      });
      profileSave.addEventListener("click", async () => {
        setButtonBusy(profileSave, true, "保存中…");
        try {
          const saved = await api(profileSelect.value ? `/model-profiles/${encodeURIComponent(profileSelect.value)}` : "/model-profiles", { method: profileSelect.value ? "PUT" : "POST", body: JSON.stringify({
            name: profileName.value, provider: profileProvider.value, model: profileModel.value, baseUrl: profileBaseUrl.value,
            apiKey: profileKeyChanged ? profileKeyEnv.value : "", apiKeyEnv: "", apiStyle: profileApiStyle.value, priceVersion: new Date().toISOString().slice(0, 10),
            inputUsdPerMillion: Number(profileInputPrice.value), outputUsdPerMillion: Number(profileOutputPrice.value),
            cacheHitUsdPerMillion: Number(profileCacheHitPrice.value),
            maxInputTokens: Number(profileMaxInput.value), maxOutputTokens: Number(profileMaxOutput.value), enabled: true
          }) });
          toast("模型档案已保存"); invalidateSettingsCache("models"); renderSettings();
        } catch (error) { toast(`模型档案保存失败：${error.message}`); }
        finally { setButtonBusy(profileSave, false); }
      });
      profileTest.addEventListener("click", async () => {
        setButtonBusy(profileTest, true, "测试中…"); profileSave.disabled = true; profileTestStatus.textContent = "正在连接接口…"; profileProgress.hidden = false;
        try {
          await new Promise(resolve => setTimeout(resolve, 180));
          profileTestStatus.textContent = "正在验证返回格式…";
          const testPath = profileSelect.value && !profileKeyChanged ? `/model-profiles/${encodeURIComponent(profileSelect.value)}/test` : "/model-profiles/test";
          await api(testPath, { method: "POST", body: JSON.stringify({ provider: profileProvider.value, model: profileModel.value, baseUrl: profileBaseUrl.value, apiKey: profileKeyEnv.value, apiStyle: profileApiStyle.value }) });
          profileProgress.hidden = true; profileTestStatus.textContent = "连接测试成功"; toast("模型接口测试成功");
        }
        catch (error) { profileProgress.hidden = true; profileTestStatus.textContent = `连接测试失败：${error.message}`; toast(`连接测试失败：${error.message}`); }
        finally { setButtonBusy(profileTest, false); profileSave.disabled = false; }
      });
      profileClose.addEventListener("click", () => { profileCard.hidden = true; profileTestStatus.textContent = ""; profileProgress.hidden = true; });
      profileCard.classList.add("model-profile-card");
      const costLimits = node("details", "model-cost-limits");
      costLimits.append(node("summary", "成本与限制（可选）"), modelField("缓存未命中输入价格（人民币 / 百万令牌）", profileInputPrice), modelField("缓存命中输入价格（人民币 / 百万令牌）", profileCacheHitPrice), modelField("输出价格（人民币 / 百万令牌）", profileOutputPrice), modelField("上下文长度（令牌）", profileMaxInput), modelField("输出长度（令牌）", profileMaxOutput));
      profileCard.append(modelField("档案名称", profileName), modelField("供应商（可选）", profileProvider), modelField("接口协议", profileApiStyle), modelField("模型标识", profileModel), modelField("接口地址", profileBaseUrl), modelField("接口密钥", profileKeyEnv), costLimits, profileTestRow, profileActions);
      target.append(profileCard);
      for (const card of modelList.querySelectorAll(".model-summary-card")) card.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        profileSelect.value = card.dataset.profileId;
        profileSelect.dispatchEvent(new Event("change"));
        profileCard.hidden = false;
      });
      addModel.addEventListener("click", () => {
        profileSelect.value = ""; profileName.value = ""; profileProvider.value = ""; profileModel.value = ""; profileKeyChanged = false;
        profileApiStyle.value = "chat_completions"; profileBaseUrl.value = ""; profileKeyEnv.value = "";
        profilePriceVersion.value = ""; profileInputPrice.value = ""; profileCacheHitPrice.value = ""; profileOutputPrice.value = ""; profileMaxInput.value = 8000; profileMaxOutput.value = 1200;
        profileCard.hidden = false;
      });
      const businessCard = settingsCard("业务类型配置", "选择一个已添加的模型，再指定它负责的业务类型。");
      businessCard.classList.add("business-config-card");
      const addBusiness = node("button", "model-add", "+ 添加配置"); addBusiness.type = "button";
      const businessHeading = businessCard.querySelector(".settings-card-heading");
      const businessTitle = businessHeading?.querySelector("h3");
      if (businessHeading && businessTitle) {
        const titleRow = node("div", "settings-inline-title");
        businessTitle.replaceWith(titleRow); titleRow.append(businessTitle, addBusiness);
      }
      const businessEditor = node("div", "business-config-editor"); businessEditor.hidden = true;
      const businessName = node("input"); businessName.placeholder = "业务配置名称";
      const businessProfile = node("select");
      businessProfile.append(node("option", "", "选择模型"));
      for (const profile of profiles) businessProfile.append(Object.assign(node("option", "", profile.name), { value: profile.id }));
      const businessChecks = new Map();
      const businessTypes = node("div", "business-type-list");
      for (const type of taskTypes) { const label = node("label", "model-task-check"); const check = node("input"); check.type = "checkbox"; label.append(check, node("span", "", type.label)); businessTypes.append(label); businessChecks.set(type.id, check); }
      const businessSave = node("button", "mini-button", "保存业务配置");
      const businessBudget = node("input"); businessBudget.type = "number"; businessBudget.min = "0"; businessBudget.step = "0.01"; businessBudget.value = "5"; businessBudget.placeholder = "每日预算（人民币）";
      const businessVersions = node("input"); businessVersions.type = "number"; businessVersions.min = "1"; businessVersions.step = "1"; businessVersions.value = "100"; businessVersions.placeholder = "每日最多调用次数";
      const businessClose = node("button", "mini-button", "关闭"); businessClose.type = "button";
      const businessActions = node("div", "business-config-actions"); businessActions.append(businessSave, businessClose);
      businessSave.addEventListener("click", async () => {
        const profile = profiles.find(item => item.id === businessProfile.value);
        if (!businessName.value.trim()) return toast("请填写业务名称");
        if (!profile) return toast("请先选择模型");
        setButtonBusy(businessSave, true, "保存中…");
        try {
          for (const type of taskTypes) {
            const checked = businessChecks.get(type.id).checked;
            const existing = items.find(item => item.taskType === type.id);
            if (!checked && existing?.profileId !== profile.id) continue;
            await api("/model-routes", { method: "PUT", body: JSON.stringify({ taskType: type.id, businessName: businessName.value.trim(), profileId: checked ? profile.id : null, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, apiKeyEnv: profile.apiKeyEnv, apiStyle: profile.apiStyle, priceVersion: profile.priceVersion, inputUsdPerMillion: profile.inputUsdPerMillion, outputUsdPerMillion: profile.outputUsdPerMillion, maxInputTokens: profile.maxInputTokens, maxOutputTokens: profile.maxOutputTokens, dailyBudgetCny: Number(businessBudget.value), dailyVersions: Number(businessVersions.value), enabled: checked }) });
          }
          toast("业务配置已保存"); invalidateSettingsCache("models"); renderSettings();
        } catch (error) { toast(`业务配置保存失败：${error.message}`); }
        finally { setButtonBusy(businessSave, false); }
      });
      businessClose.addEventListener("click", () => { businessEditor.hidden = true; });
      const businessList = node("div", "business-config-list");
      const groupedBusiness = new Map();
      for (const item of items.filter(route => route.profileId && route.enabled)) {
        const profile = profiles.find(model => model.id === item.profileId); if (!profile) continue;
        const key = `${item.businessName || item.taskType}:${profile.id}`;
        const group = groupedBusiness.get(key) || { name: item.businessName || "未命名业务", profile, types: [], dailyBudgetCny: item.dailyBudgetCny ?? 5, dailyVersions: item.dailyVersions ?? 100 };
        group.types.push(taskTypes.find(type => type.id === item.taskType)?.label || item.taskType); groupedBusiness.set(key, group);
      }
      for (const group of groupedBusiness.values()) {
        const row = node("div", "business-config-row", `${group.name} · ${group.profile.name} · ${group.types.join("、")}`);
        row.tabIndex = 0;
        row.addEventListener("click", () => { businessName.value = group.name; businessProfile.value = group.profile.id; businessBudget.value = group.dailyBudgetCny; businessVersions.value = group.dailyVersions; for (const [typeId, check] of businessChecks) check.checked = group.types.includes(taskTypes.find(type => type.id === typeId)?.label || typeId); businessEditor.hidden = false; });
        businessList.append(row);
      }
      businessEditor.append(modelField("业务名称", businessName), modelField("使用模型", businessProfile), modelField("每日预算（人民币）", businessBudget), modelField("每日最多调用次数", businessVersions), businessTypes, businessActions);
      businessCard.append(businessEditor, businessList);
      addBusiness.addEventListener("click", () => { businessName.value = ""; businessProfile.value = ""; businessBudget.value = "5"; businessVersions.value = "100"; for (const check of businessChecks.values()) check.checked = false; businessEditor.hidden = false; });
      target.append(businessCard);
    }
    if (state.settingsTab === "collector") {
      let collection;
    if (settingsCacheFresh("collector")) collection = settingsDataCache.collector;
      else try {
        collection = await api("/collection-settings");
        settingsDataCache.collector = collection;
        settingsDataFetchedAt.collector = Date.now();
      } catch (error) {
        if (!settingsDataCache.collector) throw error;
        collection = settingsDataCache.collector;
        toast(`采集设置读取失败，已显示上次数据：${error.message}`);
      }
      if (stale()) return;
      const health = state.dashboard?.health || {};
      const collectorFingerprint = JSON.stringify({ collection, health });
      if (settingsDataFingerprint.collector === collectorFingerprint && target.children.length) return;
      settingsDataFingerprint.collector = collectorFingerprint;
      target.replaceChildren();
      const collectors = Array.isArray(collection.collectors) ? collection.collectors : [];
      const profile = collection.profile || {};
      const registryCard = settingsCard("采集器管理", "管理系统里的采集器档案；令牌加密保存，采集器本身与采集策略分开。");
      const registryList = node("div", "collector-registry-list");
      const registryEditor = node("div", "collector-registry-editor"); registryEditor.hidden = true;
      const editorName = node("input", "settings-input"); editorName.placeholder = "采集器名称";
      const editorType = node("select", "settings-select");
      for (const [value, label] of [["extension", "系统自带采集器"], ["x_api", "X 官方接口采集器"], ["6551", "6551云端采集器"]]) { const option = node("option", "", label); option.value = value; editorType.append(option); }
      const editorToken = node("input", "settings-input"); editorToken.type = "password"; editorToken.placeholder = "访问令牌（留空表示沿用已保存令牌）"; editorToken.autocomplete = "new-password";
      const editorRateMode = node("select", "settings-select"); for (const [value, label] of [["limited", "有限制"], ["unlimited", "不限速（仍受平台安全上限约束）"]]) { const option = node("option", "", label); option.value = value; editorRateMode.append(option); }
      const editorRpm = node("input", "settings-input"); editorRpm.type = "number"; editorRpm.min = "1"; editorRpm.placeholder = "每分钟请求数";
      const editorDaily = node("input", "settings-input"); editorDaily.type = "number"; editorDaily.min = "1"; editorDaily.placeholder = "每日任务上限";
      const editorConcurrency = node("input", "settings-input"); editorConcurrency.type = "number"; editorConcurrency.min = "1"; editorConcurrency.placeholder = "并发数";
      editorName.title = "采集器在系统中的显示名称";
      editorType.title = "采集器实现类型";
      editorToken.title = "采集器访问令牌；留空表示沿用已保存令牌";
      editorRateMode.title = "选择是否启用请求速率限制";
      editorRpm.title = "每分钟最多允许的请求数量";
      editorDaily.title = "每天最多允许领取的采集任务数量";
      editorConcurrency.title = "同时执行的采集任务数量";
      let editingCollectorId = null;
      const closeRegistryEditor = () => { registryEditor.hidden = true; editingCollectorId = null; editorToken.value = ""; };
      const openRegistryEditor = item => { editingCollectorId = item?.id || null; editorName.value = item?.name || ""; editorType.value = ["extension", "x_api", "6551"].includes(item?.type) ? item.type : "extension"; editorToken.value = ""; editorToken.placeholder = item?.type === "x_api" ? "X 官方接口访问令牌（留空表示沿用）" : "访问令牌（留空表示沿用已保存令牌）"; editorRateMode.value = item?.ratePolicy?.mode || "limited"; editorRpm.value = item?.ratePolicy?.requestsPerMinute || 20; editorDaily.value = item?.ratePolicy?.dailyJobs || 500; editorConcurrency.value = item?.ratePolicy?.concurrency || 1; registryEditor.hidden = false; };
      const renderRegistry = () => {
        registryList.replaceChildren();
        for (const item of collectors) {
          const row = node("article", "collector-registry-row");
          const info = node("div", "collector-registry-info");
          const title = node("strong", "", item.name); const runtime = item.runtime || {}; const typeLabel = item.type === "x_api" ? "官方接口" : item.type === "6551" ? "云端接口" : item.type === "extension" ? "浏览器扩展" : item.type; const meta = node("small", "", `${item.systemOwned ? "系统内置" : "自定义"} · ${typeLabel} · ${item.enabled ? "已启用" : "已停用"} · 当前${runtime.label || "未知"}`); const detail = node("small", "", `令牌：${item.tokenMasked || "未配置"} · ${item.ratePolicy?.mode === "unlimited" ? "不限速" : `每分钟 ${item.ratePolicy?.requestsPerMinute || "—"} 次 · 并发 ${item.ratePolicy?.concurrency || "—"}`}`); info.append(title, meta, detail);
          const actions = node("div", "collector-registry-actions");
          const test = node("button", "mini-button", "测试连接");
          test.addEventListener("click", async event => {
            event.stopPropagation();
            test.disabled = true;
            const progress = node("span", "collector-test-progress");
            const progressLabel = node("span", "collector-test-progress-label", "测试中 · 0/3");
            const progressTrack = node("span", "collector-test-progress-track");
            const progressFill = node("i", "collector-test-progress-fill");
            progressTrack.append(progressFill); progress.append(progressLabel, progressTrack); actions.append(progress);
            progressLabel.textContent = "测试中 · 1/3"; progressFill.style.width = "33%";
            try {
              await new Promise(resolve => setTimeout(resolve, 120));
              progressLabel.textContent = "正在验证鉴权…"; progressFill.style.width = "66%";
              let result;
              try {
                result = await api(`/collectors/${encodeURIComponent(item.id)}/test`, { method: "POST", body: "{}" });
              } catch (error) {
                // 设置页可能长时间打开，旧会话令牌会失效；测试连接前自动刷新一次会话令牌。
                if (error.status !== 403) throw error;
                const auth = await api("/auth/status");
                if (!auth.csrf) throw error;
                state.csrf = auth.csrf; sessionStorage.setItem("aip-csrf", auth.csrf);
                result = await api(`/collectors/${encodeURIComponent(item.id)}/test`, { method: "POST", body: "{}" });
              }
              progressLabel.textContent = result.callback?.received ? "测试完成 · 3/3" : "接口可用 · 等待回调"; progressFill.style.width = result.callback?.received ? "100%" : "66%";
              toast(result.message || "采集器测试完成");
            } catch (error) {
              progressLabel.textContent = `测试失败 · ${error.message}`; progressFill.style.width = "100%";
              toast(`采集器测试失败：${error.message}`);
            } finally {
              test.disabled = false;
              setTimeout(() => progress.remove(), 6000);
            }
          });
          actions.append(test);
          const edit = node("button", "mini-button", "编辑"); edit.addEventListener("click", event => { event.stopPropagation(); openRegistryEditor(item); }); actions.append(edit);
          const toggle = node("button", "mini-button", item.enabled ? "停用" : "启用"); toggle.addEventListener("click", async event => { event.stopPropagation(); toggle.disabled = true; try { await api(`/collectors/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify({ enabled: !item.enabled }) }); toast(`${item.name} 已${item.enabled ? "停用" : "启用"}`); invalidateSettingsCache("collector"); await renderSettings(); } catch (error) { toast(`状态更新失败：${error.message}`); toggle.disabled = false; } }); actions.append(toggle);
          const remove = node("button", "mini-button danger-button", "删除"); remove.addEventListener("click", async event => { event.stopPropagation(); if (!confirm(`确认删除${item.name}？`)) return; try { await api(`/collectors/${encodeURIComponent(item.id)}`, { method: "DELETE" }); toast("采集器已删除"); invalidateSettingsCache("collector"); await renderSettings(); } catch (error) { toast(`删除失败：${error.message}`); } }); actions.append(remove);
          row.append(info, actions); registryList.append(row);
        }
      };
      const registryActions = node("div", "collector-registry-form-actions"); const registrySave = node("button", "mini-button", "保存"); const registryCancel = node("button", "mini-button", "取消"); registryActions.append(registrySave, registryCancel);
      registrySave.addEventListener("click", async () => { if (!editorName.value.trim()) return toast("请填写采集器名称"); registrySave.disabled = true; try { const payload = { name: editorName.value.trim(), type: editorType.value, token: editorToken.value.trim(), ratePolicy: { mode: editorRateMode.value, requestsPerMinute: Number(editorRpm.value || 20), dailyJobs: Number(editorDaily.value || 500), concurrency: Number(editorConcurrency.value || 1) } }; await api(editingCollectorId ? `/collectors/${encodeURIComponent(editingCollectorId)}` : "/collectors", { method: editingCollectorId ? "PUT" : "POST", body: JSON.stringify(payload) }); toast("采集器已保存"); invalidateSettingsCache("collector"); await renderSettings(); } catch (error) { toast(`保存失败：${error.message}`); } finally { registrySave.disabled = false; } });
      registryCancel.addEventListener("click", closeRegistryEditor);
      registryEditor.append(node("label", "", "名称"), editorName, node("label", "", "类型"), editorType, node("label", "", "访问令牌"), editorToken, node("label", "", "速率模式"), editorRateMode, editorRpm, editorDaily, editorConcurrency, registryActions);
      registryCard.append(registryList, registryEditor); renderRegistry(); target.append(registryCard);
      const assemblyCard = settingsCard("采集配置", "将已有采集器组装成可执行配置。");
      const profileList = node("div", "collector-registry-list");
      const profileRow = node("article", "collector-registry-row");
      const profileRowInfo = node("div", "collector-registry-info"); const profileSchedule = state.dashboard?.health?.adaptiveSchedule || {}; const apiPrimary = collection.xPrimaryProvider === "6551" || collection.xProvider === "6551"; const scheduleText = apiPrimary ? "按帖子热度动态：T3 5 分钟 · T2 10 分钟 · T1 15 分钟 · 普通 30 分钟" : profileSchedule.intervalMinutes ? `当前每 ${profileSchedule.intervalMinutes} 分钟 · ${profileSchedule.reason || "自适应调度"}` : "自适应调度 · 高峰 15 分钟"; profileRowInfo.append(node("strong", "", profile.name || "默认采集配置"), node("small", "", `${profile.primaryCollectorId ? "已配置主采集器" : "未配置主采集器"} · ${profile.secondaryCollectorId ? "已配置副采集器" : "无副补偿采集器"}`), node("small", "", `频率：${scheduleText} · 时间：北京时间 08:00–22:00`));
      const profileEdit = node("button", "mini-button", "配置"); profileRow.append(profileRowInfo, profileEdit); profileList.append(profileRow); assemblyCard.append(profileList);
      const assemblyEditor = node("div", "collector-registry-editor"); assemblyEditor.hidden = true;
      const addProfile = node("button", "mini-button", "+ 采集配置"); assemblyCard.insertBefore(addProfile, profileList);
      const profileName = node("input", "settings-input"); profileName.value = profile.name || "默认采集配置"; profileName.placeholder = "配置名称";
      const primarySelect = node("select", "settings-select"); const secondarySelectNew = node("select", "settings-select");
      profileName.title = "这套采集配置的显示名称";
      primarySelect.title = "负责主要采集任务的采集器";
      secondarySelectNew.title = "主采集器离线或队列持续拥堵时接管的补偿采集器";
      primarySelect.append(...collectors.map(item => { const option = node("option", "", `${item.name}${item.enabled ? "" : "（已停用）"}`); option.value = item.id; option.disabled = item.enabled === false; return option; }));
      secondarySelectNew.append(node("option", "", "不启用副补偿采集器")); secondarySelectNew.options[0].value = ""; secondarySelectNew.append(...collectors.map(item => { const option = node("option", "", `${item.name}${item.enabled ? "" : "（已停用）"}`); option.value = item.id; option.disabled = item.enabled === false; return option; }));
      primarySelect.value = profile.primaryCollectorId || collectors.find(item => item.enabled)?.id || ""; secondarySelectNew.value = profile.secondaryCollectorId || "";
      const backlogThreshold = node("input", "settings-input"); backlogThreshold.type = "number"; backlogThreshold.min = "1"; backlogThreshold.value = profile.fallbackPolicy?.backlogThreshold || 100; backlogThreshold.placeholder = "队列达到多少条";
      const backlogMinutes = node("input", "settings-input"); backlogMinutes.type = "number"; backlogMinutes.min = "1"; backlogMinutes.value = profile.fallbackPolicy?.backlogDurationMinutes || 10; backlogMinutes.placeholder = "持续多少分钟";
      backlogThreshold.title = "队列达到此数量后，开始判断是否需要副采集器接管";
      backlogMinutes.title = "队列超过上述数量并持续这么久后，允许副采集器接管";
      const xEnabled = node("input"); xEnabled.type = "checkbox"; xEnabled.className = "collector-platform-checkbox"; xEnabled.checked = collection.platforms?.x !== false; xEnabled.title = "是否采集 X 平台"; const douyinEnabled = node("input"); douyinEnabled.type = "checkbox"; douyinEnabled.className = "collector-platform-checkbox"; douyinEnabled.checked = collection.platforms?.douyin === true; douyinEnabled.title = "是否采集抖音平台";
      const platformChoices = node("div", "collector-platform-choices"); const platformChoice = (input, label, detail) => { const wrap = node("label", `collector-platform-choice${input.checked ? " is-selected" : ""}`); const copy = node("span", "collector-platform-choice-copy"); copy.append(node("strong", "", label), node("small", "", detail)); input.addEventListener("change", () => wrap.classList.toggle("is-selected", input.checked)); wrap.append(input, copy); return wrap; }; platformChoices.append(platformChoice(xEnabled, "X", "关注、搜索与热点内容"), platformChoice(douyinEnabled, "抖音", "仅在启用抖音采集器时使用"));
      const frequencyMode = node("select", "settings-select"); for (const [value, label] of [["adaptive", "自适应：活跃时段加密采集"], ["fixed", "固定频率"]]) { const option = node("option", "", label); option.value = value; frequencyMode.append(option); } frequencyMode.value = profile.frequencyPolicy?.mode || "adaptive";
      const activeInterval = node("input", "settings-input"); activeInterval.type = "number"; activeInterval.min = "5"; activeInterval.value = profile.frequencyPolicy?.activeIntervalMinutes || 15; activeInterval.placeholder = "活跃时段分钟数";
      const quietInterval = node("input", "settings-input"); quietInterval.type = "number"; quietInterval.min = "15"; quietInterval.value = profile.frequencyPolicy?.quietIntervalMinutes || 60; quietInterval.placeholder = "低活跃时段分钟数";
      frequencyMode.title = "选择按热度自适应，或使用固定采集间隔";
      activeInterval.title = "低于该间隔时，活跃帖子会更频繁地复采；6551 主采集器仍按帖子等级动态调整";
      quietInterval.title = "普通帖子和低活跃时段的默认采集间隔，默认 60 分钟";
      const timeSummary = node("p", "collector-schedule-note", "采集时间：北京时间 08:00–22:00；工作日 08:00–11:00、14:00–18:00、20:00–22:00 自动加密，其他时段自动放宽。");
      const profileActions = node("div", "collector-registry-form-actions"); const profileSave = node("button", "mini-button", "保存"); const profileCancel = node("button", "mini-button", "取消"); profileActions.append(profileSave, profileCancel);
      profileSave.addEventListener("click", async () => { if (!xEnabled.checked && !douyinEnabled.checked) return toast("至少选择一个平台"); profileSave.disabled = true; try { await api(`/collection-profiles/${encodeURIComponent(profile.id || "profile-default")}`, { method: "PUT", body: JSON.stringify({ name: profileName.value.trim() || "默认采集配置", primaryCollectorId: primarySelect.value, secondaryCollectorId: secondarySelectNew.value || null, platforms: { x: xEnabled.checked, douyin: douyinEnabled.checked }, frequencyPolicy: { mode: frequencyMode.value, activeIntervalMinutes: Number(activeInterval.value || 15), quietIntervalMinutes: Number(quietInterval.value || 60) }, collectionTime: { timezone: "Asia/Shanghai", windows: [{ label: "活跃时段", start: "08:00", end: "22:00" }] }, fallbackPolicy: { backlogThreshold: Number(backlogThreshold.value || 100), backlogDurationMinutes: Number(backlogMinutes.value || 10), offlineImmediate: true } }) }); toast("采集配置已保存"); invalidateSettingsCache("collector"); await renderSettings(); } catch (error) { toast(`采集配置保存失败：${error.message}`); } finally { profileSave.disabled = false; } });
      profileCancel.addEventListener("click", () => { profileName.value = profile.name || "默认采集配置"; primarySelect.value = profile.primaryCollectorId || ""; secondarySelectNew.value = profile.secondaryCollectorId || ""; assemblyEditor.hidden = true; });
      profileEdit.addEventListener("click", () => { assemblyEditor.hidden = !assemblyEditor.hidden; });
      addProfile.addEventListener("click", () => { profileName.value = ""; primarySelect.value = collectors.find(item => item.enabled)?.id || ""; secondarySelectNew.value = ""; backlogThreshold.value = "100"; backlogMinutes.value = "10"; assemblyEditor.hidden = false; });
      assemblyEditor.append(node("label", "", "配置名称"), profileName, node("label", "", "主采集器"), primarySelect, node("label", "", "副补偿采集器"), secondarySelectNew, node("label", "", "副采集器接管条件"), backlogThreshold, backlogMinutes, node("label", "", "采集频率"), frequencyMode, activeInterval, quietInterval, node("label", "", "采集时间"), timeSummary, node("label", "", "平台范围"), platformChoices, profileActions); assemblyCard.append(assemblyEditor); target.append(assemblyCard);
      const runtimeCard = settingsCard("采集运行状态", "只显示当前采集配置的真实运行状态；排队不等于报错。");
      const runtimeHealth = state.dashboard?.health || {};
      const runtimeToggle = node("button", "mini-button collector-runtime-toggle", "查看状态");
      const runtimeDetails = node("div", "collector-runtime-details"); runtimeDetails.hidden = true;
      runtimeToggle.addEventListener("click", () => { runtimeDetails.hidden = !runtimeDetails.hidden; runtimeToggle.textContent = runtimeDetails.hidden ? "查看状态" : "收起状态"; });
      runtimeDetails.append(node("p", "", `X：${runtimeHealth.platforms?.x?.healthy ? "在线" : "等待采集节点"} · 排队 ${runtimeHealth.platforms?.x?.queued || 0} · 运行 ${runtimeHealth.platforms?.x?.running || 0}`));
      runtimeDetails.append(node("p", "", `最近成功：${runtimeHealth.platforms?.x?.lastSuccessAt ? formatTime(runtimeHealth.platforms.x.lastSuccessAt) : "暂无"}`));
      const extensionEditor = node("div", "collector-extension-editor");
      const extensionUrl = node("input", "settings-input"); extensionUrl.placeholder = "扩展服务地址"; extensionUrl.value = location.origin;
      const extensionNode = node("input", "settings-input"); extensionNode.placeholder = "节点标识";
      const extensionToken = node("input", "settings-input"); extensionToken.type = "password"; extensionToken.placeholder = "采集令牌";
      const issueExtension = node("button", "mini-button collector-extension-action", "签发扩展节点"); const saveExtension = node("button", "mini-button collector-extension-action collector-extension-action-primary", "写入扩展");
      issueExtension.addEventListener("click", async () => { try { const result = await api("/collector-nodes", { method: "POST", body: JSON.stringify({ name: "浏览器扩展", days: 30 }) }); extensionNode.value = result.item.id; extensionToken.value = result.item.token; toast("已签发节点令牌，请写入扩展"); } catch (error) { toast(`签发失败：${error.message}`); } });
      saveExtension.addEventListener("click", async () => { if (!extensionUrl.value || !extensionNode.value || !extensionToken.value) return toast("请填写扩展地址、节点标识和令牌"); saveExtension.disabled = true; try { await extensionRequest("AIP_EXTENSION_CONFIG", { config: { serverUrl: extensionUrl.value, collectorToken: extensionToken.value, nodeId: extensionNode.value } }); extensionToken.value = ""; toast("扩展已连接，采集任务将按配置领取"); } catch (error) { toast(`扩展连接失败：${error.message}`); } finally { saveExtension.disabled = false; } });
      extensionEditor.append(extensionUrl, extensionNode, extensionToken, issueExtension, saveExtension); runtimeDetails.append(extensionEditor); runtimeCard.append(runtimeToggle, runtimeDetails); target.append(runtimeCard);
      return;
      const primaryValue = collection.xPrimaryProvider || collection.xProvider || "extension";
      const secondaryValue = collection.xSecondaryProvider || "none";
      const card = settingsCard(primaryValue === "6551" ? "6551 云端采集器" : primaryValue === "api_page" ? "API页面采集器" : "浏览器扩展采集器", primaryValue === "6551" ? "X 任务由服务器直接请求 6551，浏览器扩展不领取 X 任务。" : (health.collectorHealthy ? "节点在线，正在按优先级领取 X 与抖音任务。" : "节点未连接；离线期间的数据缺口不会被解释为没有热点。"));
      card.append(node("p", "", `积压任务：${health.backlog || 0}`));
      card.append(node("p", "", `最近成功：${health.lastSuccessAt ? formatTime(health.lastSuccessAt) : "无"}`));
      if (health.adaptiveSchedule) card.append(node("p", "", `下一计划：每 ${health.adaptiveSchedule.intervalMinutes} 分钟 · ${health.adaptiveSchedule.reason} · 北京时间`));
      if (health.lastError) card.append(node("p", "", `最近错误：${health.lastError}`));
      target.append(card);
      const providerCard = settingsCard("采集器", "主采集器负责全部任务；副补偿采集器只处理关注博主。主采集器离线立即接管，在线时需队列达到 100 条并持续 10 分钟。");
      const providerRecord = node("div", "collector-provider-record");
      const providerRecordInfo = node("div", "collector-provider-record-info");
      const providerRecordName = node("b", "", primaryValue === "6551" ? "6551采集器" : "API页面采集器");
      const providerRecordStatus = node("small", collection.providerAvailable ? "collector-provider-ready" : "warning", "");
      const providerEdit = node("button", "mini-button", "配置");
      providerRecordInfo.append(providerRecordName, providerRecordStatus);
      providerRecord.append(providerRecordInfo, providerEdit);
      const providerEditor = node("div", "collector-provider-editor");
      providerEditor.hidden = true;
      const providerSelect = node("select", "settings-select");
      const extensionOption = node("option", "", "浏览器扩展采集器"); extensionOption.value = "extension";
      const apiPageOption = node("option", "", "API页面采集器"); apiPageOption.value = "api_page";
      const hostedOption = node("option", "", "6551 云端采集器"); hostedOption.value = "6551";
      providerSelect.append(extensionOption, apiPageOption, hostedOption);
      providerSelect.value = ["6551", "api_page", "extension"].includes(primaryValue) ? primaryValue : "extension";
      const secondarySelect = node("select", "settings-select");
      const noneOption = node("option", "", "不启用副补偿采集器"); noneOption.value = "none";
      const apiSecondaryOption = node("option", "", "API页面采集器（仅关注博主补偿）"); apiSecondaryOption.value = "api_page";
      const hostedSecondaryOption = node("option", "", "6551 云端采集器（仅关注博主补偿）"); hostedSecondaryOption.value = "6551";
      secondarySelect.append(noneOption, apiSecondaryOption, hostedSecondaryOption);
      secondarySelect.value = ["none", "api_page", "6551"].includes(secondaryValue) ? secondaryValue : "none";
      const providerToken = node("input", "settings-input");
      providerToken.type = "password";
      providerToken.autocomplete = "new-password";
      providerToken.placeholder = "粘贴 6551 访问令牌（不会回显）";
      const tokenSave = node("button", "mini-button", "保存令牌");
      const providerStatus = node("small", collection.providerAvailable ? "" : "warning", collection.providerAvailable ? "6551 令牌已配置（加密保存）" : "尚未配置 6551 令牌");
      const updateProviderRecord = () => {
        const activeName = providerSelect.value === "6551" ? "6551云端" : providerSelect.value === "api_page" ? "API页面采集器" : "浏览器扩展";
        const secondaryName = secondarySelect.value === "none" ? "无" : secondarySelect.value === "6551" ? "6551云端" : "API页面采集器";
        providerRecordStatus.className = collection.providerAvailable ? "collector-provider-ready" : "warning";
        providerRecordStatus.textContent = `${collection.providerAvailable || providerSelect.value !== "6551" ? "已配置" : "未配置"} · 主：${activeName} · 副：${secondaryName}`;
      };
      updateProviderRecord();
      providerEdit.addEventListener("click", () => {
        providerEditor.hidden = !providerEditor.hidden;
        providerEdit.textContent = providerEditor.hidden ? "配置" : "收起";
      });
      tokenSave.addEventListener("click", async () => {
        if (!providerToken.value.trim()) return toast("请先输入 6551 访问令牌");
        tokenSave.disabled = true;
        try {
          await api("/collection-settings/6551-token", { method: "POST", body: JSON.stringify({ token: providerToken.value.trim() }) });
          providerToken.value = "";
          collection.providerAvailable = true;
          invalidateSettingsCache("collector");
          providerStatus.className = "";
          providerStatus.textContent = "6551 令牌已配置（加密保存）";
          updateProviderRecord();
          providerEditor.hidden = true;
          providerEdit.textContent = "配置";
          toast("6551 令牌已写入当前服务");
        } catch (error) { toast(`令牌保存失败：${error.message}`); }
        finally { tokenSave.disabled = false; }
      });
      const providerSave = node("button", "mini-button", "保存采集方式");
      providerSave.addEventListener("click", async () => {
        providerSave.disabled = true;
        try {
          await api("/collection-settings", { method: "PUT", body: JSON.stringify({ platforms: collection.platforms, xPrimaryProvider: providerSelect.value, xSecondaryProvider: secondarySelect.value }) });
          invalidateSettingsCache("collector");
          updateProviderRecord();
          providerEditor.hidden = true;
          providerEdit.textContent = "配置";
          toast(`X 已设置主采集器：${providerSelect.value === "6551" ? "6551 云端采集器" : providerSelect.value === "api_page" ? "API页面采集器" : "浏览器扩展采集器"}`);
          await load();
        } catch (error) { toast(`采集方式保存失败：${error.message}`); }
        finally { providerSave.disabled = false; }
      });
      providerSelect.addEventListener("change", updateProviderRecord);
      secondarySelect.addEventListener("change", updateProviderRecord);
      const providerActions = node("div", "collector-provider-actions");
      providerActions.append(tokenSave, providerSave);
      const primaryLabel = node("small", "", "主采集器");
      const secondaryLabel = node("small", "", "副补偿采集器");
      providerEditor.append(primaryLabel, providerSelect, secondaryLabel, secondarySelect, providerToken, providerActions, providerStatus);
      providerCard.append(providerRecord, providerEditor);
      target.append(providerCard);
      const platforms = settingsCard("采集平台", "分别控制 X 与抖音。关闭后停止生成和领取该平台的新任务，历史内容不会删除。");
      for (const [platform, label] of [["x", "X"], ["douyin", "抖音"]]) {
        const runtime = health.platforms?.[platform] || {};
        const row = node("section", "platform-toggle");
        const control = node("label", "platform-toggle-control");
        const input = node("input");
        input.type = "checkbox";
        input.checked = collection.platforms?.[platform] !== false;
        input.addEventListener("change", async () => {
          const controls = [...platforms.querySelectorAll('input[type="checkbox"]')];
          controls.forEach(control => { control.disabled = true; });
          try {
            const values = Object.fromEntries(controls.map(control => [control.dataset.platform, control.checked]));
            await api("/collection-settings", { method: "PUT", body: JSON.stringify({ platforms: values }) });
            toast(`${label} 采集已${input.checked ? "开启" : "关闭"}`);
            await load();
          } catch (error) {
            input.checked = !input.checked;
            toast(`平台设置失败：${error.message}`);
          } finally {
            controls.forEach(control => { control.disabled = false; });
          }
        });
        input.dataset.platform = platform;
        control.append(input, node("b", "", `${label} 采集`));
        const status = node("div", "platform-health");
        const statusText = runtime.pausedReason === "platform_risk" ? "需要人工处理" :
          runtime.pausedReason === "platform_disabled" ? "已关闭" :
          runtime.status === "collecting" ? `采集中 · ${runtime.phase || "处理中"}` :
          runtime.healthy ? "在线" : "等待采集节点";
        status.append(
          node("span", runtime.pausedReason ? "warning" : "", statusText),
          node("small", "", `排队 ${runtime.queued || 0} · 运行 ${runtime.running || 0} · 暂停 ${runtime.paused || 0} · 失败 ${runtime.failed || 0}`)
        );
        if (runtime.lastSuccessAt) status.append(node("small", "", `最近成功 ${formatTime(runtime.lastSuccessAt)}`));
        if (runtime.lastError) status.append(node("small", "warning", runtime.lastError));
        row.append(control, status);
        if (runtime.pausedReason === "platform_risk") {
          const resume = node("button", "mini-button", "已处理，恢复采集");
          resume.addEventListener("click", async () => {
            try {
              await api(`/collection-settings/${platform}/resume`, { method: "POST", body: "{}" });
              toast(`${label} 采集已恢复`);
              await load();
              renderSettings();
            } catch (error) { toast(`恢复失败：${error.message}`); }
          });
          row.append(resume);
        }
        platforms.append(row);
      }
      target.append(platforms);
      const config = settingsCard("扩展服务地址", "配置只写入本地浏览器扩展；采集令牌不会保存到页面服务器。云端地址必须使用 HTTPS。");
      const serverUrl = node("input"); serverUrl.placeholder = "https://monitor.example.com"; serverUrl.value = location.origin;
      const nodeId = node("input"); nodeId.placeholder = "节点标识";
      const token = node("input"); token.placeholder = "采集令牌"; token.type = "password";
      const save = node("button", "mini-button", "写入本地扩展");
      save.addEventListener("click", async () => {
        if (!serverUrl.value || !token.value || !nodeId.value) return toast("请填写服务地址、节点标识和采集令牌");
        save.disabled = true;
        try {
          await extensionRequest("AIP_EXTENSION_CONFIG", {
            config: { serverUrl: serverUrl.value, collectorToken: token.value, nodeId: nodeId.value }
          });
          token.value = "";
          toast("扩展认证成功，采集队列已经启动");
          await load();
        } catch (error) {
          toast(`扩展配置失败：${error.message}`);
        } finally {
          save.disabled = false;
        }
      });
      const issue = node("button", "mini-button", "签发当前扩展节点");
      issue.addEventListener("click", async () => {
        const result = await api("/collector-nodes", { method: "POST", body: JSON.stringify({ name: "浏览器扩展", days: 30 }) });
        nodeId.value = result.item.id;
        token.value = result.item.token;
        toast("已签发一次性显示的节点令牌，请立即写入扩展");
      });
      config.append(serverUrl, nodeId, token, issue, save);
      target.append(config);
    }
    if (state.settingsTab === "notifications") {
      if (stale()) return;
      target.replaceChildren();
      const card = settingsCard("浏览器阶段通知", "同一事件的同一阶段只通知一次；阶段升级会生成新的通知。");
      const status = node("p", "", !("Notification" in window) ? "当前浏览器不支持系统通知" : `当前权限：${Notification.permission}`);
      const enable = node("button", "mini-button", "启用浏览器通知");
      enable.disabled = !("Notification" in window);
      enable.addEventListener("click", async () => {
        const permission = await Notification.requestPermission();
        status.textContent = `当前权限：${permission}`;
        if (permission === "granted") await deliverNotifications();
      });
      card.append(status, enable);
      target.append(card);
    }
  } catch (error) {
    if (stale()) return;
    target.replaceChildren(node("p", "", error.message));
  }
}

function switchTab(tab) {
  state.tab = tab;
  $(".hero").hidden = tab === "posts" || tab === "following";
  document.body.classList.toggle("events-view", tab === "events");
  document.body.classList.toggle("queue-view", tab === "queue");
  document.body.classList.toggle("following-view", tab === "following");
  $$(".primary-tabs button").forEach(button => {
    button.classList.toggle("active", button.dataset.tab === tab);
    button.setAttribute("aria-selected", button.dataset.tab === tab ? "true" : "false");
  });
  $$("[data-panel]").forEach(panel => {
    const active = panel.dataset.panel === tab;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  const text = {
    events: ["AI EVENT RADAR", "AI 热点事件", "多位独立作者围绕同一具体变化集中发帖，才会进入这里。"],
    posts: ["HOT POSTS", "AI 热帖", "按作者自身基线与赞粉比筛选；候选内容不会混入正式热帖。"],
    following: ["关注追踪", "关注", "按时间浏览已关注账号的新作品，异常升温会突出显示。"],
    queue: ["任务队列", "", ""]
  }[tab];
  $("#pageKicker").textContent = text[0];
  $("#pageTitle").textContent = text[1];
  $("#pageDescription").textContent = text[2];
  $("#contentToolbar").hidden = tab === "events" || tab === "queue";
  $("#moreFilters").hidden = tab !== "posts";
  $("#searchInput").placeholder = tab === "following" ? "搜索关注作者或正文" : "搜索作者或正文";
  render();
}

async function loadHotspotGraph() {
  state.hotspotGraph = await api("/hotspot-graph");
  state.hotspotGraphError = "";
  if (state.tab === "events") renderEvents();
}

async function performLoad() {
  try {
    state.dashboard = await api("/dashboard");
    render();
    loadQueue().catch(() => {});
    $("#lastRefreshTime").textContent = `刷新 ${formatRefreshTime()}`;
    try {
      await loadHotspotGraph();
    } catch (error) {
      state.hotspotGraph = null;
      state.hotspotGraphError = error.message;
    }
    render();
    deliverNotifications().catch(() => {});
  } catch (error) {
    if (error.status === 401) {
      const dialog = $("#loginDialog");
      if (!dialog.open) dialog.showModal();
    }
    $("#liveLabel").textContent = "服务读取失败";
    $("#coverageValue").textContent = "不可用";
    $("#coverageDetail").textContent = error.message;
    const hasExistingData = Boolean(state.dashboard) && [
      ...(state.dashboard.hotPosts || []),
      ...(state.dashboard.candidates || []),
      ...(state.dashboard.followedPosts || []),
      ...(state.dashboard.events || [])
    ].length > 0;
    showEmpty(!hasExistingData);
  }
}

function load() {
  if (pageLoadPromise) return pageLoadPromise;
  pageLoadPromise = performLoad().finally(() => { pageLoadPromise = null; });
  return pageLoadPromise;
}

function scheduleDashboardReload() {
  clearTimeout(dashboardReloadTimer);
  dashboardReloadTimer = setTimeout(async () => {
    await load();
    // 看板心跳只更新主看板；采集设置没有失效时不重建整张设置页，避免闪烁和重复数据库读取。
    if ($("#settingsDrawer").getAttribute("aria-hidden") === "false" && state.settingsTab === "collector" && !settingsCacheFresh("collector")) renderSettings();
  }, 180);
}

function connectCollectorEvents() {
  if (!("EventSource" in window)) return;
  const source = new EventSource("/api/events");
  for (const type of ["collector.status", "job.progress", "job.leased", "job.failed", "data.updated", "platform.settings", "platform.resumed"]) {
    source.addEventListener(type, scheduleDashboardReload);
  }
  source.addEventListener("queue.updated", event => {
    loadQueue().catch(() => {});
    // 分析任务失败、排队或完成后都刷新看板，关闭抽屉后重新打开仍能看到真实状态。
    scheduleDashboardReload();
    try {
      const detail = JSON.parse(event.data || "{}");
      if (detail.status === "complete") scheduleDashboardReload();
    } catch {}
  });
}

function startLiveUpdates() {
  if (liveUpdatesStarted) return;
  liveUpdatesStarted = true;
  connectCollectorEvents();
  setInterval(load, 30_000);
  setInterval(loadQueue, 5_000);
}

async function deliverNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const { items } = await api("/notifications");
  for (const item of items) {
    new Notification(item.title, { body: item.body, tag: item.id, renotify: false });
    await api(`/notifications/${encodeURIComponent(item.id)}/delivered`, { method: "POST", body: "{}" });
  }
}

async function authenticate() {
  const status = await api("/auth/status");
  if (status.authenticated) {
    state.csrf = status.csrf || sessionStorage.getItem("aip-csrf") || "";
    if (state.csrf) sessionStorage.setItem("aip-csrf", state.csrf);
    return true;
  }
  $("#loginDialog").showModal();
  return false;
}

$$(".primary-tabs button").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
$("#queueButton").addEventListener("click", () => switchTab("queue"));
$("#resetGraphView").addEventListener("click", event => {
  $("#hotspotGraph svg")?.resetView?.();
  event.currentTarget.hidden = true;
});
$("#graphSearchInput").addEventListener("input", renderGraphSearchResults);
$("#graphSearchInput").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  const first = renderGraphSearchResults()[0];
  if (!first) return;
  event.preventDefault();
  $("#hotspotGraph svg")?.focusNode?.(first.key);
  $("#graphSearchResults").hidden = true;
  dismissGraphHint();
});
$("#graphSearchResults").addEventListener("click", event => {
  const button = event.target.closest("button[data-node-key]");
  if (!button) return;
  $("#hotspotGraph svg")?.focusNode?.(button.dataset.nodeKey);
  $("#graphSearchResults").hidden = true;
  dismissGraphHint();
});
function syncGradeControls() {
  const select = $("#gradeFilter");
  if (select) select.value = state.gradeSelection.length === 3 ? "all" : state.gradeSelection[0] || "all";
}

$("#platformFilter").addEventListener("change", event => {
  state.platform = event.target.value;
  render();
});

$("#gradeFilter").addEventListener("change", event => {
  const grade = event.target.value;
  state.gradeSelection = grade === "all" ? ["T3", "T2", "T1"] : [grade];
  syncGradeControls();
  render();
});

$$('[data-grade-segment]').forEach(segment => segment.addEventListener("click", () => {
  const grade = segment.dataset.gradeSegment;
  state.gradeSelection = state.gradeSelection.length === 1 && state.gradeSelection[0] === grade ? ["T3", "T2", "T1"] : [grade];
  syncGradeControls();
  render();
}));

$("#hotStats").addEventListener("click", event => {
  if (event.target.closest("button")) return;
  state.gradeSelection = ["T3", "T2", "T1"];
  syncGradeControls();
  render();
});

for (const [id, key] of [["evidenceFilter", "evidence"], ["analysisFilter", "analysisFilter"], ["momentumFilter", "momentumFilter"], ["timeFilter", "timeFilter"]]) {
  $(`#${id}`).addEventListener("change", event => { state[key] = event.target.value; render(); });
}
$$("#queueTypeFilter button, #queueTaskFilter button, #queuePlatformFilter button, #queueStatusFilter button").forEach(button => button.addEventListener("click", () => {
  const group = button.parentElement;
  group.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
  if (group.id === "queueTypeFilter") state.queueType = button.dataset.value;
  else if (group.id === "queueTaskFilter") state.queueTask = button.dataset.value;
  else if (group.id === "queuePlatformFilter") state.queuePlatform = button.dataset.value;
  else state.queueStatus = button.dataset.value;
  loadQueue();
}));
$("#queueSearchInput")?.addEventListener("input", event => { state.queueQuery = event.target.value; renderQueue(); });
$("#searchInput").addEventListener("input", event => { state.query = event.target.value; render(); });
window.addEventListener("resize", () => {
  if (state.tab !== "events" || !state.hotspotGraph) return;
  clearTimeout(graphResizeTimer);
  graphResizeTimer = setTimeout(renderEvents, 120);
});
$("#collectButton").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.dataset.tooltip = "正在采集";
  try {
    const dispatch = await api("/collect", { method: "POST", body: "{}" });
    if (dispatch.collectorDispatch === "6551") {
      toast("已提交 6551 云端采集器，任务将自动执行");
    } else {
      const response = await extensionRequest("AIP_RUN_QUEUE");
      toast(response.state === "already_running" ? "采集节点正在执行现有队列" : "采集节点已连接并开始领取任务");
    }
    await load();
  } catch (error) {
    toast(`采集未启动：${error.message}`);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.dataset.tooltip = "立即采集";
  }
});
$("#graphCoverage").addEventListener("click", event => {
  event.stopPropagation();
  const island = $("#graphCoverageIsland");
  const message = $("#graphCoverageMessage");
  graphCoverageManualExpanded = !island.classList.contains("is-expanded");
  const expanded = island.classList.toggle("is-expanded", graphCoverageManualExpanded);
  message.hidden = !expanded;
});
$("#graphSummaryTrigger").addEventListener("click", event => {
  event.stopPropagation();
  const island = $("#graphSummaryIsland");
  const details = $("#graphSummaryDetails");
  const expanded = island.classList.toggle("is-expanded");
  details.hidden = !expanded;
  $("#graphSummaryTrigger").setAttribute("aria-expanded", String(expanded));
});
$$("[data-coverage-action]").forEach(button => button.addEventListener("click", event => {
  event.stopPropagation();
  const action = button.dataset.coverageAction;
  if (action === "collect") $("#collectButton").click();
}));
$("#settingsButton").addEventListener("click", () => { toggleDrawer($("#settingsDrawer"), true); renderSettings(); });
$("#coverageCard").addEventListener("click", () => {
  state.settingsTab = "collector";
  $$('[data-settings-tab]').forEach(button => button.classList.toggle("active", button.dataset.settingsTab === "collector"));
  toggleDrawer($("#settingsDrawer"), true);
  renderSettings();
});
$$("[data-close-drawer]").forEach(button => button.addEventListener("click", () => {
  state.detailSelection = null;
  $("#hotspotGraph svg")?.clearFocus?.();
  toggleDrawer($("#detailDrawer"), false);
}));
$$("[data-close-settings]").forEach(button => button.addEventListener("click", () => toggleDrawer($("#settingsDrawer"), false)));
document.addEventListener("pointerdown", event => {
  const button = event.target.closest("button, [role=button]");
  if (button && !button.disabled) button.classList.add("is-pressed");
});
document.addEventListener("pointerup", event => event.target.closest("button, [role=button]")?.classList.remove("is-pressed"));
document.addEventListener("pointercancel", event => event.target.closest("button, [role=button]")?.classList.remove("is-pressed"));
document.addEventListener("click", event => {
  const button = event.target.closest("button, [role=button]");
  if (!button || button.disabled) return;
  button.classList.add("is-pressed");
  window.setTimeout(() => button.classList.remove("is-pressed"), 180);
});
$$("[data-settings-tab]").forEach(button => button.addEventListener("click", () => {
  state.settingsTab = button.dataset.settingsTab;
  $$("[data-settings-tab]").forEach(item => item.classList.toggle("active", item === button));
  renderSettings();
}));
$("#addCreatorButton").addEventListener("click", () => $("#creatorDialog").showModal());
$("#creatorForm").addEventListener("submit", async event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const isUrl = /^https?:\/\//.test(data.handle);
  try {
    await api("/follows", { method: "POST", body: JSON.stringify({ ...data, ...(isUrl ? { profileUrl: data.handle } : {}) }) });
    $("#creatorDialog").close();
    form.reset();
    toast("已添加关注并安排首次采集");
    await load();
  } catch (error) { toast(error.message); }
});
$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const password = new FormData(event.currentTarget).get("password");
  try {
    const result = await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    state.csrf = result.csrf || "";
    sessionStorage.setItem("aip-csrf", state.csrf);
    $("#loginError").textContent = "";
    $("#loginDialog").close();
    event.currentTarget.reset();
    await load();
    startLiveUpdates();
  } catch (error) {
    $("#loginError").textContent = error.message;
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    $("#hotspotGraph svg")?.clearFocus?.();
    $("#graphSearchResults").hidden = true;
    $("#graphSearchInput").blur();
    state.detailSelection = null;
    toggleDrawer($("#detailDrawer"), false);
    toggleDrawer($("#settingsDrawer"), false);
  }
});

if (sessionStorage.getItem("aip-graph-hint-seen")) $("#graphHint")?.classList.add("is-dismissed");

authenticate().then(authenticated => {
  if (!authenticated) return;
  load();
  startLiveUpdates();
}).catch(error => {
  $("#loginError").textContent = error.message;
  if (!$("#loginDialog").open) $("#loginDialog").showModal();
});
