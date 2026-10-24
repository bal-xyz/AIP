import test from "node:test";
import assert from "node:assert/strict";
import { renderPostRow } from "../assets/post-row.js";

test("一行只使用同一个帖子对象的内容、形态和火因", () => {
  const postA = {
    id: "post-a",
    handle: "@alpha",
    author: "Alpha",
    text: "A帖正文：保姆级教程",
    url: "https://x.com/alpha/status/1",
    views: 12345,
    replies: 12,
    reposts: 34,
    likes: 56,
    bookmarks: 78,
    analysis: {
      hot: true,
      level: "爆发",
      shape: { type: "教程 / 方法", media: "视频", structure: ["数字钩子"] },
      ratios: { interaction: .0145 },
      reasonSummary: "A帖火因：收藏率高",
      evidence: "A帖证据：曝光 12,345"
    }
  };
  const postB = {
    ...postA,
    id: "post-b",
    text: "B帖正文：观点",
    analysis: { ...postA.analysis, shape: { type: "观点 / 结论", media: "纯文字", structure: [] }, reasonSummary: "B帖火因：回复率高", evidence: "B帖证据" }
  };
  const row = renderPostRow(postA);
  assert.match(row, /data-post-id="post-a"/);
  assert.match(row, /A帖正文/);
  assert.match(row, /教程 \/ 方法/);
  assert.match(row, /A帖火因/);
  assert.doesNotMatch(row, /post-b|B帖正文|观点 \/ 结论|B帖火因/);
});

test("帖子内容经过转义，不能破坏明细结构", () => {
  const row = renderPostRow({ id: "safe", handle: "@safe", text: "<script>bad()</script>", url: "https://x.com/safe/status/1", analysis: { shape: { type: "观点", media: "纯文字", structure: [] }, ratios: {} } });
  assert.doesNotMatch(row, /<script>/);
  assert.match(row, /&lt;script&gt;/);
});

test("X未公开收藏数时显示未知而不是0", () => {
  const row = renderPostRow({ id: "unknown-bookmarks", handle: "@safe", text: "真实帖子", url: "https://x.com/safe/status/2", bookmarks: null, bookmarksAvailable: false, analysis: { shape: { type: "观点", media: "纯文字", structure: [] }, ratios: {} } });
  assert.match(row, /X时间线未提供收藏数/);
  assert.match(row, />—<\/td>/);
});
