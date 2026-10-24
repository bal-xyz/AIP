import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeViewport, scaleCameraForResize } from "../lib/responsive.mjs";

test("视口在四个响应式区间返回稳定布局模式和方向", () => {
  assert.equal(describeViewport(1440, 900).layoutMode, "wide");
  assert.equal(describeViewport(1024, 768).layoutMode, "tablet");
  assert.equal(describeViewport(768, 1024).layoutMode, "tablet");
  assert.equal(describeViewport(767, 1024).layoutMode, "mobile");
  assert.equal(describeViewport(390, 844).layoutMode, "compact");
  assert.equal(describeViewport(390, 844).orientation, "portrait");
  assert.equal(describeViewport(844, 390).orientation, "landscape");
  assert.equal(describeViewport(280, 700).viewportWidth, 320);
});

test("画布尺寸变化保持缩放值并按新旧比例换算平移中心", () => {
  const camera = scaleCameraForResize(
    { zoom: 1.8, x: 120, y: -80 },
    { width: 1200, height: 800 },
    { width: 600, height: 1000 }
  );
  assert.deepEqual(camera, { zoom: 1.8, x: 60, y: -100 });
});

test("新情报台加载单一响应式样式且不依赖横向表格", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  const graphScript = readFileSync(new URL("../assets/hotspot-graph.js", import.meta.url), "utf8");
  assert.match(html, /assets\/radar\.css/);
  assert.match(html, /data-tab="events"[\s\S]+data-tab="posts"[\s\S]+data-tab="following"/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.doesNotMatch(html, /<table/i);
  assert.doesNotMatch(css, /(?:^|[;{])\s*zoom\s*:/m);
  assert.match(css, /--graph-hotspot:\s*#5b91a9/);
  assert.match(css, /--graph-hotspot-fill:\s*rgba\(38, 79, 99, \.98\)/);
  assert.match(css, /--graph-active:/);
  assert.match(css, /--graph-hot:\s*rgba\(185, 120, 88, \.38\)/);
  assert.match(css, /--graph-hot-active:/);
  assert.match(css, /--graph-formal-fill:/);
  assert.match(css, /\.hotspot-cluster-hit, \.hotspot-post-hit[^\{]*\{[^}]*pointer-events:\s*all/);
  assert.match(css, /\.hotspot-event-node, \.hotspot-post-node[^\{]*\{[^}]*pointer-events:\s*all/);
  assert.match(css, /\.hotspot-event-label, \.hotspot-post-label[^\{]*\{[^}]*pointer-events:\s*all/);
  assert.match(graphScript, /class: "hotspot-post-hit", r: 25/);
  assert.match(graphScript, /class: "hotspot-cluster-hit", r: 30/);
  assert.match(graphScript, /Fallback delegation keeps node activation reliable/);
  assert.match(graphScript, /activateNode\(runtime\)/);
  assert.match(graphScript, /dragThreshold: event\.pointerType === "touch" \? 12 : 9/);
  assert.match(graphScript, /pointerActivatedUntil > performance\.now\(\)/);
  assert.match(graphScript, /addEventListener\("pointerup", release, true\)/);
  assert.match(graphScript, /addEventListener\("mousedown"/);
  assert.match(graphScript, /addEventListener\("mouseup"/);
  assert.match(graphScript, /Math\.hypot\(event\.clientX - candidate\.x, event\.clientY - candidate\.y\) > 9/);
  assert.match(css, /\.hotspot-cluster-edge\.is-validated[^\{]*\{[^}]*stroke:\s*rgba\(255, 255, 255/);
  assert.match(css, /\.is-forming \.hotspot-event-core[^\{]*\{[^}]*fill:\s*var\(--graph-hotspot-fill\)/);
  assert.match(css, /\.hotspot-network:focus[^\{]*\{\s*outline:\s*none/);
  assert.match(graphScript, /classList\.toggle\("is-hot-focus", hotFocus\)/);
  assert.match(graphScript, /classList\.toggle\("is-post-focus"/);
  assert.match(css, /has-graph-focus \.hotspot-post-node\.is-focus-target[^\{]*\{[^}]*opacity:\s*1 !important/);
  assert.match(css, /\.hotspot-cluster, \.hotspot-network > \.hotspot-post-node[^\{]*\{[^}]*transition:\s*opacity 420ms cubic-bezier\(\.22, 1, \.36, 1\)/);
  assert.match(css, /has-graph-focus \.hotspot-post-node\.is-background-node[^\{]*\{[^}]*opacity:\s*\.035 !important/);
  assert.match(graphScript, /classList\.toggle\("is-background-node"/);
  assert.match(graphScript, /const focusRelated = standaloneMatch \|\| clusterMatch/);
  assert.match(graphScript, /classList\.toggle\("is-background-node", !focusRelated\)/);
  assert.match(css, /has-graph-focus \.hotspot-post-node\.is-focus-related[^\{]*\{[^}]*opacity:\s*1 !important/);
  assert.match(graphScript, /classList\.toggle\("is-focus-anchor"/);
  assert.doesNotMatch(css, /hotspot-post-node:not\(\.is-focus-related\) \.hotspot-post-dot[^\{]*\{[^}]*fill:/);
  assert.match(graphScript, /closest\("\.hotspot-cluster\.is-formal"\)/);
  assert.match(graphScript, /155 \+ seededFraction\(edge\.id, seed\) \* 70/);
  assert.doesNotMatch(css, /is-settling \.hotspot-node-label/);
});

test("热帖正文使用安全 DOM 渲染并可打开证据抽屉", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  assert.match(app, /function postCard\(post/);
  assert.match(app, /card\.addEventListener\("click"[^\n]*openPost\(post\)/);
  assert.match(app, /function openPost\(post\)/);
  assert.doesNotMatch(app, /\.innerHTML\s*=/);
  assert.match(css, /\.drawer\[aria-hidden="false"\]/);
});

test("X 帖子不显示逐字稿，分析结果和视频逐字稿按类型回填抽屉", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../lib/dashboard.mjs", import.meta.url), "utf8");
  assert.match(app, /post\.deepAnalysis/);
  assert.match(app, /post\.transcriptStatus/);
  assert.match(app, /post\.platform !== "x" && \(post\.videoUrl/);
  assert.match(dashboard, /analysisMap\(database, "l2"\)/);
  assert.match(dashboard, /deepAnalysisState/);
  assert.match(dashboard, /transcriptStatus/);
});

test("热帖与关注是独立页面并共享平台和等级筛选", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(html, /id="postsPanel"[^>]+data-panel="posts"/);
  assert.match(html, /id="followingPanel"[^>]+data-panel="following"/);
  assert.match(html, /id="platformFilter"/);
  assert.match(html, /id="gradeFilter"/);
  assert.match(html, /id="hotStats"/);
  assert.doesNotMatch(html, /id="hotResultSummary"/);
  assert.match(app, /\$\("#hotStats"\)\.addEventListener\("click", event => \{/);
  assert.match(app, /if \(event\.target\.closest\("button"\)\) return;[\s\S]*state\.gradeSelection = \["T3", "T2", "T1"\]/);
  assert.match(server, /\["T3", "T2", "T1"\]\.flatMap\(grade => hotPosts\.filter\(post => post\.quality\?\.grade === grade\)\.slice\(0, gradeQuota\)\)/);
  assert.match(server, /hotPosts: balancedHotPosts/);
  assert.match(html, /data-grade-segment="T3"/);
  assert.match(html, /id="moreFilters"/);
  assert.doesNotMatch(html, /<h2>AI 热帖<\/h2>/);
  assert.match(app, /dashboard\?|"\/dashboard"/);
  assert.match(app, /dashboard\?\.hotPosts/);
  assert.match(app, /dashboard\?\.followedPosts/);
  assert.match(app, /gradeSelection: \["T3", "T2", "T1"\]/);
  assert.match(app, /timeFilter: "7d"/);
  assert.match(app, /if \(state\.tab === "posts"\) \{/);
  assert.match(app, /if \(state\.evidence !== "all"/);
  assert.match(app, /\$\("#moreFilters"\)\.hidden = tab !== "posts"/);
  assert.match(app, /function momentumDisplayLabel\(post\)/);
  assert.match(app, /target\.id === "hotPostStream" \? " is-flat"/);
  assert.match(app, /visiblePosts = posts\.filter\(matches\)\.sort/);
  assert.match(css, /\.hot-grade-bar/);
  assert.match(css, /\.date-group\.is-flat \.post-card::before \{ display: none; \}/);
});

test("页面刷新复用进行中的请求且队列状态不会反复重载整页", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(app, /if \(pageLoadPromise\) return pageLoadPromise/);
  assert.match(app, /source\.addEventListener\("queue\.updated"/);
  assert.match(app, /if \(detail\.status === "complete"\) scheduleDashboardReload\(\)/);
  assert.match(server, /stateCacheRevision === revision/);
  assert.match(server, /function lightweightSettingsRead\(/);
  assert.match(server, /compactDashboardForClient/);
});

test("队列卡片区分帖子详情与博主抽屉入口", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(app, /function openCreatorDrawer\(item\)/);
  assert.match(app, /event\.stopPropagation\(\); openCreatorDrawer\(item\)/);
  assert.match(app, /post \? openPost\(post\) : openQueueDetail\(item\)/);
  assert.match(app, /队列第 \$\{visibleItems\.findIndex\(active => active\.id === item\.id\) \+ 1\} 位 \/ 共 \$\{visibleItems\.length\} 位/);
  assert.match(app, /const QUEUE_TYPE_META = \[/);
  assert.match(server, /function queuePostContext\(state, post\)/);
  assert.match(server, /postId: post\.id/);
  assert.match(server, /creatorId: creator\?\.id/);
});

test("任务队列只展示仍待处理的实时任务", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /const liveQueueStatuses = new Set\(\["queued", "running", "waiting_extension", "deferred"\]\)/);
  assert.match(server, /liveQueueStatuses\.has\(item\.status\)/);
  assert.match(server, /includeDeferred/);
  assert.match(server, /includeHistory/);
  assert.match(server, /!isExpiredQueueItem\(item\)/);
  assert.match(server, /status_reason LIKE '%有效分析窗口%'/);
  assert.match(app, /state\.queueItems = \(payload\.items \|\| \[\]\)\.filter\(item => !isExpiredQueueItem\(item\)\)/);
  assert.match(app, /const loadSeq = \+\+queueLoadSeq/);
  assert.match(app, /if \(loadSeq !== queueLoadSeq\) return/);
  assert.match(app, /new Set\(\["queued", "running", "waiting_extension", "deferred"\]\)/);
  assert.match(app, /\["queued", "waiting_extension", "running"\]\.includes\(item\.status\)/);
  assert.match(app, /等待节点 \$\{waitingExtension\}/);
  assert.match(app, /待采集任务 · 完成后写入帖子库/);
  assert.match(server, /采集器并发上限 \$\{Math\.max\(1, Number\(concurrency\) \|\| 1\)\}，当前排序前方还有 \$\{ahead\} 项任务/);
  assert.match(server, /已等待约 \$\{hours\} 小时，系统正在按等待时长提升优先级/);
  assert.match(server, /industry: "行业关键词搜索"/);
  assert.match(server, /collectionWaitReason\(\{ \.\.\.job, statusReason: effectiveStatusReason \}, collectionWaitContext\(state, job, collector\)\)/);
  assert.match(server, /provider !== "6551" && is6551QuotaError\(job\.statusReason\)/);
});

test("热点作为默认入口并明确展示跨作者事件判定", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const graph = readFileSync(new URL("../assets/hotspot-graph.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  assert.match(html, /class="active" data-tab="events"[^>]*>热点/);
  assert.doesNotMatch(html, /id="eventWindowFilter"/);
  assert.match(html, /id="graphSearchInput"/);
  assert.match(html, /今日热点/);
  assert.match(html, /id="graphSummaryIsland"/);
  assert.match(html, /id="graphSummaryHeadline"/);
  assert.doesNotMatch(html, /id="directionSummary"/);
  assert.match(html, /id="resetGraphView"/);
  assert.match(html, /id="hotspotGraph"/);
  assert.match(html, /id="graphCoverageIsland"/);
  assert.match(html, /data-coverage-action="collect"/);
  assert.doesNotMatch(html, /data-coverage-action="queue"/);
  assert.doesNotMatch(html, /data-coverage-action="settings"/);
  assert.match(app, /graphCoverageIsland/);
  assert.doesNotMatch(html, /id="eventRanking"/);
  assert.match(app, /mountHotspotGraph/);
  assert.match(app, /graphLayoutSignature/);
  assert.match(app, /updateGraphData/);
  assert.match(app, /function openEvent\(event\)/);
  assert.match(app, /独立作者/);
  assert.match(graph, /function mountHotspotGraph/);
  assert.match(graph, /hotspot-cluster-edge/);
  assert.match(graph, /is-converging/);
  assert.match(graph, /forceLayout/);
  assert.match(graph, /settleScene/);
  assert.match(graph, /hotspot-node-label/);
  assert.match(graph, /layoutVisibleLabels/);
  assert.match(graph, /SESSION_LAYOUT_SEED/);
  assert.match(graph, /svg\.searchNodes/);
  assert.match(graph, /has-graph-focus/);
  assert.match(graph, /attachViewport/);
  assert.match(graph, /attachNodeDragging/);
  assert.match(graph, /relaxDraggedGraph/);
  assert.match(graph, /stepGraphRelaxation/);
  assert.match(graph, /nodeObstacles/);
  assert.match(graph, /performance\.now\(\) - active\.lastMoveAt > 90/);
  assert.match(graph, /followRatio = runtime\.kind === "event" \? \.56 : \.14/);
  assert.match(graph, /cooling: Math\.pow\(Math\.max\(0, 1 - frame \/ 260\), 1\.35\)/);
  assert.match(graph, /svg\.clearFocus\?\.\(\)/);
  assert.match(css, /is-relaxing/);
  assert.match(graph, /hotspot-post-hit/);
  assert.match(graph, /pinDragged/);
  assert.match(css, /is-node-dragging/);
  assert.match(graph, /svg\.updateGraphData/);
  assert.match(graph, /shouldSuppressSelect/);
  assert.match(graph, /const startedOnNode/);
  assert.match(graph, /!active\.moved && Math\.hypot/);
  assert.match(graph, /if \(!active\.moved && Math\.hypot[\s\S]+svg\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(graph, /!next\.dragging && \(pointers\.size > 1 \|\| moved > 5\)/);
  assert.match(graph, /is-selected/);
  assert.match(app, /refreshOpenGraphDetail/);
  assert.match(graph, /hotspot-pan-surface/);
  assert.match(css, /\.hotspot-graph \{/);
  assert.match(css, /\.graph-search/);
  assert.match(css, /\.hotspot-network\.has-graph-focus/);
  assert.doesNotMatch(css, /\.hotspot-forming-boundary \{/);
  assert.match(css, /\.stage-cooling\.is-formal/);
});

test("关注页隐藏重复主标题并用紧凑状态栏承接摘要和操作", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<h2>关注博主动态<\/h2>/);
  assert.match(html, /following-creators[\s\S]*following-add-button[\s\S]*id="addCreatorButton"/);
  assert.match(app, /following: \["关注追踪", "关注",/);
  assert.match(app, /\$\("\.hero"\)\.hidden = tab === "posts" \|\| tab === "following"/);
  assert.match(app, /followingContextSummary/);
  assert.match(html, /hotContextBar[\s\S]*id="coverageCard"/);
  assert.match(html, /radar-app\.js\?v=20260816-collector-controls2/);
  assert.match(html, /radar\.css\?v=20260816-collector-controls2/);
  assert.match(html, /id="addCreatorButton"[^>]*aria-label="添加关注"[^>]*>＋<\/button>/);
  assert.match(app, /followingCollectionState = health\.collectorStatus === "collecting" \|\| coverageRunning > 0/);
  assert.match(html, /id="followingCollectionState"[\s\S]*id="followingCollectionLabel"[\s\S]*id="followingCollectionQueue"/);
  assert.match(app, /followingCollectionLabel/);
  assert.match(app, /队列 \$\{formatNumber\(summary\.followedQueuedJobs\)\} · 执行中 \$\{formatNumber\(summary\.followedRunningJobs\)\}/);
  assert.match(css, /\.post-judgement-line \{[^}]*flex-wrap: nowrap[^}]*overflow-x: auto/);
  assert.match(css, /\.post-foot > span:not\(\.reason\)[^{]*\{[^}]*font-variant-numeric: tabular-nums[^}]*white-space: nowrap/);
  assert.match(css, /\.post-foot \.reason \{[^}]*width: 100%[^}]*overflow-wrap: anywhere/);
});

test("扩展节点输入框与操作按钮保持清晰的尺寸层级", () => {
  const app = readFileSync(new URL("../assets/radar-app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../assets/radar.css", import.meta.url), "utf8");
  assert.match(css, /\.collector-extension-editor \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.collector-extension-editor \.settings-input \{[^}]*min-height: 36px[^}]*font-size: 12px/);
  assert.match(css, /\.collector-extension-editor \.settings-input::placeholder \{[^}]*font-size: 10px/);
  assert.match(css, /\.collector-extension-editor \.collector-extension-action \{[^}]*width: auto[^}]*min-height: 30px[^}]*font-size: 10px/);
  assert.match(app, /collector-extension-action collector-extension-action-primary/);
});
