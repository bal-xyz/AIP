import test from "node:test";
import assert from "node:assert/strict";
import { buildHotspotGraph } from "../lib/hotspot-graph.mjs";
import { hotspotPostRadius, hotspotRadius, layoutHotspotGraph, relaxDraggedGraph, stepGraphRelaxation } from "../assets/hotspot-graph.js";

const now = Date.parse("2026-08-01T12:00:00.000Z");

function post(id, author, hoursAgo, grade = "ordinary", overrides = {}) {
  return {
    id,
    platform: overrides.platform || "x",
    author,
    handle: `@${author}`,
    text: overrides.text || "OpenAI 发布 GPT-6 编程能力",
    publishedAt: new Date(now - hoursAgo * 3_600_000).toISOString(),
    likes: grade === "T3" ? 9000 : grade === "T2" ? 3000 : grade === "T1" ? 900 : 80,
    aiRelevant: true,
    ...overrides,
    eventFields: overrides.eventFields || {
      subject: "openai",
      action: "release",
      version: "gpt-6",
      confidence: .98,
      origin: "test"
    },
    quality: { grade, label: ({ T1: "小爆", T2: "爆款", T3: "现象级" })[grade] || "普通" },
    momentum: { status: overrides.momentum || "stable" }
  };
}

test("单条 T3 只形成独立热帖点，不能生成热点中心", () => {
  const graph = buildHotspotGraph([post("solo", "alice", .2, "T3")], { now, window: "72h" });
  assert.equal(graph.clusters.length, 0);
  assert.equal(graph.standalones.length, 1);
  assert.equal(graph.summary.formalHotspotCount, 0);
});

test("五条三作者与一条 T1 显示形成中进度而不是正式热点", () => {
  const posts = Array.from({ length: 5 }, (_, index) => post(
    `forming-${index}`,
    `author-${index % 3}`,
    .4 + index,
    index === 0 ? "T1" : "ordinary"
  ));
  const graph = buildHotspotGraph(posts, { now, window: "72h" });
  const [cluster] = graph.clusters;
  assert.equal(cluster.formal, false);
  assert.equal(cluster.stage, "spreading");
  assert.deepEqual(
    { posts: cluster.progress.posts, authors: cluster.progress.authors, missingPosts: cluster.progress.missingPosts, missingAuthors: cluster.progress.missingAuthors },
    { posts: 5, authors: 3, missingPosts: 3, missingAuthors: 2 }
  );
  assert.equal(cluster.progress.hotGateMet, false);
});

test("八条五作者且存在 T2 时生成正式热点中心", () => {
  const posts = Array.from({ length: 8 }, (_, index) => post(
    `hot-${index}`,
    `author-${index % 5}`,
    2.5 + index,
    index === 0 ? "T2" : "ordinary"
  ));
  const graph = buildHotspotGraph(posts, { now, window: "72h" });
  const [cluster] = graph.clusters;
  assert.equal(cluster.formal, true);
  assert.equal(cluster.stage, "hot");
  assert.equal(cluster.progress.hotGateMet, true);
  assert.equal(cluster.visiblePostKeys.length, 8);
  assert.equal(graph.summary.formalHotspotCount, 1);
});

test("十二条八作者、两条 T2 且最近两小时加速时生成爆发热点", () => {
  const posts = Array.from({ length: 12 }, (_, index) => post(
    `burst-${index}`,
    `author-${index % 8}`,
    index < 9 ? .2 + index * .12 : 2.4 + (index - 9) * .3,
    index < 2 ? "T2" : "ordinary",
    { momentum: index === 0 ? "burst" : "stable" }
  ));
  const graph = buildHotspotGraph(posts, { now, window: "72h" });
  const [cluster] = graph.clusters;
  assert.equal(cluster.formal, true);
  assert.equal(cluster.stage, "burst");
  assert.equal(cluster.acceleration.accelerating, true);
  assert.equal(cluster.visiblePostKeys.length, 12);
  assert.equal(cluster.hiddenPostCount, 0);
});

test("同一作者重复发帖不能伪造正式热点", () => {
  const posts = Array.from({ length: 10 }, (_, index) => post(
    `repeat-${index}`,
    "same-author",
    .3 + index * .2,
    index === 0 ? "T3" : "T1"
  ));
  const graph = buildHotspotGraph(posts, { now, window: "72h" });
  assert.equal(graph.clusters[0].authorCount, 1);
  assert.equal(graph.clusters[0].formal, false);
});

test("热点图固定使用最近七十二小时且方向使用固定分类", () => {
  const oldPosts = Array.from({ length: 5 }, (_, index) => post(
    `old-${index}`,
    `author-${index}`,
    76 + index,
    index === 0 ? "T1" : "ordinary",
    { text: "Codex coding CLI 发布新版本" }
  ));
  const currentPosts = Array.from({ length: 5 }, (_, index) => post(
    `current-${index}`,
    `current-author-${index}`,
    48 + index,
    index === 0 ? "T1" : "ordinary",
    { text: "Codex coding CLI 发布新版本" }
  ));
  const graph = buildHotspotGraph([...oldPosts, ...currentPosts], { now, window: "72h" });
  assert.equal(graph.window, "72h");
  assert.equal(graph.clusters.length, 1);
  assert.equal(graph.clusters[0].directionId, "coding");
  assert.equal(graph.directions[0].label, "人工智能编程");
});

test("七十二小时关系图不截断事件簇、成员帖子或独立热帖", () => {
  const clustered = Array.from({ length: 10 }, (_, clusterIndex) => Array.from({ length: 3 }, (_, postIndex) => post(
    `cluster-${clusterIndex}-${postIndex}`,
    `cluster-author-${clusterIndex}-${postIndex}`,
    1 + clusterIndex + postIndex / 10,
    postIndex === 0 ? "T1" : "ordinary",
    {
      text: `OpenAI 发布 GPT-${clusterIndex + 10} 模型`,
      eventFields: { subject: "openai", action: "release", version: `gpt-${clusterIndex + 10}`, confidence: .98, origin: "test" }
    }
  ))).flat();
  const standalone = Array.from({ length: 15 }, (_, index) => post(
    `standalone-${index}`,
    `standalone-author-${index}`,
    .2 + index / 10,
    "T1",
    {
      text: `Anthropic 发布 Claude-${index + 20} 模型`,
      eventFields: { subject: "anthropic", action: "release", version: `claude-${index + 20}`, confidence: .98, origin: "test" }
    }
  ));
  const graph = buildHotspotGraph([...clustered, ...standalone], { now, window: "72h" });
  assert.equal(graph.clusters.length, 10);
  assert.equal(graph.standalones.length, 15);
  assert.equal(graph.hiddenClusterCount, 0);
  assert.ok(graph.clusters.every(cluster => cluster.visiblePostKeys.length === cluster.postCount));
});

test("节点尺寸与稳定布局只保留两层视觉语义", () => {
  assert.equal(hotspotPostRadius({ quality: { grade: "ordinary" } }), 7);
  assert.equal(hotspotPostRadius({ quality: { grade: "T1" } }), 7);
  assert.equal(hotspotPostRadius({ quality: { grade: "T2" } }), 7);
  assert.equal(hotspotPostRadius({ quality: { grade: "T3" } }), 7);
  assert.equal(hotspotRadius({ heat: 100 }), hotspotRadius({ heat: 40 }));
  const layout = layoutHotspotGraph({
    clusters: [{ id: "cluster", formal: true, heat: 82, visiblePostKeys: ["x:p1"], posts: [{ id: "p1", platform: "x", quality: { grade: "T1" } }] }],
    standalones: [{ id: "solo", platform: "x", quality: { grade: "T3" } }]
  }, 1200);
  assert.equal(layout.clusters.length, 1);
  assert.equal(layout.clusters[0].posts.length, 1);
  assert.equal(layout.standalones.length, 1);
  assert.ok(layout.height > 200);
  assert.notEqual(layout.clusters[0].center.x, 1200 * .33);
  assert.ok(Number.isFinite(layout.clusters[0].center.from.x));
  assert.ok(Math.hypot(
    layout.clusters[0].center.x - layout.width / 2,
    layout.clusters[0].center.y - layout.height / 2
  ) < 210);
});

test("拖动热点时目标位置保持固定且附近节点自动避让", () => {
  const nodes = [
    { id: "event:drag", kind: "event", x: 300, y: 300 },
    { id: "event:near", kind: "event", x: 330, y: 300 },
    { id: "post:linked", kind: "post", x: 620, y: 300 }
  ];
  relaxDraggedGraph(nodes, [{ from: "event:drag", to: "post:linked" }], "event:drag", {
    width: 1_200,
    height: 680,
    iterations: 3
  });
  assert.deepEqual({ x: nodes[0].x, y: nodes[0].y }, { x: 300, y: 300 });
  assert.ok(nodes[1].x > 330);
  assert.ok(nodes[2].x < 620);
  const releasedX = nodes[0].x;
  relaxDraggedGraph(nodes, [{ from: "event:drag", to: "post:linked" }], "event:drag", {
    width: 1_200,
    height: 680,
    iterations: 2,
    pinDragged: false
  });
  assert.notEqual(nodes[0].x, releasedX);
});

test("松手后节点通过阻尼力场自然舒展并逐渐稳定", () => {
  const nodes = [
    { id: "event:center", kind: "event", x: 300, y: 300 },
    { id: "post:near", kind: "post", x: 330, y: 300 },
    { id: "post:far", kind: "post", x: 640, y: 300 }
  ];
  const edges = [
    { from: "event:center", to: "post:near" },
    { from: "event:center", to: "post:far" }
  ];
  const velocities = new Map([["event:center", { x: 6, y: 0 }]]);
  const firstSpeed = stepGraphRelaxation(nodes, edges, velocities, { width: 1_200, height: 680 });
  let finalSpeed = firstSpeed;
  for (let frame = 0; frame < 280; frame += 1) {
    finalSpeed = stepGraphRelaxation(nodes, edges, velocities, { width: 1_200, height: 680 });
  }
  assert.ok(firstSpeed > finalSpeed);
  assert.ok(Math.hypot(nodes[1].x - nodes[0].x, nodes[1].y - nodes[0].y) > 100);
  assert.ok(finalSpeed < .2);
  for (const [index, left] of nodes.entries()) {
    for (const right of nodes.slice(index + 1)) {
      const minimum = left.kind === "event" || right.kind === "event" ? 48 : 28;
      assert.ok(Math.hypot(right.x - left.x, right.y - left.y) >= minimum - .01);
    }
  }
});

test("松手冷却曲线让力场和速度连续归零而不是到期截停", () => {
  const nodes = [
    { id: "event:center", kind: "event", x: 300, y: 300 },
    { id: "post:linked", kind: "post", x: 520, y: 300 }
  ];
  const edges = [{ from: "event:center", to: "post:linked" }];
  const velocities = new Map([["event:center", { x: 8, y: 2 }]]);
  let finalSpeed = Infinity;
  for (let frame = 0; frame < 280; frame += 1) {
    finalSpeed = stepGraphRelaxation(nodes, edges, velocities, {
      width: 1_200,
      height: 680,
      cooling: Math.pow(Math.max(0, 1 - frame / 260), 1.35)
    });
  }
  assert.ok(finalSpeed < .04);
});

test("力导向布局可复现且帖子不会形成等距圆环", () => {
  const cluster = {
    id: "natural-cluster",
    title: "OpenAI 发布新的推理模型",
    directionId: "models",
    formal: true,
    heat: 88,
    visiblePostKeys: ["x:p1", "x:p2", "x:p3", "x:p4"],
    posts: ["p1", "p2", "p3", "p4"].map((id, index) => post(id, `author-${index}`, index + 1, index === 0 ? "T2" : "ordinary"))
  };
  const first = layoutHotspotGraph({ clusters: [cluster] }, 1200, 680);
  const second = layoutHotspotGraph({ clusters: [cluster] }, 1200, 680);
  assert.deepEqual(first, second);
  const { center, posts } = first.clusters[0];
  const distances = posts.map(point => Math.round(Math.hypot(point.x - center.x, point.y - center.y)));
  assert.ok(new Set(distances).size > 1);
  assert.ok(Math.min(...distances) > 120);
  assert.ok(posts.every(point => Math.hypot(point.from.x - center.x, point.from.y - center.y) < 30));
});

test("一千和两千节点使用空间网格布局并满足主线程性能预算", () => {
  const measure = count => {
    const standalones = Array.from({ length: count }, (_, index) => ({
      id: `large-${count}-${index}`,
      platform: "x",
      quality: { grade: "T1" }
    }));
    const startedAt = performance.now();
    const layout = layoutHotspotGraph({ standalones }, 1200, 680);
    return { duration: performance.now() - startedAt, count: layout.standalones.length };
  };
  const thousand = measure(1_000);
  const twoThousand = measure(2_000);
  assert.equal(thousand.count, 1_000);
  assert.equal(twoThousand.count, 2_000);
  assert.ok(thousand.duration < 1_000, `一千节点布局耗时 ${Math.round(thousand.duration)}ms`);
  assert.ok(twoThousand.duration < 2_200, `两千节点布局耗时 ${Math.round(twoThousand.duration)}ms`);
});
