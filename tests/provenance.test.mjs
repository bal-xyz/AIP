import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChineseHotQueries,
  buildPostProvenance,
  enqueueChineseHotJobs,
  enqueueRootTraceJobs
} from "../lib/provenance.mjs";

const now = "2026-07-25T08:00:00.000Z";
const hot = {
  hot: true,
  level: "升温",
  score: 70
};

test("中文热点采集覆盖多个 AI 子领域且强制使用中文搜索", () => {
  const queries = buildChineseHotQueries();
  assert.ok(queries.length >= 5);
  assert.ok(queries.every(item => item.query.includes("lang:zh")));
  assert.ok(queries.some(item => item.query.includes("机器人")));
  assert.ok(queries.some(item => item.query.includes("AI 安全")));
});

test("手动更新会加入中文热帖任务且不会重复活动任务", () => {
  const state = { industries: [{ id: "ai", name: "AI" }], jobs: [] };
  let count = 0;
  enqueueChineseHotJobs(state, prefix => `${prefix}-${++count}`, { now: Date.parse(now), force: true });
  const firstCount = state.jobs.length;
  enqueueChineseHotJobs(state, prefix => `${prefix}-${++count}`, { now: Date.parse(now), force: true });
  assert.equal(firstCount, 10);
  assert.deepEqual(new Set(state.jobs.map(job => job.platform)), new Set(["x", "douyin"]));
  assert.equal(state.jobs.length, firstCount);
});

test("中文热帖中的明确 X 引用生成母帖直达任务", () => {
  const state = {
    industries: [{ id: "ai", name: "AI" }],
    jobs: [],
    posts: [{
      id: "child",
      handle: "@cn",
      text: "Codex 接入桌面语音协作，中文跟进解读",
      url: "https://x.com/cn/status/child",
      publishedAt: "2026-07-25T07:00:00.000Z",
      referencedPostUrls: ["https://x.com/source/status/123"],
      analysis: hot,
      topics: ["Codex"]
    }]
  };
  enqueueRootTraceJobs(state, () => "trace-1", { now: Date.parse(now) });
  assert.equal(state.jobs[0].targetType, "root_trace");
  assert.equal(state.jobs[0].targetUrl, "https://x.com/source/status/123");
});

test("明确引用入库后形成已确认母帖与加工帖关系", () => {
  const posts = [{
    id: "123",
    handle: "@source",
    text: "Codex desktop voice is now available.",
    url: "https://x.com/source/status/123",
    publishedAt: "2026-07-25T05:00:00.000Z",
    analysis: { hot: true, level: "升温", score: 75 }
  }, {
    id: "456",
    handle: "@cn",
    text: "Codex 桌面语音模式上线了，这是中文解读。",
    url: "https://x.com/cn/status/456",
    publishedAt: "2026-07-25T06:00:00.000Z",
    referencedPostIds: ["123"],
    referencedPostUrls: ["https://x.com/source/status/123"],
    analysis: hot,
    topics: ["Codex"]
  }];
  const result = buildPostProvenance(posts);
  const child = result.find(post => post.id === "456");
  const root = result.find(post => post.id === "123");
  assert.equal(child.provenance.status, "confirmed");
  assert.equal(child.provenance.rootPostId, "123");
  assert.deepEqual(root.rootSourceForPostIds, ["456"]);
});
