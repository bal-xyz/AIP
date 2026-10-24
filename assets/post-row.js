function esc(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" }[char]));
}

function format(value = 0) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN", { notation: number >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
}

function formatOptional(value, available = true) {
  return available && value !== null && value !== undefined ? format(value) : "—";
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function renderPostRow(post) {
  const analysis = post.analysis || {};
  const ratios = analysis.ratios || {};
  const shape = analysis.shape || { type: "待分析", media: "—", structure: [] };
  const heatClass = analysis.level === "爆发" ? "burst" : analysis.level === "走高" ? "rising" : "normal";
  return `<tr data-post-id="${esc(post.id)}"><td><div class="post-cell"><b>${esc(post.author || post.handle)} · ${esc(post.age || formatTime(post.publishedAt))}</b><small><a class="post-link" href="${esc(post.url)}" target="_blank" rel="noreferrer">${esc(post.text)}</a></small></div></td><td><div class="shape-stack"><b>${esc(shape.type)}</b><small>${esc([shape.media, ...(shape.structure || [])].join(" · "))}</small></div></td><td class="${analysis.hot ? "number-hot" : ""}">${format(post.views)}</td><td>${format(post.replies)}</td><td>${format(post.reposts)}</td><td>${format(post.likes)}</td><td title="${post.bookmarksAvailable ? "X页面可见收藏数" : "X时间线未提供收藏数"}">${formatOptional(post.bookmarks, post.bookmarksAvailable)}</td><td>${((ratios.interaction || 0) * 100).toFixed(2)}%</td><td><span class="heat-chip ${heatClass}">${esc(analysis.level || "正常")}</span></td><td><div class="reason-cell"><b>${esc(analysis.reasonSummary || "等待更多数据")}</b><small>${esc(analysis.evidence || "")}</small></div></td></tr>`;
}
