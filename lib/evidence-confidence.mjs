function bounded(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function thresholdScore(value, thresholds) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  for (const [limit, score] of thresholds) if (number >= limit) return score;
  return 0.35;
}

/**
 * Deterministic confidence for an analysis explanation. This is separate from
 * the model's self-reported confidence and is always traceable to local evidence.
 */
export function evidenceConfidence(post, event = null) {
  const quality = post.quality || {};
  const completeness = post.evidenceCompleteness || "pending";
  const data = { complete: 1, partial: .6, pending: .3, invalid: 0 }[completeness] ?? .3;
  const relative = thresholdScore(quality.r, [[8, 1], [4, .85], [2, .7]]);
  const mBase = Number(quality.mBase);
  const mRatio = Number.isFinite(mBase) && mBase > 0 ? Number(quality.m) / mBase : NaN;
  const breakout = thresholdScore(mRatio, [[3, 1], [1.5, .85], [1, .7]]);
  const hasText = String(post.text || "").trim().length > 0;
  const hasTranscript = post.transcriptStatus === "complete" && String(post.transcript || "").trim().length > 0;
  const hasMedia = Boolean(post.videoUrl || (Array.isArray(post.mediaUrls) && post.mediaUrls.length));
  const content = (hasText ? .5 : 0) + (hasTranscript ? .5 : hasMedia ? .2 : 0);
  const authorCount = Number(event?.authorCount || post.eventAuthorCount || 0);
  const crossAuthor = authorCount >= 8 ? 1 : authorCount >= 5 ? .85 : authorCount >= 3 ? .65 : authorCount >= 2 ? .4 : 0;
  const components = { data, relative, breakout, content: bounded(content), crossAuthor };
  const score = bounded(.25 * data + .25 * relative + .2 * breakout + .2 * components.content + .1 * crossAuthor);
  return {
    score: Math.round(score * 100) / 100,
    components,
    weights: { data: .25, relative: .25, breakout: .2, content: .2, crossAuthor: .1 },
    reasons: {
      data: completeness === "complete" ? "正文、指标和快照证据完整" : `证据状态：${completeness}`,
      relative: Number.isFinite(Number(quality.r)) ? `R 值 ${Number(quality.r).toFixed(2)}` : "R 值缺失",
      breakout: Number.isFinite(mRatio) ? `M / 基准 ${mRatio.toFixed(2)} 倍` : "M 值或基准缺失",
      content: hasTranscript ? "正文与逐字稿均可核验" : hasText ? "有正文证据，暂无逐字稿" : "缺少正文证据",
      crossAuthor: authorCount ? `${authorCount} 位独立作者参与` : "尚未归入跨作者热点"
    }
  };
}
