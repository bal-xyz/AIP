const API_BASE = "https://ai.6551.io";

export class OpenTwitterClient {
  constructor({ token, fetchImpl = fetch, baseUrl = API_BASE } = {}) {
    this.token = String(token || "").trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || API_BASE).replace(/\/+$/, "");
    if (!this.token) throw new Error("未配置 6551 访问令牌");
  }

  async post(path, body, { timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload.error || `6551 接口返回 HTTP ${response.status}`), { status: response.status, code: "6551_HTTP_ERROR" });
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("6551 接口请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  tweetsByUser(username, options = {}) {
    return this.post("/open/twitter_user_tweets", {
      username: String(username || "").replace(/^@/, ""),
      maxResults: Math.min(Math.max(Number(options.maxResults || 20), 1), 100),
      product: options.product || "Latest",
      includeReplies: options.includeReplies === true,
      includeRetweets: options.includeRetweets === true
    }, { timeoutMs: options.timeoutMs || 30_000 });
  }

  search(options = {}) {
    const body = {
      keywords: String(options.keywords || "").trim(),
      product: options.product || "Latest",
      maxResults: Math.min(Math.max(Number(options.maxResults || 20), 1), 100),
      excludeReplies: options.excludeReplies !== false,
      excludeRetweets: options.excludeRetweets !== false
    };
    for (const key of ["fromUser", "lang", "hashtag", "sinceDate", "untilDate"]) {
      if (options[key]) body[key] = options[key];
    }
    return this.post("/open/twitter_search", body, { timeoutMs: options.timeoutMs || 30_000 });
  }
}

export function normalize6551Posts(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter(row => row?.id && row?.text).map(row => ({
    id: String(row.id),
    text: String(row.text),
    url: row.url || `https://x.com/${row.userScreenName || "i"}/status/${row.id}`,
    handle: row.userScreenName ? `@${row.userScreenName}` : "",
    displayName: row.userName || row.userScreenName || "",
    platformAuthorId: row.userIdStr || null,
    publishedAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    language: row.language || null,
    likes: Number.isFinite(Number(row.favoriteCount)) ? Number(row.favoriteCount) : null,
    reposts: Number.isFinite(Number(row.retweetCount)) ? Number(row.retweetCount) : null,
    replies: Number.isFinite(Number(row.replyCount)) ? Number(row.replyCount) : null,
    quotes: Number.isFinite(Number(row.quoteCount)) ? Number(row.quoteCount) : null,
    views: Number.isFinite(Number(row.viewCount)) ? Number(row.viewCount) : null,
    followers: Number.isFinite(Number(row.userFollowers)) ? Number(row.userFollowers) : null,
    verified: row.userVerified === true,
    conversationId: row.conversationId || null,
    isReply: row.isReply === true,
    isQuote: row.isQuote === true,
    media: Array.isArray(row.media) ? row.media : [],
    source: "x_6551_api",
    sourceUrl: row.url || `https://x.com/${row.userScreenName || "i"}/status/${row.id}`
  }));
}
