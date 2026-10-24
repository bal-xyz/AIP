import test from "node:test";
import assert from "node:assert/strict";
import { evidenceConfidence } from "../lib/evidence-confidence.mjs";

test("证据置信度按数据、R/M、内容和跨作者证据可解释计算", () => {
  const result = evidenceConfidence({
    text: "完整正文",
    evidenceCompleteness: "complete",
    transcriptStatus: "complete",
    transcript: "逐字稿",
    quality: { r: 8, m: .24, mBase: .08 }
  }, { authorCount: 8 });
  assert.equal(result.score, 1);
  assert.deepEqual(result.components, { data: 1, relative: 1, breakout: 1, content: 1, crossAuthor: 1 });
});

test("证据不足不会被模型自评置信度掩盖", () => {
  const result = evidenceConfidence({
    evidenceCompleteness: "pending",
    quality: { r: null, m: null, mBase: null }
  });
  assert.equal(result.score, .08);
  assert.equal(result.components.content, 0);
  assert.equal(result.components.crossAuthor, 0);
});
