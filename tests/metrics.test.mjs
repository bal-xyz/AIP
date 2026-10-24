import test from "node:test";
import assert from "node:assert/strict";
import "../extension/metrics.js";

const { parseMetric, parseNamedMetric } = globalThis.AIPMetrics;

test("解析 X 的缩写和中文数字单位", () => {
  assert.equal(parseMetric("3.4K"), 3400);
  assert.equal(parseMetric("3.4万"), 34000);
  assert.equal(parseMetric("1.2M"), 1200000);
});

test("组合 aria-label 中必须读取 views，而不是第一个 replies 数字", () => {
  const label = "175 replies, 72 reposts, 751 likes, 518 bookmarks, 144,202 views";
  assert.equal(parseNamedMetric(label, ["views", "view", "次观看", "查看"]), 144202);
  assert.equal(parseNamedMetric(label, ["bookmarks", "bookmark", "书签", "收藏"]), 518);
});

test("解析中文曝光标签", () => {
  assert.equal(parseNamedMetric("144,202 次观看", ["views", "view", "次观看", "查看"]), 144202);
  assert.equal(parseNamedMetric("3.4万 查看", ["views", "view", "次观看", "查看"]), 34000);
});
