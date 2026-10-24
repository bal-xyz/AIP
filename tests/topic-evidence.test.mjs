import test from "node:test";
import assert from "node:assert/strict";
import { buildFollowedCreatorSummaries, buildTopicCreatorEvidence, xProfileUrl } from "../lib/topic-evidence.mjs";

const posts = [
  { id: "p1", handle: "@alice", author: "Alice", publishedAt: "2026-07-23T01:00:00Z", analysis: { level: "升温", score: 75 } },
  { id: "p2", handle: "@bob", author: "Bob", publishedAt: "2026-07-23T02:00:00Z", analysis: { level: "爆发", score: 91 } },
  { id: "p3", handle: "@alice", author: "Alice", publishedAt: "2026-07-23T03:00:00Z", analysis: { level: "普通", score: 62 } }
];

test("topic evidence groups unique creators and preserves X paths", () => {
  const result = buildTopicCreatorEvidence({ sourcePostIds: ["p1", "p2", "p3"] }, posts, [{ handle: "@alice" }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].handle, "@alice");
  assert.equal(result[0].postIds.length, 2);
  assert.equal(result[0].followed, true);
  assert.equal(result[0].xProfileUrl, "https://x.com/alice");
  assert.equal(result[1].maxHeat, "爆发");
});

test("followed creator summaries calculate post and hot counts", () => {
  const result = buildFollowedCreatorSummaries(posts, [{ id: "c1", handle: "@alice", displayName: "Alice" }]);
  assert.equal(result[0].postCount, 2);
  assert.equal(result[0].hotCount, 1);
  assert.equal(result[0].latestAt, "2026-07-23T03:00:00Z");
});

test("X profile URL strips the at sign", () => {
  assert.equal(xProfileUrl("@Khazix0918"), "https://x.com/Khazix0918");
});
