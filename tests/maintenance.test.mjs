import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../lib/database.mjs";
import { compactSnapshots } from "../lib/maintenance.mjs";

test("七天以上细粒度快照压缩为每日汇总且重复执行幂等", async () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const directory = await mkdtemp(join(tmpdir(), "aip-maintenance-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const state = database.loadState();
    state.snapshots = [
      { id: "old-1", platform: "x", postId: "p1", capturedAt: "2026-07-20T01:00:00.000Z", likes: 10 },
      { id: "old-2", platform: "x", postId: "p1", capturedAt: "2026-07-20T05:00:00.000Z", likes: 20 },
      { id: "recent", platform: "x", postId: "p1", capturedAt: "2026-07-30T05:00:00.000Z", likes: 30 }
    ];
    database.persistState(state);
    const first = compactSnapshots(state, database, { now });
    assert.deepEqual(first, { compacted: 2, summaries: 1 });
    assert.deepEqual(state.snapshots.map(item => item.id), ["recent"]);
    const summary = database.db.prepare("SELECT * FROM snapshot_daily_summaries WHERE post_key='x:p1'").get();
    assert.equal(summary.sample_count, 2);
    assert.equal(JSON.parse(summary.payload).metrics.likes.close, 20);
    assert.deepEqual(compactSnapshots(state, database, { now }), { compacted: 0, summaries: 0 });
  } finally {
    database.close();
  }
});
