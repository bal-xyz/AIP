const timeOf = item => {
  const value = Date.parse(item?.publishedAt || item?.capturedAt || "");
  return Number.isFinite(value) ? value : 0;
};

export function filterContentFeed(items = [], filters = {}) {
  const scope = filters.scope === "followed" ? "followed" : "all";
  const heat = ["burst", "rising"].includes(filters.heat) ? filters.heat : "";
  const language = ["zh_original", "zh_relay", "en_source"].includes(filters.language) ? filters.language : "";
  return [...items]
    .filter(item => scope !== "followed" || item.followed)
    .filter(item => !heat || item.heatStatus === heat)
    .filter(item => !language || item.languageRole === language)
    .sort((a, b) => timeOf(b) - timeOf(a) || String(a.postId).localeCompare(String(b.postId)));
}
