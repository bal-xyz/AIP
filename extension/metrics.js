(function (scope) {
  function parseMetric(label = "") {
    const compact = String(label).replace(/,/g, "").trim();
    const match = compact.match(/([\d.]+)\s*([KMB万亿]?)/i);
    if (!match) return 0;
    const unit = match[2].toUpperCase();
    const multiplier = unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : unit === "万" ? 1e4 : unit === "亿" ? 1e8 : 1;
    return Math.round(Number(match[1]) * multiplier) || 0;
  }

  function parseNamedMetric(label = "", words = []) {
    const compact = String(label).replace(/,/g, "");
    for (const word of words) {
      const escaped = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = compact.match(new RegExp(`([\\d.]+)\\s*([KMB万亿]?)\\s*(?:${escaped})`, "i"));
      if (before) return parseMetric(`${before[1]}${before[2]}`);
      const after = compact.match(new RegExp(`(?:${escaped})\\s*([\\d.]+)\\s*([KMB万亿]?)`, "i"));
      if (after) return parseMetric(`${after[1]}${after[2]}`);
    }
    return 0;
  }

  scope.AIPMetrics = { parseMetric, parseNamedMetric };
})(globalThis);
