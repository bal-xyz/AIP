const SVG_NS = "http://www.w3.org/2000/svg";
const SESSION_LAYOUT_SEED = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const SESSION_POSITIONS = new Map();

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shortText(value, limit = 22) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function svgNode(tag, attributes = {}, text = null) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) element.setAttribute(key, String(value));
  }
  if (text !== null) element.textContent = String(text);
  return element;
}

function gradeOf(post) {
  return post.quality?.grade || "ordinary";
}

function momentumOf(post) {
  return post.momentum?.status || "insufficient";
}

function postKey(post = {}) {
  return `${post.platform || "x"}:${post.id}`;
}

export function hotspotPostRadius(post = {}) {
  return 7;
}

export function hotspotRadius(cluster = {}) {
  return 7;
}

function visiblePosts(cluster) {
  const visible = new Set(cluster.visiblePostKeys || []);
  return (cluster.posts || []).filter(post => visible.has(`${post.platform || "x"}:${post.id}`));
}

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededFraction(value, seed = "stable-test-layout") {
  return (hashText(`${seed}:${value}`) % 10_000) / 10_000;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function applyRepulsion(nodes, force, seed) {
  const repel = (left, right, applyToBoth) => {
    let dx = right.x - left.x;
    let dy = right.y - left.y;
    if (Math.abs(dx) + Math.abs(dy) < .01) {
      dx = seededFraction(`${left.id}:${right.id}:x`, seed) - .5;
      dy = seededFraction(`${left.id}:${right.id}:y`, seed) - .5;
    }
    const distanceSquared = Math.max(144, dx * dx + dy * dy);
    const distance = Math.sqrt(distanceSquared);
    const eventWeight = left.kind === "event" && right.kind === "event" ? 10 : 1;
    const strength = 4_200 * eventWeight / distanceSquared;
    const fx = dx / distance * strength;
    const fy = dy / distance * strength;
    force.get(left.id).x -= fx;
    force.get(left.id).y -= fy;
    if (applyToBoth) {
      force.get(right.id).x += fx;
      force.get(right.id).y += fy;
    }
  };
  if (nodes.length <= 260) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        repel(nodes[leftIndex], nodes[rightIndex], true);
      }
    }
    return;
  }
  const cellSize = 120;
  const cells = new Map();
  for (const node of nodes) {
    const cellX = Math.floor(node.x / cellSize);
    const cellY = Math.floor(node.y / cellSize);
    const key = `${cellX}:${cellY}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
  }
  for (const node of nodes) {
    const cellX = Math.floor(node.x / cellSize);
    const cellY = Math.floor(node.y / cellSize);
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        for (const other of cells.get(`${cellX + offsetX}:${cellY + offsetY}`) || []) {
          if (other !== node) repel(node, other, false);
        }
      }
    }
  }
}

function forceLayout(nodes, edges, implicitEdges, width, height, seed) {
  const margin = width < 620 ? 42 : 66;
  const center = { x: width / 2, y: height / 2 };
  const velocity = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const iterations = nodes.length > 220 ? 60 : nodes.length > 120 ? 90 : nodes.length > 55 ? 140 : 220;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const cooling = 1 - iteration / iterations;
    const force = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
    applyRepulsion(nodes, force, seed);

    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const target = width < 620
        ? 96 + seededFraction(edge.id, seed) * 30
        : 155 + seededFraction(edge.id, seed) * 70;
      const strength = (distance - target) * .0105;
      const fx = dx / distance * strength;
      const fy = dy / distance * strength;
      force.get(from.id).x += fx;
      force.get(from.id).y += fy;
      force.get(to.id).x -= fx;
      force.get(to.id).y -= fy;
    }

    for (const edge of implicitEdges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const target = width < 620 ? 210 : 360;
      const strength = Math.max(0, distance - target) * .0013;
      force.get(from.id).x += dx / distance * strength;
      force.get(from.id).y += dy / distance * strength;
      force.get(to.id).x -= dx / distance * strength;
      force.get(to.id).y -= dy / distance * strength;
    }

    for (const node of nodes) {
      const pull = node.primary ? .014 : node.kind === "event" ? .0038 : node.kind === "standalone" ? .0022 : .0018;
      force.get(node.id).x += (center.x - node.x) * pull;
      force.get(node.id).y += (center.y - node.y) * pull;
      if (node.home) {
        force.get(node.id).x += (node.home.x - node.x) * .016;
        force.get(node.id).y += (node.home.y - node.y) * .016;
      }
      if (node.x < margin) force.get(node.id).x += (margin - node.x) * .045;
      if (node.x > width - margin) force.get(node.id).x -= (node.x - width + margin) * .045;
      if (node.y < margin) force.get(node.id).y += (margin - node.y) * .045;
      if (node.y > height - margin) force.get(node.id).y -= (node.y - height + margin) * .045;
      const speed = velocity.get(node.id);
      speed.x = (speed.x + force.get(node.id).x * cooling) * .84;
      speed.y = (speed.y + force.get(node.id).y * cooling) * .84;
      node.x = clamp(node.x + speed.x, -width * .25, width * 1.25);
      node.y = clamp(node.y + speed.y, -height * .25, height * 1.25);
    }
  }
  for (const node of nodes) {
    node.x = clamp(node.x, margin, width - margin);
    node.y = clamp(node.y, margin, height - margin);
  }
}

export function layoutHotspotGraph(graph = {}, width = 1200, requestedHeight = 0, options = {}) {
  const viewportWidth = Math.max(320, safeNumber(width, 1200));
  const viewportHeight = Math.max(420, safeNumber(requestedHeight) || 680);
  const clusters = graph.clusters || [];
  const nodeCount = clusters.reduce((total, cluster) => total + visiblePosts(cluster).length + 1, 0) + (graph.standalones || []).length;
  const worldScale = Math.max(1.35, Math.sqrt(Math.max(1, nodeCount) / 25));
  const safeWidth = Math.max(viewportWidth * 1.3, viewportWidth * worldScale);
  const height = Math.max(viewportHeight * 1.3, viewportHeight * worldScale);
  const mode = viewportWidth >= 620 ? "field" : "stream";
  const seed = options.seed || "stable-test-layout";
  const rememberedPositions = options.positions;
  const nodes = [];
  const edges = [];
  const implicitEdges = [];
  const byDirection = new Map();

  for (const [clusterIndex, cluster] of clusters.entries()) {
    const eventId = `event:${cluster.id}`;
    const rememberedEvent = rememberedPositions?.get(eventId);
    const angle = Math.PI * 2 * seededFraction(`${cluster.id}:angle`, seed);
    const primary = clusterIndex === 0;
    const radial = primary
      ? .015 + .045 * seededFraction(`${cluster.id}:radius`, seed)
      : .08 + .24 * seededFraction(`${cluster.id}:radius`, seed);
    const eventNode = {
      id: eventId,
      kind: "event",
      primary,
      cluster,
      x: rememberedEvent?.x ?? safeWidth / 2 + Math.cos(angle) * safeWidth * radial,
      y: rememberedEvent?.y ?? height / 2 + Math.sin(angle) * height * radial,
      home: rememberedEvent || null
    };
    nodes.push(eventNode);
    const direction = cluster.directionId || "other";
    for (const relatedId of byDirection.get(direction) || []) {
      implicitEdges.push({ from: relatedId, to: eventId });
    }
    byDirection.set(direction, [...(byDirection.get(direction) || []), eventId]);

    const clusterPosts = visiblePosts(cluster);
    for (const [postIndex, post] of clusterPosts.entries()) {
      const id = `post:${post.platform || "x"}:${post.id}`;
      const rememberedPost = rememberedPositions?.get(id);
      const postAngle = angle + Math.PI * 2 * (postIndex + .38) / Math.max(3, clusterPosts.length);
      const distance = 130 + 82 * seededFraction(`${id}:distance`, seed);
      nodes.push({
        id,
        kind: "post",
        post,
        clusterId: cluster.id,
        x: rememberedPost?.x ?? eventNode.x + Math.cos(postAngle) * distance,
        y: rememberedPost?.y ?? eventNode.y + Math.sin(postAngle) * distance,
        home: rememberedPost || null
      });
      edges.push({ id: `${eventId}:${id}`, from: eventId, to: id, clusterIndex });
    }
  }

  for (const post of graph.standalones || []) {
    const id = `standalone:${post.platform || "x"}:${post.id}`;
    const rememberedPost = rememberedPositions?.get(id);
    nodes.push({
      id,
      kind: "standalone",
      post,
      x: rememberedPost?.x ?? 54 + seededFraction(`${id}:x`, seed) * Math.max(1, safeWidth - 108),
      y: rememberedPost?.y ?? 54 + seededFraction(`${id}:y`, seed) * Math.max(1, height - 108),
      home: rememberedPost || null
    });
  }

  forceLayout(nodes, edges, implicitEdges, safeWidth, height, seed);
  const eventByCluster = new Map(nodes
    .filter(node => node.kind === "event")
    .map(node => [String(node.cluster.id), node]));
  const worldCenter = { x: safeWidth / 2, y: height / 2 };
  const start = new Map(nodes.map(node => {
    if (node.home) return [node.id, { x: node.home.x, y: node.home.y }];
    const jitterX = (seededFraction(`${node.id}:start-x`, seed) - .5) * 28;
    const jitterY = (seededFraction(`${node.id}:start-y`, seed) - .5) * 28;
    if (node.kind === "post") {
      const parent = eventByCluster.get(String(node.clusterId));
      return [node.id, { x: (parent?.x ?? node.x) + jitterX, y: (parent?.y ?? node.y) + jitterY }];
    }
    if (node.kind === "event") {
      return [node.id, {
        x: worldCenter.x + (node.x - worldCenter.x) * .72 + jitterX,
        y: worldCenter.y + (node.y - worldCenter.y) * .72 + jitterY
      }];
    }
    return [node.id, { x: node.x + jitterX, y: node.y + jitterY }];
  }));
  if (rememberedPositions) {
    const currentIds = new Set(nodes.map(node => node.id));
    for (const id of rememberedPositions.keys()) if (!currentIds.has(id)) rememberedPositions.delete(id);
    for (const node of nodes) rememberedPositions.set(node.id, { x: node.x, y: node.y });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const clusterLayouts = clusters.map(cluster => {
    const centerNode = byId.get(`event:${cluster.id}`);
    return {
      cluster,
      center: { id: centerNode.id, x: centerNode.x, y: centerNode.y, from: start.get(centerNode.id) },
      posts: nodes
        .filter(node => node.kind === "post" && node.clusterId === cluster.id)
        .map(node => ({ id: node.id, post: node.post, x: node.x, y: node.y, from: start.get(node.id) }))
    };
  });
  const standalones = nodes
    .filter(node => node.kind === "standalone")
    .map(node => ({ id: node.id, post: node.post, x: node.x, y: node.y, from: start.get(node.id) }));
  const primary = clusterLayouts.find(item => item.cluster.formal) || clusterLayouts[0];
  const focus = primary?.center || standalones[0] || { x: safeWidth / 2, y: height / 2 };
  return {
    width: safeWidth,
    height,
    viewportWidth,
    viewportHeight,
    initialView: {
      x: focus.x - viewportWidth / 2,
      y: focus.y - viewportHeight / 2,
      width: viewportWidth,
      height: viewportHeight
    },
    mode,
    clusters: clusterLayouts,
    standalones
  };
}

function postNode(point, options) {
  const post = point.post;
  const grade = gradeOf(post);
  const group = svgNode("g", {
    class: `hotspot-post-node grade-${grade} momentum-${momentumOf(post)}`,
    role: "button",
    tabindex: "0",
    transform: `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`,
    "aria-label": `${post.author || post.handle || "作者"}，${grade === "ordinary" ? "支撑帖子" : grade}`
  });
  group.dataset.postKey = postKey(post);
  group.dataset.nodeId = point.id;
  group.dataset.searchText = `${post.author || post.handle || ""} ${post.text || ""}`.toLowerCase();
  group.graphPost = post;
  group.graphPoint = point;
  // Keep the visual dot small, but give mouse and touch users a forgiving hit area.
  group.append(svgNode("circle", { class: "hotspot-post-hit", r: 25 }));
  if (momentumOf(post) === "burst") {
    group.append(svgNode("circle", { class: "hotspot-post-pulse", r: hotspotPostRadius(post) + 4 }));
  }
  group.append(svgNode("circle", { class: "hotspot-post-dot", r: hotspotPostRadius(post) }));
  group.append(svgNode("text", {
    class: `hotspot-node-label hotspot-post-label${grade === "ordinary" ? " is-support-label" : " is-hot-label"}`,
    "data-priority": ({ T3: 70, T2: 60, T1: 50, candidate: 38, ordinary: 20 })[grade] || 20,
    x: 0,
    y: 24,
    "text-anchor": "middle"
  }, shortText(post.text, 18) || post.author || post.handle || "帖子"));
  group.append(svgNode("title", {}, `${post.author || post.handle || "作者"} · ${shortText(post.text, 72)}`));
  group.addEventListener("mouseenter", () => {
    options.showPostTooltip?.(group.graphPost, group);
    options.onFocusEnter?.(options.clusterId || null, point.id);
  });
  group.addEventListener("mouseleave", () => {
    options.hidePostTooltip?.();
    options.onFocusLeave?.();
  });
  group.addEventListener("focus", () => {
    options.showPostTooltip?.(group.graphPost, group);
    options.onFocusEnter?.(options.clusterId || null, point.id);
  });
  group.addEventListener("blur", () => {
    options.hidePostTooltip?.();
    options.onFocusLeave?.();
  });
  const select = event => {
    event.stopPropagation();
    if (event.type === "click" && options.shouldSuppressSelect?.()) return;
    options.onFocusLock?.(options.clusterId || null, point.id);
    options.onPostSelect?.(group.graphPost);
  };
  group.addEventListener("click", select);
  group.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") select(event);
  });
  options.registerSettle?.(point.id, group, point.from || options.origin || point, point);
  return group;
}

function clusterGroup(layout, options) {
  const { cluster, center, posts } = layout;
  const group = svgNode("g", { class: `hotspot-cluster ${cluster.formal ? "is-formal" : "is-forming"} stage-${cluster.stage}` });
  group.dataset.clusterId = String(cluster.id);
  for (const point of posts) {
    const edge = svgNode("line", {
      class: `hotspot-cluster-edge ${cluster.formal ? "is-validated" : "is-converging"}`,
      x1: center.x,
      y1: center.y,
      x2: point.x,
      y2: point.y
    });
    group.append(edge);
    options.registerEdge?.(edge, center.id, point.id);
  }
  const centerNode = svgNode("g", {
    class: "hotspot-event-node",
    role: "button",
    tabindex: "0",
    transform: `translate(${center.x.toFixed(2)} ${center.y.toFixed(2)})`,
    "aria-label": `${cluster.title}，${cluster.formal ? cluster.stageLabel || "正式热点" : "正在聚集"}`
  });
  centerNode.dataset.clusterId = cluster.id;
  centerNode.dataset.nodeId = center.id;
  centerNode.dataset.searchText = `${cluster.title || ""} ${cluster.directionLabel || ""}`.toLowerCase();
  centerNode.graphCluster = cluster;
  centerNode.graphPoint = center;
  const selectCluster = event => {
    event.stopPropagation();
    if (event.type === "click" && options.shouldSuppressSelect?.()) return;
    group.parentNode?.querySelectorAll(".hotspot-cluster.is-selected").forEach(item => item.classList.remove("is-selected"));
    group.classList.add("is-selected");
    options.onFocusLock?.(String(cluster.id), center.id);
    options.onClusterSelect?.(centerNode.graphCluster);
  };
  centerNode.addEventListener("click", selectCluster);
  centerNode.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") selectCluster(event);
  });
  centerNode.addEventListener("mouseenter", () => {
    options.showEventTooltip?.(centerNode.graphCluster, centerNode);
    options.onFocusEnter?.(String(cluster.id), center.id);
  });
  centerNode.addEventListener("mouseleave", () => {
    options.hideTooltip?.();
    options.onFocusLeave?.();
  });
  centerNode.addEventListener("focus", () => {
    options.showEventTooltip?.(centerNode.graphCluster, centerNode);
    options.onFocusEnter?.(String(cluster.id), center.id);
  });
  centerNode.addEventListener("blur", () => {
    options.hideTooltip?.();
    options.onFocusLeave?.();
  });
  // The hit area is intentionally larger than the visible hotspot core so a click
  // near the label or edge of the node still opens the evidence drawer.
  centerNode.append(svgNode("circle", { class: "hotspot-cluster-hit", r: 30 }));
  centerNode.append(svgNode("circle", { class: "hotspot-event-core", r: hotspotRadius(cluster) }));
  centerNode.append(svgNode("text", {
    class: "hotspot-node-label hotspot-event-label",
    "data-priority": cluster.formal ? 100 : 82,
    x: 0,
    y: 25,
    "text-anchor": "middle"
  }, shortText(cluster.title, 24)));
  centerNode.append(svgNode("title", {}, `${cluster.formal ? cluster.stageLabel || "正式热点" : "候选事件"} · ${cluster.title}`));
  group.append(centerNode);
  options.registerSettle?.(center.id, centerNode, center.from || center, center);
  for (const point of posts) group.append(postNode(point, { ...options, clusterId: String(cluster.id) }));
  return group;
}

function updatePostNode(group, post) {
  if (!post) return;
  const grade = gradeOf(post);
  group.graphPost = post;
  group.dataset.searchText = `${post.author || post.handle || ""} ${post.text || ""}`.toLowerCase();
  group.setAttribute("class", `hotspot-post-node grade-${grade} momentum-${momentumOf(post)}`);
  group.setAttribute("aria-label", `${post.author || post.handle || "作者"}，${grade === "ordinary" ? "支撑帖子" : grade}`);
  const label = group.querySelector(".hotspot-post-label");
  if (label) {
    label.setAttribute("class", `hotspot-node-label hotspot-post-label${grade === "ordinary" ? " is-support-label" : " is-hot-label"}`);
    label.textContent = shortText(post.text, 18) || post.author || post.handle || "帖子";
    label.dataset.priority = String(({ T3: 70, T2: 60, T1: 50, candidate: 38, ordinary: 20 })[grade] || 20);
  }
  const title = group.querySelector("title");
  if (title) title.textContent = `${post.author || post.handle || "作者"} · ${shortText(post.text, 72)}`;
  const pulse = group.querySelector(".hotspot-post-pulse");
  if (momentumOf(post) === "burst" && !pulse) {
    group.insertBefore(svgNode("circle", { class: "hotspot-post-pulse", r: hotspotPostRadius(post) + 4 }), group.firstChild);
  } else if (momentumOf(post) !== "burst") {
    pulse?.remove();
  }
}

function updateEventNode(centerNode, cluster) {
  if (!cluster) return;
  centerNode.graphCluster = cluster;
  centerNode.dataset.searchText = `${cluster.title || ""} ${cluster.directionLabel || ""}`.toLowerCase();
  centerNode.setAttribute("aria-label", `${cluster.title}，${cluster.formal ? cluster.stageLabel || "正式热点" : "正在聚集"}`);
  const group = centerNode.parentNode;
  const selected = group?.classList.contains("is-selected") ? " is-selected" : "";
  group?.setAttribute("class", `hotspot-cluster ${cluster.formal ? "is-formal" : "is-forming"} stage-${cluster.stage}${selected}`);
  group?.querySelectorAll(".hotspot-cluster-edge").forEach(edge => {
    edge.setAttribute("class", `hotspot-cluster-edge ${cluster.formal ? "is-validated" : "is-converging"}`);
  });
  const label = centerNode.querySelector(".hotspot-event-label");
  if (label) {
    label.textContent = shortText(cluster.title, 24);
    label.dataset.priority = String(cluster.formal ? 100 : 82);
  }
  const title = centerNode.querySelector("title");
  if (title) title.textContent = `${cluster.formal ? cluster.stageLabel || "正式热点" : "候选事件"} · ${cluster.title}`;
}

function settleScene(items, edges, animate = true, onComplete = () => {}) {
  let cancelled = false;
  const positions = new Map();
  const drawEdges = () => {
    for (const edge of edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      edge.node.setAttribute("x1", from.x.toFixed(2));
      edge.node.setAttribute("y1", from.y.toFixed(2));
      edge.node.setAttribute("x2", to.x.toFixed(2));
      edge.node.setAttribute("y2", to.y.toFixed(2));
    }
  };
  if (!animate || !items.length || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    for (const item of items) {
      item.node.style.opacity = "1";
      item.node.setAttribute("transform", `translate(${item.to.x.toFixed(2)} ${item.to.y.toFixed(2)})`);
      positions.set(item.id, item.to);
    }
    drawEdges();
    onComplete();
    return () => {};
  }
  for (const item of items) {
    item.node.style.opacity = "0";
    item.node.setAttribute("transform", `translate(${item.from.x.toFixed(2)} ${item.from.y.toFixed(2)})`);
    positions.set(item.id, item.from);
  }
  drawEdges();
  const startedAt = performance.now();
  const duration = 1_350;
  const frame = now => {
    if (cancelled) return;
    let active = false;
    for (const [index, item] of items.entries()) {
      if (!item.node.isConnected) continue;
      const delay = Math.min(300, index * 7);
      const elapsed = now - startedAt - delay;
      if (elapsed < 0) {
        active = true;
        continue;
      }
      const time = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - time, 5);
      const x = item.from.x + (item.to.x - item.from.x) * ease;
      const y = item.from.y + (item.to.y - item.from.y) * ease;
      item.node.style.opacity = String(Math.min(1, ease * 1.18));
      item.node.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      positions.set(item.id, { x, y });
      if (time < 1) active = true;
    }
    drawEdges();
    if (active) requestAnimationFrame(frame);
    else onComplete();
  };
  requestAnimationFrame(frame);
  return () => { cancelled = true; };
}

export function relaxDraggedGraph(nodes, edges, draggedId, options = {}) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const dragged = byId.get(draggedId);
  if (!dragged) return nodes;
  const width = safeNumber(options.width, 1_200);
  const height = safeNumber(options.height, 680);
  const iterations = Math.max(1, safeNumber(options.iterations, 1));
  const intensity = clamp(safeNumber(options.intensity, 1), .1, 2);
  const pinDragged = options.pinDragged !== false;
  const margin = width < 620 ? 28 : 42;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const force = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        if (Math.abs(dx) + Math.abs(dy) < .01) {
          dx = seededFraction(`${left.id}:${right.id}:drag-x`, SESSION_LAYOUT_SEED) - .5;
          dy = seededFraction(`${left.id}:${right.id}:drag-y`, SESSION_LAYOUT_SEED) - .5;
        }
        const distance = Math.max(1, Math.hypot(dx, dy));
        const includesDragged = left.id === draggedId || right.id === draggedId;
        const eventPair = left.kind === "event" && right.kind === "event";
        const mixedPair = left.kind === "event" || right.kind === "event";
        const collisionDistance = eventPair ? 145 : mixedPair ? 58 : 34;
        const influenceDistance = includesDragged
          ? (dragged.kind === "event" ? (eventPair ? 250 : 150) : 96)
          : collisionDistance;
        if (distance >= influenceDistance) continue;
        const correction = Math.min(20, (influenceDistance - distance) * (includesDragged ? .13 : .18) * intensity);
        const fx = dx / distance * correction;
        const fy = dy / distance * correction;
        if (!pinDragged || left.id !== draggedId) {
          force.get(left.id).x -= fx;
          force.get(left.id).y -= fy;
        }
        if (!pinDragged || right.id !== draggedId) {
          force.get(right.id).x += fx;
          force.get(right.id).y += fy;
        }
      }
    }

    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const target = width < 620 ? 112 : 188;
      const strength = (distance - target) * .035 * intensity;
      const fx = dx / distance * strength;
      const fy = dy / distance * strength;
      if (!pinDragged || from.id !== draggedId) {
        force.get(from.id).x += fx;
        force.get(from.id).y += fy;
      }
      if (!pinDragged || to.id !== draggedId) {
        force.get(to.id).x -= fx;
        force.get(to.id).y -= fy;
      }
    }

    for (const node of nodes) {
      if (pinDragged && node.id === draggedId) continue;
      const delta = force.get(node.id);
      node.x = clamp(node.x + clamp(delta.x, -22, 22), margin, width - margin);
      node.y = clamp(node.y + clamp(delta.y, -22, 22), margin, height - margin);
    }
  }
  return nodes;
}

export function stepGraphRelaxation(nodes, edges, velocities = new Map(), options = {}) {
  const width = safeNumber(options.width, 1_200);
  const height = safeNumber(options.height, 680);
  const cooling = clamp(safeNumber(options.cooling, 1), 0, 1);
  const margin = width < 620 ? 28 : 42;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const force = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
  const cellSize = 260;
  const cells = new Map();
  nodes.forEach((node, index) => {
    const key = `${Math.floor(node.x / cellSize)}:${Math.floor(node.y / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push({ node, index });
    if (!velocities.has(node.id)) velocities.set(node.id, { x: 0, y: 0 });
  });

  nodes.forEach((left, leftIndex) => {
    const cellX = Math.floor(left.x / cellSize);
    const cellY = Math.floor(left.y / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (const { node: right, index: rightIndex } of cells.get(`${cellX + offsetX}:${cellY + offsetY}`) || []) {
          if (rightIndex <= leftIndex) continue;
          let dx = right.x - left.x;
          let dy = right.y - left.y;
          if (Math.abs(dx) + Math.abs(dy) < .01) {
            dx = seededFraction(`${left.id}:${right.id}:settle-x`, SESSION_LAYOUT_SEED) - .5;
            dy = seededFraction(`${left.id}:${right.id}:settle-y`, SESSION_LAYOUT_SEED) - .5;
          }
          const distance = Math.max(1, Math.hypot(dx, dy));
          const eventPair = left.kind === "event" && right.kind === "event";
          const mixedPair = left.kind === "event" || right.kind === "event";
          const influence = eventPair ? 340 : mixedPair ? 205 : 110;
          if (distance >= influence) continue;
          const minimum = eventPair ? 154 : mixedPair ? 66 : 36;
          const inverseForce = (eventPair ? 2_200 : mixedPair ? 860 : 300) / Math.max(625, distance * distance);
          const collisionForce = distance < minimum ? (minimum - distance) * .044 : 0;
          const strength = inverseForce + collisionForce;
          const fx = dx / distance * strength;
          const fy = dy / distance * strength;
          force.get(left.id).x -= fx;
          force.get(left.id).y -= fy;
          force.get(right.id).x += fx;
          force.get(right.id).y += fy;
        }
      }
    }
  });

  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const target = width < 620 ? 112 : 188;
    const strength = (distance - target) * .0085;
    const fx = dx / distance * strength;
    const fy = dy / distance * strength;
    force.get(from.id).x += fx;
    force.get(from.id).y += fy;
    force.get(to.id).x -= fx;
    force.get(to.id).y -= fy;
  }

  const center = { x: width / 2, y: height / 2 };
  let maxSpeed = 0;
  for (const node of nodes) {
    const nodeForce = force.get(node.id);
    const centerStrength = node.kind === "event" ? .00032 : .00008;
    nodeForce.x += (center.x - node.x) * centerStrength;
    nodeForce.y += (center.y - node.y) * centerStrength;
    const velocity = velocities.get(node.id);
    velocity.x = (velocity.x + nodeForce.x * cooling) * .84;
    velocity.y = (velocity.y + nodeForce.y * cooling) * .84;
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > 9) {
      velocity.x = velocity.x / speed * 9;
      velocity.y = velocity.y / speed * 9;
    }
    node.x = clamp(node.x + velocity.x, margin, width - margin);
    node.y = clamp(node.y + velocity.y, margin, height - margin);
    maxSpeed = Math.max(maxSpeed, Math.hypot(velocity.x, velocity.y));
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const separate = (left, right) => {
        let dx = right.x - left.x;
        let dy = right.y - left.y;
        if (Math.abs(dx) + Math.abs(dy) < .01) {
          dx = seededFraction(`${left.id}:${right.id}:collision-x`, SESSION_LAYOUT_SEED) - .5;
          dy = seededFraction(`${left.id}:${right.id}:collision-y`, SESSION_LAYOUT_SEED) - .5;
        }
        const distance = Math.max(1, Math.hypot(dx, dy));
        const eventPair = left.kind === "event" && right.kind === "event";
        const mixedPair = left.kind === "event" || right.kind === "event";
        const minimum = eventPair ? 142 : mixedPair ? 58 : 32;
        if (distance >= minimum) return;
        const correction = (minimum - distance) / 2;
        const fx = dx / distance * correction;
        const fy = dy / distance * correction;
        left.x = clamp(left.x - fx, margin, width - margin);
        left.y = clamp(left.y - fy, margin, height - margin);
        right.x = clamp(right.x + fx, margin, width - margin);
        right.y = clamp(right.y + fy, margin, height - margin);
        velocities.get(left.id).x *= .7;
        velocities.get(left.id).y *= .7;
        velocities.get(right.id).x *= .7;
        velocities.get(right.id).y *= .7;
    };
    if (nodes.length <= 260) {
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
          separate(nodes[leftIndex], nodes[rightIndex]);
        }
      }
    } else {
      nodes.forEach((left, leftIndex) => {
        const cellX = Math.floor(left.x / cellSize);
        const cellY = Math.floor(left.y / cellSize);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (const { node: right, index: rightIndex } of cells.get(`${cellX + offsetX}:${cellY + offsetY}`) || []) {
              if (rightIndex > leftIndex) separate(left, right);
            }
          }
        }
      });
    }
  }
  return maxSpeed;
}

function attachNodeDragging(svg, items, edges, layout, options = {}) {
  const runtimeNodes = items.map(item => ({
    id: item.id,
    kind: item.node.classList.contains("hotspot-event-node") ? "event" : "post",
    x: item.to.x,
    y: item.to.y,
    item
  }));
  const byId = new Map(runtimeNodes.map(node => [node.id, node]));
  let active = null;
  let settleFrame = 0;

  const activateNode = runtime => {
    const node = runtime.item.node;
    const clusterId = node.closest(".hotspot-cluster")?.dataset.clusterId || null;
    options.onFocusLock?.(clusterId, runtime.id);
    if (runtime.kind === "event") {
      svg.querySelectorAll(".hotspot-cluster.is-selected").forEach(group => group.classList.remove("is-selected"));
      node.closest(".hotspot-cluster")?.classList.add("is-selected");
      options.onClusterSelect?.(node.graphCluster);
    } else {
      options.onPostSelect?.(node.graphPost);
    }
  };

  const draw = (updateLabels = true) => {
    for (const runtime of runtimeNodes) {
      runtime.item.to.x = runtime.x;
      runtime.item.to.y = runtime.y;
      runtime.item.node.setAttribute("transform", `translate(${runtime.x.toFixed(2)} ${runtime.y.toFixed(2)})`);
      SESSION_POSITIONS.set(runtime.id, { x: runtime.x, y: runtime.y });
    }
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      edge.node.setAttribute("x1", from.x.toFixed(2));
      edge.node.setAttribute("y1", from.y.toFixed(2));
      edge.node.setAttribute("x2", to.x.toFixed(2));
      edge.node.setAttribute("y2", to.y.toFixed(2));
    }
    if (updateLabels) svg.updateLabels?.(svg.currentView);
  };
  const graphPoint = event => {
    const rect = svg.getBoundingClientRect();
    const view = svg.currentView;
    return {
      x: view.x + (event.clientX - rect.left) / Math.max(1, rect.width) * view.width,
      y: view.y + (event.clientY - rect.top) / Math.max(1, rect.height) * view.height
    };
  };
  const syncRenderedPositions = () => {
    for (const runtime of runtimeNodes) {
      const transform = runtime.item.node.getAttribute("transform") || "";
      const match = transform.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/);
      if (!match) continue;
      runtime.x = safeNumber(match[1], runtime.x);
      runtime.y = safeNumber(match[2], runtime.y);
      runtime.item.to.x = runtime.x;
      runtime.item.to.y = runtime.y;
    }
  };
  const releaseSettle = (draggedId, releaseVelocity = { x: 0, y: 0 }) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const velocities = new Map(runtimeNodes.map(node => [node.id, { x: 0, y: 0 }]));
    velocities.set(draggedId, {
      x: clamp(releaseVelocity.x, -8, 8),
      y: clamp(releaseVelocity.y, -8, 8)
    });
    let frame = 0;
    let calmFrames = 0;
    svg.classList.add("is-relaxing");
    const tick = () => {
      const maxSpeed = stepGraphRelaxation(runtimeNodes, edges, velocities, {
        width: layout.width,
        height: layout.height,
        cooling: Math.pow(Math.max(0, 1 - frame / 260), 1.35)
      });
      draw(frame % 2 === 0);
      frame += 1;
      calmFrames = maxSpeed < .035 ? calmFrames + 1 : 0;
      if (svg.isConnected && frame < 280 && (frame < 72 || calmFrames < 20)) {
        settleFrame = requestAnimationFrame(tick);
      } else {
        svg.classList.remove("is-relaxing");
        draw(true);
      }
    };
    settleFrame = requestAnimationFrame(tick);
  };

  const move = event => {
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!active.moved && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > active.dragThreshold) {
      active.moved = true;
      svg.setPointerCapture?.(event.pointerId);
    }
    if (!active.moved) return;
    const point = graphPoint(event);
    const runtime = active.runtime;
    const previousX = runtime.x;
    const previousY = runtime.y;
    runtime.x = clamp(point.x + active.offsetX, 28, layout.width - 28);
    runtime.y = clamp(point.y + active.offsetY, 28, layout.height - 28);
    const deltaX = runtime.x - previousX;
    const deltaY = runtime.y - previousY;
    const now = performance.now();
    const elapsed = clamp(now - active.lastMoveAt, 8, 40);
    const sampleX = deltaX * (16 / elapsed) * .18;
    const sampleY = deltaY * (16 / elapsed) * .18;
    active.releaseVelocity = {
      x: active.releaseVelocity.x * .65 + sampleX * .35,
      y: active.releaseVelocity.y * .65 + sampleY * .35
    };
    active.lastMoveAt = now;
    const followRatio = runtime.kind === "event" ? .56 : .14;
    const linkedIds = new Set();
    for (const edge of edges) {
      if (edge.from === runtime.id) linkedIds.add(edge.to);
      if (edge.to === runtime.id) linkedIds.add(edge.from);
    }
    for (const linkedId of linkedIds) {
      const linked = byId.get(linkedId);
      if (!linked) continue;
      linked.x = clamp(linked.x + deltaX * followRatio, 28, layout.width - 28);
      linked.y = clamp(linked.y + deltaY * followRatio, 28, layout.height - 28);
    }
    relaxDraggedGraph(runtimeNodes, edges, runtime.id, {
      width: layout.width,
      height: layout.height,
      iterations: 2,
      intensity: .58
    });
    svg.suppressSelectUntil = performance.now() + 420;
    draw();
  };
  const release = event => {
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const runtime = active.runtime;
    const wasMoved = active.moved;
    const releaseVelocity = performance.now() - active.lastMoveAt > 90
      ? { x: 0, y: 0 }
      : active.releaseVelocity;
    active = null;
    runtime.item.node.classList.remove("is-dragging");
    svg.classList.remove("is-node-dragging");
    svg.releasePointerCapture?.(event.pointerId);
    if (wasMoved) {
      svg.suppressSelectUntil = performance.now() + 420;
      svg.querySelectorAll(".hotspot-cluster.is-selected").forEach(group => group.classList.remove("is-selected"));
      svg.clearFocus?.();
      options.hideTooltip?.();
      runtime.item.node.blur?.();
      releaseSettle(runtime.id, releaseVelocity);
    } else {
      // Activate on pointer release so a real mouse/trackpad tap does not depend
      // on the browser synthesizing a later click event for the SVG group.
      svg.pointerActivatedUntil = performance.now() + 260;
      activateNode(runtime);
    }
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", release, true);
  svg.addEventListener("pointercancel", release, true);
  svg.addEventListener("lostpointercapture", release);

  for (const runtime of runtimeNodes) {
    const node = runtime.item.node;
    node.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch" && event.button !== 0) return;
      event.stopPropagation();
      cancelAnimationFrame(settleFrame);
      svg.classList.remove("is-relaxing");
      syncRenderedPositions();
      options.cancelInitialSettle?.();
      options.onInteract?.();
      options.hideTooltip?.();
      const point = graphPoint(event);
      const clusterId = node.closest(".hotspot-cluster")?.dataset.clusterId || null;
      options.onFocusLock?.(clusterId, runtime.id);
      if (runtime.kind === "event") {
        svg.querySelectorAll(".hotspot-cluster.is-selected").forEach(group => group.classList.remove("is-selected"));
        node.closest(".hotspot-cluster")?.classList.add("is-selected");
      }
      active = {
        runtime,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: runtime.x - point.x,
        offsetY: runtime.y - point.y,
        moved: false,
        dragThreshold: event.pointerType === "touch" ? 12 : 9,
        releaseVelocity: { x: 0, y: 0 },
        lastMoveAt: performance.now()
      };
      node.classList.add("is-dragging");
      svg.classList.add("is-node-dragging");
    });
  }
}

function visualTextWidth(text, fontSize) {
  let units = 0;
  for (const character of String(text || "")) units += /[\u2E80-\u9FFF\uF900-\uFAFF]/.test(character) ? 1 : .58;
  return Math.max(24, units * fontSize + 8);
}

function boxesOverlap(left, right, gap = 5) {
  return left.left < right.right + gap && left.right + gap > right.left && left.top < right.bottom + gap && left.bottom + gap > right.top;
}

function layoutVisibleLabels(svg, view) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scaleX = rect.width / view.width;
  const scaleY = rect.height / view.height;
  const detail = svg.dataset.detail || "default";
  const labels = [...svg.querySelectorAll(".hotspot-node-label")].map(label => {
    const node = label.parentNode;
    const point = node?.graphPoint;
    const priority = safeNumber(label.dataset.priority);
    const target = node?.classList.contains("is-focus-target");
    const eligible = target
      || (detail === "near")
      || (detail === "far" ? label.classList.contains("hotspot-event-label") || priority >= 70 : priority >= 38);
    return { label, node, point, priority: priority + (target ? 1_000 : 0), eligible };
  }).filter(item => item.point);
  labels.sort((left, right) => right.priority - left.priority);
  const placed = [];
  const nodeObstacles = [...svg.querySelectorAll(".hotspot-event-node, .hotspot-post-node")].map(node => {
    const point = node.graphPoint;
    if (!point) return null;
    const radius = Math.max(5, (node.classList.contains("hotspot-event-node") ? 13 : 10) * scaleX);
    const x = (point.x - view.x) * scaleX;
    const y = (point.y - view.y) * scaleY;
    return { node, left: x - radius, right: x + radius, top: y - radius, bottom: y + radius };
  }).filter(Boolean);
  const candidates = [
    { x: 0, y: 24, anchor: "middle", align: "center" },
    { x: 0, y: -17, anchor: "middle", align: "center" },
    { x: 17, y: 4, anchor: "start", align: "left" },
    { x: -17, y: 4, anchor: "end", align: "right" },
    { x: 13, y: 19, anchor: "start", align: "left" },
    { x: -13, y: 19, anchor: "end", align: "right" },
    { x: 13, y: -13, anchor: "start", align: "left" },
    { x: -13, y: -13, anchor: "end", align: "right" }
  ];
  for (const item of labels) {
    const { label, point } = item;
    label.classList.add("is-label-hidden");
    if (!item.eligible) continue;
    const screenX = (point.x - view.x) * scaleX;
    const screenY = (point.y - view.y) * scaleY;
    if (screenX < -40 || screenX > rect.width + 40 || screenY < -30 || screenY > rect.height + 30) continue;
    const fontSize = label.classList.contains("hotspot-event-label") ? 11 : 10;
    const width = visualTextWidth(label.textContent, fontSize) * scaleX;
    const height = Math.max(13, fontSize * 1.35 * scaleY);
    let chosen = null;
    for (const candidate of candidates) {
      const anchorX = screenX + candidate.x * scaleX;
      const baselineY = screenY + candidate.y * scaleY;
      const left = candidate.align === "center" ? anchorX - width / 2 : candidate.align === "right" ? anchorX - width : anchorX;
      const box = { left, right: left + width, top: baselineY - height, bottom: baselineY + 3 };
      const inside = box.left >= 7 && box.right <= rect.width - 7 && box.top >= 7 && box.bottom <= rect.height - 7;
      const coversNode = nodeObstacles.some(obstacle => obstacle.node !== item.node && boxesOverlap(box, obstacle, 2));
      if (inside && !coversNode && !placed.some(existing => boxesOverlap(box, existing))) {
        chosen = { candidate, box };
        break;
      }
    }
    if (!chosen) continue;
    label.setAttribute("x", chosen.candidate.x);
    label.setAttribute("y", chosen.candidate.y);
    label.setAttribute("text-anchor", chosen.candidate.anchor);
    label.classList.remove("is-label-hidden");
    placed.push(chosen.box);
  }
}

function attachViewport(svg, surface, layout, options = {}) {
  const initial = { ...layout.initialView, scale: 1 };
  const view = { ...initial };
  const pointers = new Map();
  let lastDistance = 0;
  let lastPoint = null;
  svg.suppressSelectUntil = 0;
  svg.pointerActivatedUntil = 0;
  const hasChanged = () => Math.abs(view.x - initial.x) > .5 || Math.abs(view.y - initial.y) > .5 || Math.abs(view.scale - 1) > .01;
  const apply = (notify = true) => {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    svg.dataset.detail = view.scale < .72 ? "far" : view.scale > 1.3 ? "near" : "default";
    svg.updateLabels?.(view);
    if (notify) options.onViewChange?.(hasChanged());
  };
  const reset = () => {
    Object.assign(view, initial);
    apply(true);
  };
  const zoomAt = (clientX, clientY, factor) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nextScale = Math.max(.28, Math.min(6, view.scale * factor));
    if (nextScale === view.scale) return;
    const ratioX = (clientX - rect.left) / rect.width;
    const ratioY = (clientY - rect.top) / rect.height;
    const nextWidth = initial.width / nextScale;
    const nextHeight = initial.height / nextScale;
    view.x += (view.width - nextWidth) * ratioX;
    view.y += (view.height - nextHeight) * ratioY;
    view.width = nextWidth;
    view.height = nextHeight;
    view.scale = nextScale;
    apply();
  };
  svg.addEventListener("wheel", event => {
    event.preventDefault();
    options.onInteract?.();
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * .0022));
  }, { passive: false });
  svg.addEventListener("keydown", event => {
    const rect = svg.getBoundingClientRect();
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    }
  });
  svg.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" && event.target !== surface && event.target !== svg) return;
    options.onInteract?.();
    const startedOnNode = Boolean(event.target.closest?.(".hotspot-event-node, .hotspot-post-node"));
    const dragging = !startedOnNode;
    if (dragging) {
      svg.clearFocus?.();
      svg.setPointerCapture?.(event.pointerId);
      svg.classList.add("is-panning");
    }
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      dragging
    });
    lastPoint = { x: event.clientX, y: event.clientY };
    if (pointers.size === 2) {
      svg.clearFocus?.();
      for (const [pointerId, point] of pointers) {
        point.dragging = true;
        svg.setPointerCapture?.(pointerId);
      }
      const [first, second] = [...pointers.values()];
      lastDistance = Math.hypot(second.x - first.x, second.y - first.y);
      svg.suppressSelectUntil = performance.now() + 350;
      svg.classList.add("is-panning");
    }
  });
  svg.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    const next = { ...previous, x: event.clientX, y: event.clientY };
    const moved = Math.hypot(next.x - next.startX, next.y - next.startY);
    if (!next.dragging && (pointers.size > 1 || moved > 5)) {
      next.dragging = true;
      svg.clearFocus?.();
      svg.setPointerCapture?.(event.pointerId);
      svg.classList.add("is-panning");
    }
    pointers.set(event.pointerId, next);
    if (pointers.size > 1 || moved > 5) {
      svg.suppressSelectUntil = performance.now() + 350;
    }
    const rect = svg.getBoundingClientRect();
    if (pointers.size === 1 && next.dragging && lastPoint && rect.width && rect.height) {
      view.x -= (event.clientX - lastPoint.x) / rect.width * view.width;
      view.y -= (event.clientY - lastPoint.y) / rect.height * view.height;
      apply();
      lastPoint = { x: event.clientX, y: event.clientY };
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      if (lastDistance) zoomAt(midpoint.x, midpoint.y, distance / lastDistance);
      lastDistance = distance;
    }
  });
  const release = event => {
    pointers.delete(event.pointerId);
    lastDistance = 0;
    lastPoint = pointers.size === 1 ? [...pointers.values()][0] : null;
    if (!pointers.size) svg.classList.remove("is-panning");
  };
  svg.addEventListener("pointerup", release);
  svg.addEventListener("pointercancel", release);
  svg.addEventListener("dblclick", event => {
    if (event.target === surface || event.target === svg) reset();
  });
  svg.focusPoint = (x, y, scale = 1.45) => {
    view.scale = clamp(scale, .28, 6);
    view.width = initial.width / view.scale;
    view.height = initial.height / view.scale;
    view.x = x - view.width / 2;
    view.y = y - view.height / 2;
    apply(true);
  };
  svg.resetView = reset;
  svg.currentView = view;
  apply(false);
}

export function mountHotspotGraph(container, graph = {}, options = {}) {
  container.replaceChildren();
  const hasData = (graph.clusters || []).length || (graph.standalones || []).length;
  if (!hasData) {
    const empty = document.createElement("div");
    empty.className = "hotspot-graph-empty";
    empty.setAttribute("aria-label", "热点正在积累");
    container.append(empty);
    return null;
  }
  const layout = layoutHotspotGraph(graph, container.clientWidth || 1200, container.clientHeight || 0, {
    seed: SESSION_LAYOUT_SEED,
    positions: SESSION_POSITIONS
  });
  const settlingNodes = [];
  const settlingEdges = [];
  const tooltip = document.createElement("div");
  tooltip.className = "hotspot-tooltip";
  tooltip.hidden = true;
  const showTooltip = (title, description, target) => {
    const heading = document.createElement("b");
    heading.textContent = title;
    const copy = document.createElement("span");
    copy.textContent = description;
    tooltip.replaceChildren(heading, copy);
    tooltip.hidden = false;
    const targetRect = target.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const left = Math.max(10, Math.min(containerRect.width - 250, targetRect.left - containerRect.left + targetRect.width / 2 - 110));
    const top = Math.max(10, targetRect.top - containerRect.top - 76);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  const hideTooltip = () => { tooltip.hidden = true; };
  const showPostTooltip = (post, target) => showTooltip(
    `${post.author || post.handle || "作者"} · ${gradeOf(post) === "ordinary" ? "支撑帖子" : gradeOf(post)}`,
    shortText(post.text, 76),
    target
  );
  const showEventTooltip = (cluster, target) => showTooltip(
    `${cluster.formal ? cluster.stageLabel || "正式热点" : "候选事件"} · ${cluster.title}`,
    cluster.formal
      ? `${cluster.postCount} 条帖子 · ${cluster.authorCount} 位作者`
      : `${cluster.progress?.posts || 0}/8 帖子 · ${cluster.progress?.authors || 0}/5 作者`,
    target
  );
  const graphOptions = {
    ...options,
    showPostTooltip,
    showEventTooltip,
    hidePostTooltip: hideTooltip,
    hideTooltip,
    registerSettle: (id, node, from, to) => settlingNodes.push({ id, node, from, to }),
    registerEdge: (node, from, to) => settlingEdges.push({ node, from, to })
  };
  const svg = svgNode("svg", {
    class: `hotspot-network layout-${layout.mode}${options.animate === false ? " no-settle" : " is-settling"}`,
    viewBox: `${layout.initialView.x} ${layout.initialView.y} ${layout.initialView.width} ${layout.initialView.height}`,
    role: "group",
    tabindex: "0",
    "aria-label": "热点与热帖关系图，可缩放和平移",
    preserveAspectRatio: "xMidYMid meet"
  });
  let lockedFocus = null;
  const applyFocus = (clusterId, targetId, locked = false) => {
    if (!clusterId && !targetId) return;
    if (locked) lockedFocus = { clusterId, targetId };
    svg.classList.add("has-graph-focus");
    const focusTarget = [...svg.querySelectorAll(".hotspot-post-node, .hotspot-event-node")]
      .find(node => node.dataset.nodeId === targetId);
    const hotFocus = Boolean(
      focusTarget?.matches(".grade-T1, .grade-T2, .grade-T3")
      || focusTarget?.closest(".hotspot-cluster.is-formal")
    );
    const targetIsPost = Boolean(focusTarget?.matches(".hotspot-post-node"));
    svg.classList.toggle("is-post-focus", targetIsPost);
    svg.classList.toggle("is-hot-focus", hotFocus);
    // 切换相关节点时，同步移动选中簇，避免上一个热点仍保留选中外观。
    svg.querySelectorAll(".hotspot-cluster.is-selected").forEach(group => group.classList.remove("is-selected"));
    focusTarget?.closest(".hotspot-cluster")?.classList.add("is-selected");
    svg.querySelectorAll(".hotspot-cluster").forEach(group => {
      group.classList.toggle("is-focus-related", Boolean(clusterId) && group.dataset.clusterId === String(clusterId));
    });
    svg.querySelectorAll(".hotspot-post-node, .hotspot-event-node").forEach(node => {
      const standaloneMatch = !clusterId && node.dataset.nodeId === targetId;
      const nodeClusterId = node.closest(".hotspot-cluster")?.dataset.clusterId || null;
      const clusterMatch = Boolean(clusterId) && nodeClusterId === String(clusterId);
      const focusRelated = standaloneMatch || clusterMatch;
      const focusAnchor = targetIsPost
        && node.matches(".hotspot-event-node")
        && clusterMatch;
      node.classList.toggle("is-focus-related", focusRelated);
      node.classList.toggle("is-focus-target", node.dataset.nodeId === targetId);
      node.classList.toggle("is-focus-anchor", focusAnchor);
      node.classList.toggle("is-background-node", !focusRelated);
    });
    svg.updateLabels?.(svg.currentView);
  };
  const clearFocus = (force = false) => {
    if (lockedFocus && !force) return;
    lockedFocus = null;
    svg.classList.remove("has-graph-focus", "is-hot-focus", "is-post-focus");
    svg.querySelectorAll(".hotspot-cluster.is-selected").forEach(node => node.classList.remove("is-selected"));
    svg.querySelectorAll(".is-focus-related, .is-focus-target, .is-focus-anchor, .is-background-node").forEach(node => node.classList.remove("is-focus-related", "is-focus-target", "is-focus-anchor", "is-background-node"));
    svg.updateLabels?.(svg.currentView);
    options.onFocusClear?.();
  };
  graphOptions.onFocusEnter = (clusterId, targetId) => {
    if (!lockedFocus) applyFocus(clusterId, targetId);
  };
  graphOptions.onFocusLeave = () => {
    if (!lockedFocus) clearFocus(true);
  };
  graphOptions.onFocusLock = (clusterId, targetId) => applyFocus(clusterId, targetId, true);
  const panSurface = svgNode("rect", {
    class: "hotspot-pan-surface",
    x: 0,
    y: 0,
    width: layout.width,
    height: layout.height
  });
  graphOptions.shouldSuppressSelect = () =>
    svg.suppressSelectUntil > performance.now() || svg.pointerActivatedUntil > performance.now();
  svg.append(panSurface);
  for (const cluster of layout.clusters) svg.append(clusterGroup(cluster, graphOptions));
  if (layout.standalones.length) {
    for (const point of layout.standalones) svg.append(postNode(point, graphOptions));
  }
  const activateGraphTarget = target => {
    if (target.classList.contains("hotspot-event-node")) {
      target.closest(".hotspot-cluster")?.classList.add("is-selected");
      graphOptions.onFocusLock?.(String(target.dataset.clusterId || ""), target.dataset.nodeId);
      graphOptions.onClusterSelect?.(target.graphCluster);
    } else {
      const clusterId = target.closest(".hotspot-cluster")?.dataset.clusterId || null;
      graphOptions.onFocusLock?.(clusterId, target.dataset.nodeId);
      graphOptions.onPostSelect?.(target.graphPost);
    }
  };

  // Fallback delegation keeps node activation reliable if an SVG child consumes
  // the click before the group's listener in a particular browser engine.
  svg.addEventListener("click", event => {
    const target = event.target?.closest?.(".hotspot-event-node, .hotspot-post-node");
    if (!target || !svg.contains(target) || graphOptions.shouldSuppressSelect?.()) return;
    event.stopPropagation();
    activateGraphTarget(target);
  });

  // Some embedded browser surfaces do not reliably synthesize an SVG click from
  // a physical mouse tap. Capture mouse down/up as a second path while preserving drag.
  let mouseCandidate = null;
  svg.addEventListener("mousedown", event => {
    const target = event.target?.closest?.(".hotspot-event-node, .hotspot-post-node");
    if (event.button !== 0 || !target || !svg.contains(target)) return;
    mouseCandidate = { target, x: event.clientX, y: event.clientY };
  }, true);
  svg.addEventListener("mouseup", event => {
    const candidate = mouseCandidate;
    mouseCandidate = null;
    if (!candidate || Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > 9) return;
    if (graphOptions.shouldSuppressSelect?.()) return;
    svg.pointerActivatedUntil = performance.now() + 260;
    activateGraphTarget(candidate.target);
  }, true);
  container.append(svg, tooltip);
  svg.updateLabels = view => layoutVisibleLabels(svg, view || svg.currentView || { ...layout.initialView, scale: 1 });
  svg.clearFocus = () => clearFocus(true);
  svg.searchNodes = query => {
    const normalized = String(query || "").trim().toLowerCase();
    if (!normalized) return [];
    return [...svg.querySelectorAll(".hotspot-event-node, .hotspot-post-node")]
      .filter(node => node.dataset.searchText?.includes(normalized))
      .sort((left, right) => Number(right.querySelector(".hotspot-node-label")?.dataset.priority || 0) - Number(left.querySelector(".hotspot-node-label")?.dataset.priority || 0))
      .slice(0, 8)
      .map(node => ({
        key: node.dataset.nodeId,
        label: node.classList.contains("hotspot-event-node")
          ? node.graphCluster?.title || "热点"
          : `${node.graphPost?.author || node.graphPost?.handle || "作者"} · ${shortText(node.graphPost?.text, 28)}`,
        kind: node.classList.contains("hotspot-event-node") ? "热点" : "帖子"
      }));
  };
  svg.focusNode = key => {
    const target = [...svg.querySelectorAll(".hotspot-event-node, .hotspot-post-node")].find(node => node.dataset.nodeId === key);
    if (!target?.graphPoint) return false;
    const clusterId = target.closest(".hotspot-cluster")?.dataset.clusterId || null;
    applyFocus(clusterId, key, true);
    svg.focusPoint?.(target.graphPoint.x, target.graphPoint.y, 1.55);
    target.focus({ preventScroll: true });
    return true;
  };
  attachViewport(svg, panSurface, layout, options);
  let cancelInitialSettle = () => {};
  attachNodeDragging(svg, settlingNodes, settlingEdges, layout, {
    ...graphOptions,
    cancelInitialSettle: () => cancelInitialSettle()
  });
  cancelInitialSettle = settleScene(settlingNodes, settlingEdges, options.animate !== false, () => {
    svg.classList.remove("is-settling");
    svg.updateLabels?.(svg.currentView);
  });
  svg.updateGraphData = nextGraph => {
    const clustersById = new Map((nextGraph.clusters || []).map(cluster => [String(cluster.id), cluster]));
    const postsByKey = new Map();
    for (const cluster of nextGraph.clusters || []) {
      for (const post of cluster.posts || []) postsByKey.set(postKey(post), post);
    }
    for (const post of nextGraph.standalones || []) postsByKey.set(postKey(post), post);
    svg.querySelectorAll(".hotspot-event-node").forEach(node => updateEventNode(node, clustersById.get(node.dataset.clusterId)));
    svg.querySelectorAll(".hotspot-post-node").forEach(node => updatePostNode(node, postsByKey.get(node.dataset.postKey)));
    if (lockedFocus) applyFocus(lockedFocus.clusterId, lockedFocus.targetId, true);
    else svg.updateLabels?.(svg.currentView);
  };
  return svg;
}
