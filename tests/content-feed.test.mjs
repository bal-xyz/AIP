import assert from "node:assert/strict";
import test from "node:test";
import { filterContentFeed } from "../lib/content-feed.mjs";

const ITEMS = [
  { postId: "3", publishedAt: "2026-07-27T09:00:00.000Z", followed: false, heatStatus: "burst", languageRole: "en_source" },
  { postId: "1", publishedAt: "2026-07-27T11:00:00.000Z", followed: true, heatStatus: "rising", languageRole: "zh_original" },
  { postId: "2", publishedAt: "2026-07-27T10:00:00.000Z", followed: true, heatStatus: "candidate", languageRole: "zh_relay" }
];

test("全部与关注博主共用同一列表并严格按发布时间倒序", () => {
  assert.deepEqual(filterContentFeed(ITEMS).map(item => item.postId), ["1", "2", "3"]);
  assert.deepEqual(filterContentFeed(ITEMS, { scope: "followed" }).map(item => item.postId), ["1", "2"]);
  assert.deepEqual(ITEMS.map(item => item.postId), ["3", "1", "2"]);
});

test("状态和来源筛选在前端组合生效，全部状态保留候选和冷却", () => {
  assert.deepEqual(filterContentFeed(ITEMS, { heat: "rising" }).map(item => item.postId), ["1"]);
  assert.deepEqual(filterContentFeed(ITEMS, { language: "zh_relay" }).map(item => item.postId), ["2"]);
  assert.deepEqual(filterContentFeed(ITEMS, { scope: "followed", language: "zh_original" }).map(item => item.postId), ["1"]);
  assert.deepEqual(filterContentFeed(ITEMS, { heat: "candidate" }).map(item => item.postId), ["1", "2", "3"]);
});
