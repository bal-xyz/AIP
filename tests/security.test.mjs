import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../lib/database.mjs";
import { SecurityManager } from "../lib/security.mjs";

function request(token, nodeId) {
  return { headers: { authorization: `Bearer ${token}`, "x-aip-node-id": nodeId } };
}

test("采集令牌绑定节点并支持轮换宽限与单节点撤销", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-security-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  const security = new SecurityManager(database, { collectorToken: "bootstrap-secret", requireAuth: false });
  try {
    const paired = security.authorizeCollector(request("bootstrap-secret", "node-local"));
    assert.deepEqual(paired, { ok: true, nodeId: "node-local" });
    assert.equal(security.authorizeCollector(request("bootstrap-secret", "node-spoof")).ok, false);
    const bootstrapRotation = security.rotateCollectorNode("node-local", { graceMinutes: 0, days: 1 });
    database.db.prepare("UPDATE collector_nodes SET previous_expires_at=? WHERE id='node-local'").run(new Date(Date.now() - 1_000).toISOString());
    assert.equal(security.authorizeCollector(request("bootstrap-secret", "node-local")).ok, false);
    assert.equal(security.authorizeCollector(request(bootstrapRotation.token, "node-local")).ok, true);

    const created = security.createCollectorNode("备用节点", { days: 1 });
    assert.equal(security.authorizeCollector(request(created.token, created.id)).ok, true);
    assert.equal(security.authorizeCollector(request(created.token, "node-local")).ok, false);

    const rotated = security.rotateCollectorNode(created.id, { graceMinutes: 15, days: 1 });
    assert.equal(security.authorizeCollector(request(created.token, created.id)).ok, true);
    assert.equal(security.authorizeCollector(request(rotated.token, created.id)).ok, true);
    assert.equal(security.revokeCollectorNode(created.id), true);
    assert.equal(security.authorizeCollector(request(rotated.token, created.id)).ok, false);
  } finally {
    database.close();
  }
});

test("生产管理会话返回可用于写请求的 CSRF 令牌", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-admin-auth-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  const security = new SecurityManager(database, {
    requireAuth: true,
    adminPassword: "correct-password",
    collectorToken: "collector-secret"
  });
  try {
    assert.equal(security.login("wrong"), null);
    const login = security.login("correct-password");
    const req = { method: "GET", headers: { cookie: `aip_session=${login.session}` } };
    const status = security.status(req);
    const secondStatus = security.status(req);
    assert.equal(status.authenticated, true);
    assert.ok(status.csrf);
    assert.equal(security.authorizeAdmin({ ...req, method: "POST", headers: { ...req.headers, "x-csrf-token": status.csrf } }).ok, true);
    assert.equal(security.authorizeAdmin({ ...req, method: "POST", headers: { ...req.headers, "x-csrf-token": secondStatus.csrf } }).ok, true);
  } finally {
    database.close();
  }
});
