import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../lib/database.mjs";
import { queueTranscript, validateMediaUrl } from "../lib/media-policy.mjs";

test("逐字稿媒体策略拒绝本机、私网和未知域名", () => {
  for (const url of [
    "http://127.0.0.1/private",
    "https://192.168.1.2/video.mp4",
    "https://example.com/video.mp4"
  ]) {
    assert.throws(() => validateMediaUrl(url));
  }
  assert.match(validateMediaUrl("https://video.twimg.com/ext_tw_video/a.mp4"), /^https:/);
});

test("没有视频证据时只创建元数据任务", () => {
  const directory = mkdtempSync(join(tmpdir(), "aip-media-"));
  const database = new StateDatabase(join(directory, "test.sqlite"));
  try {
    const task = queueTranscript(database, { id: "p1", platform: "x", language: "zh" });
    assert.equal(task.status, "metadata_only");
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM transcripts").get().count, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
