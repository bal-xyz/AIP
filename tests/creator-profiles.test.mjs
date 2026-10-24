import test from "node:test";
import assert from "node:assert/strict";
import { buildCreatorProfiles } from "../lib/creator-profiles.mjs";

const posts = [
  { id: "p1", handle: "@alice", topics: ["Agent 任务交付"], views: 1200, likes: 20, analysis: { score: 78, level: "升温" }, publishedAt: "2026-07-26T01:00:00Z" },
  { id: "p2", handle: "@bob", topics: ["Agent任务交付"], views: 900, likes: 14, analysis: { score: 70, level: "普通" }, publishedAt: "2026-07-26T02:00:00Z" },
  { id: "p3", handle: "@bob", topics: ["Agent 任务交付"], views: 600, likes: 8, analysis: { score: 66, level: "普通" }, publishedAt: "2026-07-26T03:00:00Z" },
  { id: "p4", handle: "@carol", topics: ["孤立话题"], views: 0, likes: 0, analysis: { score: 80, level: "普通" }, publishedAt: "2026-07-26T04:00:00Z" }
];

test("creator directions require cross-creator evidence and real interaction", () => {
  const profiles = buildCreatorProfiles(posts, [
    { id: "a", handle: "@alice", followersApprox: 100 },
    { id: "c", handle: "@carol", followersApprox: 200 }
  ]);
  const alice = profiles.find(item => item.id === "a");
  const carol = profiles.find(item => item.id === "c");
  assert.equal(alice.primaryDirection.verified, true);
  assert.equal(alice.primaryDirection.externalCreatorCount, 1);
  assert.equal(alice.primaryDirection.totalPostCount, 3);
  assert.equal(carol.primaryDirection.verified, false);
});

test("profiles with no collected posts remain in the archive", () => {
  const [profile] = buildCreatorProfiles([], [{ id: "seed", handle: "@seed", followersApprox: 1000 }]);
  assert.equal(profile.profileStatus, "awaiting");
  assert.equal(profile.profileHeat, 0);
  assert.equal(profile.primaryDirection, null);
});
