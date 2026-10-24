import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase, newLeaseNonce, payloadHash } from "../lib/database.mjs";

function fixture() {
  return {
    version: 5,
    collector: { status: "connected", lastRunAt: "2026-07-31T01:00:00.000Z", lastError: null },
    creators: [{ id: "creator-1", handle: "@truth", status: "followed" }],
    industries: [{ id: "rule-1", name: "AI", keywords: ["Codex"] }],
    jobs: [{ id: "job-1", targetType: "creator", status: "queued", requestedAt: "2026-07-31T01:00:00.000Z" }],
    posts: [{ id: "post-1", platform: "x", handle: "@truth", text: "Codex 发布", likes: 10, capturedAt: "2026-07-31T01:00:00.000Z", analysis: { hot: true }, quality: { grade: "T3" } }],
    snapshots: [{ id: "snapshot-1", postId: "post-1", platform: "x", likes: 10, capturedAt: "2026-07-31T01:00:00.000Z" }],
    industrySignals: [],
    creatorCandidates: [],
    trendingKeywords: [{ id: "old-term", status: "active" }],
    followUpQueue: [],
    earlyEvents: [{ id: "old-event", stage: "hot" }],
    sourceRegistry: [],
    eventAudit: [],
    validationTasks: [],
    discoveryHistory: [],
    skills: [{ id: "legacy-skill" }],
    skillAudit: [{ id: "audit-1" }],
    skillSettings: { trustedOrigins: [] }
  };
}

test("旧状态影子导入到 SQLite 并归档 Skill 数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-db-"));
  const statePath = join(directory, "state.json");
  const databasePath = join(directory, "monitor.sqlite");
  await writeFile(statePath, JSON.stringify(fixture()));

  const database = new StateDatabase(databasePath);
  try {
    const preview = database.importLegacy(statePath, { dryRun: true });
    assert.equal(preview.report.collections.posts.count, 1);
    assert.equal(preview.report.archived.skills, 1);
    assert.equal(database.isEmpty(), true);

    const imported = database.importLegacy(statePath);
    assert.equal(imported.imported, true);
    const state = database.loadState();
    assert.equal(state.version, 6);
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].text, "Codex 发布");
    assert.equal("analysis" in state.posts[0], false);
    assert.equal("quality" in state.posts[0], false);
    assert.equal(state.trendingKeywords.length, 0);
    assert.equal(state.earlyEvents.length, 0);
    assert.ok(database.db.prepare("SELECT 1 FROM legacy_archive WHERE key='trendingKeywords'").get());
    assert.ok(database.db.prepare("SELECT 1 FROM legacy_archive WHERE key='postDerived'").get());
    assert.equal("skills" in state, false);
    assert.equal(database.integrityReport().integrity, "ok");
  } finally {
    database.close();
  }
});

test("持久化更新保持平台作品唯一并可重复加载", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-db-"));
  const databasePath = join(directory, "monitor.sqlite");
  const database = new StateDatabase(databasePath);
  try {
    const state = fixture();
    delete state.skills;
    delete state.skillAudit;
    delete state.skillSettings;
    database.persistState(state);
    state.posts[0].likes = 25;
    state.snapshots.push({ id: "snapshot-2", postId: "post-1", platform: "x", likes: 25, capturedAt: "2026-07-31T02:00:00.000Z" });
    database.persistState(state);
    assert.equal(database.loadState().posts[0].likes, 25);
    assert.equal(database.loadState().snapshots.length, 2);
  } finally {
    database.close();
  }
});

test("数据版本随状态写入变化，便于服务发现外部更新", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-db-revision-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const state = fixture();
    delete state.skills;
    delete state.skillAudit;
    delete state.skillSettings;
    const before = database.dataRevision();
    database.persistState(state);
    const after = database.dataRevision();
    assert.notEqual(after, before);
    state.posts.push({ id: "post-2", platform: "x", text: "新的帖子", capturedAt: "2026-07-31T02:00:00.000Z" });
    database.persistState(state);
    assert.notEqual(database.dataRevision(), after);
  } finally {
    database.close();
  }
});

test("采集平台开关持久化且默认同时开启 X 与抖音", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-db-platforms-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const initial = database.loadState();
    assert.deepEqual(initial.collectionSettings, { x: true, douyin: true });
    initial.collectionSettings = { x: false, douyin: true };
    database.persistState(initial);
    assert.deepEqual(database.loadState().collectionSettings, { x: false, douyin: true });
  } finally {
    database.close();
  }
});

test("结果载荷哈希稳定，租约代次不可复用", () => {
  const payload = {
    jobId: "job-1",
    nodeId: "node-1",
    leaseNonce: "lease-1",
    capturedAt: "2026-07-31T01:00:00.000Z",
    posts: [{ id: "post-1", likes: 10, text: "内容" }]
  };
  assert.equal(payloadHash(payload), payloadHash(structuredClone(payload)));
  assert.notEqual(payloadHash(payload), payloadHash({ ...payload, posts: [{ ...payload.posts[0], likes: 11 }] }));
  assert.notEqual(payloadHash({ ...payload, platform: "x" }), payloadHash({ ...payload, platform: "douyin" }));
  assert.notEqual(newLeaseNonce(), newLeaseNonce());
});

test("同一事件的多轮历史使用来源复合键完整迁移", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-db-history-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const state = database.loadState();
    state.discoveryHistory = [
      { id: "event-1", earliestPostId: "post-1", stage: "expired" },
      { id: "event-1", earliestPostId: "post-2", stage: "graduated" }
    ];
    database.persistState(state);
    assert.equal(database.loadState().discoveryHistory.length, 2);
    assert.equal(database.integrityReport().counts.event_history, 2);
  } finally {
    database.close();
  }
});
