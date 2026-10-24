const MINUTE = 60_000;
const WINDOWS = [
  { start: 8 * 60, end: 11 * 60, intervalMinutes: 20, reason: "工作日早间高峰" },
  { start: 14 * 60, end: 18 * 60, intervalMinutes: 25, reason: "工作日下午高峰" },
  { start: 20 * 60, end: 22 * 60, intervalMinutes: 20, reason: "工作日晚间高峰" }
];

function isXRecord(record = {}) {
  const platform = String(record.platform || record.network || "").toLowerCase();
  if (platform) return platform === "x" || platform === "twitter";
  const source = String(record.source || record.sourceType || "").toLowerCase();
  if (source.includes("douyin") || source.includes("xiaohongshu") || source.includes("rednote")) return false;
  const url = String(record.url || record.postUrl || "").toLowerCase();
  if (url.includes("douyin.com") || url.includes("xiaohongshu.com") || url.includes("xhslink.com")) return false;
  return source.includes("x_browser") || source.includes("twitter") || url.includes("x.com") || url.includes("twitter.com");
}

function eventHasXEvidence(event = {}) {
  if (event.platform || event.network || event.platforms || event.platformCounts) {
    if (["x", "twitter"].includes(String(event.platform || event.network || "").toLowerCase())) return true;
    if (Array.isArray(event.platforms) && event.platforms.some(platform => ["x", "twitter"].includes(String(platform).toLowerCase()))) return true;
    if (Number(event.platformCounts?.x || event.platformCounts?.twitter || 0) > 0) return true;
  }
  return [...(event.postEvidence || []), ...(event.posts || [])].some(isXRecord);
}

function beijingParts(now) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(now));
  const get = type => parts.find(item => item.type === type)?.value || "";
  const weekday = { "周一": 1, "周二": 2, "周三": 3, "周四": 4, "周五": 5, "周六": 6, "周日": 0 }[get("weekday")] ?? 1;
  return { weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function xCollectionSchedule(state = {}, now = Date.now()) {
  const { weekday, minutes } = beijingParts(now);
  const configured = state.collectionSettings?.frequencyPolicy;
  if (configured?.mode === "fixed") {
    return { timezone: "Asia/Shanghai", window: "fixed", intervalMinutes: Math.max(5, Number(configured.activeIntervalMinutes || 15)), reason: "采集配置固定频率" };
  }
  const risingEvent = (state.earlyEvents || []).some(event => eventHasXEvidence(event) && ["burst", "hot", "spreading", "near_rising"].includes(event.stage));
  const recentHighGradePost = (state.posts || []).some(post => {
    const publishedAt = Date.parse(post.publishedAt || post.capturedAt || "");
    return isXRecord(post) && publishedAt && now - publishedAt <= 6 * 60 * 60_000 && ["T2", "T3"].includes(post.quality?.grade || post.qualityGrade);
  });
  if (risingEvent || recentHighGradePost) {
    return { timezone: "Asia/Shanghai", window: "hotspot", intervalMinutes: 15, reason: "热点持续升温" };
  }
  const highDay = weekday === 3 || weekday === 4;
  const weekend = weekday === 0 || weekday === 6;
  const peak = WINDOWS.find(item => minutes >= item.start && minutes < item.end);
  if (peak) {
    const multiplier = highDay ? 1 : weekend ? 2.25 : 1.5;
    return { timezone: "Asia/Shanghai", window: "peak", intervalMinutes: Math.round(peak.intervalMinutes * multiplier), reason: highDay ? peak.reason : weekend ? "周末活跃时段" : "普通工作日活跃时段" };
  }
  const intervalMinutes = weekend ? 180 : minutes < 8 * 60 ? 120 : minutes < 14 * 60 ? (highDay ? 60 : 90) : minutes < 20 * 60 ? (highDay ? 45 : 60) : (highDay ? 90 : 120);
  return { timezone: "Asia/Shanghai", window: "off_peak", intervalMinutes, reason: weekend ? "周末低活跃时段" : "非高峰时段" };
}

export function xCollectionIntervalMs(state = {}, now = Date.now()) {
  return xCollectionSchedule(state, now).intervalMinutes * MINUTE;
}
