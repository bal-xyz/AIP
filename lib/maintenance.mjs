const METRICS = ["likes", "views", "replies", "reposts", "bookmarks"];

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function beijingDay(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function platformOf(item) {
  return item.platform || (String(item.source || "").startsWith("douyin") ? "douyin" : "x");
}

function summaryFor(items) {
  const sorted = [...items].sort((a, b) => timeOf(a.capturedAt) - timeOf(b.capturedAt));
  const metrics = {};
  for (const key of METRICS) {
    const available = item => item[key] !== null && item[key] !== undefined && Number.isFinite(Number(item[key]));
    const values = sorted.filter(available).map(item => Number(item[key]));
    metrics[key] = values.length ? {
      open: Number(sorted.find(available)[key]),
      close: Number([...sorted].reverse().find(available)[key]),
      min: Math.min(...values),
      max: Math.max(...values)
    } : null;
  }
  return {
    firstCapturedAt: sorted[0]?.capturedAt || null,
    lastCapturedAt: sorted.at(-1)?.capturedAt || null,
    metrics
  };
}

export function compactSnapshots(state, database, options = {}) {
  const now = Number(options.now || Date.now());
  const cutoff = now - Number(options.retentionDays || 7) * 86_400_000;
  const old = (state.snapshots || []).filter(item => {
    const capturedAt = timeOf(item.capturedAt);
    return capturedAt !== null && capturedAt < cutoff;
  });
  if (!old.length) return { compacted: 0, summaries: 0 };

  for (const row of database.db.prepare("SELECT sample_payload FROM grade_evidence WHERE revoked_at IS NULL").all()) {
    const samples = JSON.parse(row.sample_payload);
    if (!Array.isArray(samples) || samples.some(sample => !Number.isFinite(Number(sample.value)) || !sample.capturedAt)) {
      throw new Error("冻结证据不完整，拒绝压缩快照");
    }
  }

  const groups = new Map();
  for (const item of old) {
    const key = `${platformOf(item)}:${item.postId}|${beijingDay(timeOf(item.capturedAt))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const keepIds = new Set(old.map(item => item.id));
  const nextState = { ...state, snapshots: state.snapshots.filter(item => !keepIds.has(item.id)) };
  const createdAt = new Date(now).toISOString();
  database.db.transaction(() => {
    const upsert = database.db.prepare(`
      INSERT INTO snapshot_daily_summaries(post_key, day, sample_count, payload, created_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(post_key, day) DO UPDATE SET sample_count=excluded.sample_count,
        payload=excluded.payload, created_at=excluded.created_at
    `);
    for (const [key, items] of groups) {
      const separator = key.lastIndexOf("|");
      upsert.run(key.slice(0, separator), key.slice(separator + 1), items.length, JSON.stringify(summaryFor(items)), createdAt);
    }
    database.persistState(nextState);
  })();
  Object.assign(state, nextState);
  return { compacted: old.length, summaries: groups.size };
}
