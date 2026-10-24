import { createHash, randomUUID } from "node:crypto";

const NOTIFIABLE_STAGES = new Set(["new", "spreading", "hot", "burst"]);

function stableId(eventId, stage) {
  return `notice-${createHash("sha256").update(`${eventId}:${stage}`).digest("hex").slice(0, 24)}`;
}

export function syncStageNotifications(database, events) {
  let created = 0;
  database.db.transaction(() => {
    const insertNotification = database.db.prepare(`
      INSERT OR IGNORE INTO notifications(
        id, entity_type, entity_id, stage, channel, title, body, status, created_at
      ) VALUES(?, 'event', ?, ?, 'browser', ?, ?, 'pending', ?)
    `);
    const insertOutbox = database.db.prepare(`
      INSERT INTO outbox(id, event_type, aggregate_id, payload, status, created_at)
      VALUES(?, 'notification.created', ?, ?, 'pending', ?)
    `);
    for (const event of events || []) {
      if (!NOTIFIABLE_STAGES.has(event.stage)) continue;
      const notificationId = stableId(event.id, event.stage);
      const createdAt = new Date().toISOString();
      const result = insertNotification.run(
        notificationId,
        event.id,
        event.stage,
        `${event.stageLabel || "热点更新"} · ${event.title}`,
        event.stageReason || `${event.postCount || 0} 条帖子、${event.authorCount || 0} 位独立作者`,
        createdAt
      );
      if (!result.changes) continue;
      insertOutbox.run(randomUUID(), event.id, JSON.stringify({ notificationId }), createdAt);
      created += 1;
    }
  })();
  return created;
}

export function pendingNotifications(database, limit = 20) {
  return database.db.prepare(`
    SELECT id, entity_id AS entityId, stage, title, body, created_at AS createdAt
    FROM notifications WHERE status='pending' ORDER BY created_at ASC LIMIT ?
  `).all(Number(limit));
}

export function markNotificationDelivered(database, id) {
  const deliveredAt = new Date().toISOString();
  return database.db.transaction(() => {
    const result = database.db.prepare(`
      UPDATE notifications SET status='delivered', delivered_at=? WHERE id=? AND status='pending'
    `).run(deliveredAt, id);
    if (result.changes) {
      database.db.prepare(`
        UPDATE outbox SET status='delivered', delivered_at=?
        WHERE json_extract(payload, '$.notificationId')=? AND status='pending'
      `).run(deliveredAt, id);
    }
    return result.changes > 0;
  })();
}
