import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDatabase } from "../lib/database.mjs";
import { markNotificationDelivered, pendingNotifications, syncStageNotifications } from "../lib/notifications.mjs";

test("事件同阶段通知幂等，升级阶段产生新通知并同步发件箱", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aip-notification-"));
  const database = new StateDatabase(join(directory, "monitor.sqlite"));
  try {
    const event = { id: "event-1", title: "OpenAI 新模型", stage: "hot", stageLabel: "热点", stageReason: "达到门槛" };
    assert.equal(syncStageNotifications(database, [event]), 1);
    assert.equal(syncStageNotifications(database, [event]), 0);
    assert.equal(pendingNotifications(database).length, 1);
    const id = pendingNotifications(database)[0].id;
    assert.equal(markNotificationDelivered(database, id), true);
    assert.equal(markNotificationDelivered(database, id), false);
    assert.equal(database.db.prepare("SELECT status FROM outbox").get().status, "delivered");
    assert.equal(syncStageNotifications(database, [{ ...event, stage: "burst", stageLabel: "爆发热点" }]), 1);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM notifications").get().count, 2);
  } finally {
    database.close();
  }
});
