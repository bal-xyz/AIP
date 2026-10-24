const API_BASE = "https://api.x.com";

const POST_FIELDS = "created_at,public_metrics,author_id,conversation_id,referenced_tweets,lang";
const USER_FIELDS = "username,name,verified,public_metrics";

export class XApiClient {
  constructor({ token, fetchImpl = fetch, baseUrl = API_BASE } = {}) {
    this.token = String(token || "").trim();
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl || API_BASE).replace(/\/+$/, "");
    if (!this.token) throw new Error("未配置 X 官方接口访问令牌");
  }

  async get(path, params = {}, { timeoutMs = 20_000 } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload.detail || payload.title || `X 官方接口返回 HTTP ${response.status}`), { status: response.status, code: response.status === 429 ? "RATE_LIMITED" : "X_API_HTTP_ERROR", retryAfter: response.headers.get("retry-after") });
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("X 官方接口请求超时");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async tweetsByUser(username, { maxResults = 20, sinceId } = {}) {
    const handle = String(username || "").replace(/^@/, "").trim();
    if (!handle) throw new Error("缺少作者账号");
    const user = await this.get(`/2/users/by/username/${encodeURIComponent(handle)}`, { "user.fields": USER_FIELDS });
    if (!user.data?.id) return { data: [], includes: {} };
    return this.get(`/2/users/${encodeURIComponent(user.data.id)}/tweets`, {
      max_results: Math.min(Math.max(Number(maxResults) || 20, 5), 100), since_id: sinceId,
      "tweet.fields": POST_FIELDS, expansions: "author_id", "user.fields": USER_FIELDS
    });
  }

  search(query, { maxResults = 20, sinceId } = {}) {
    return this.get("/2/tweets/search/recent", {
      query: String(query || "").trim(), max_results: Math.min(Math.max(Number(maxResults) || 20, 10), 100), since_id: sinceId,
      "tweet.fields": POST_FIELDS, expansions: "author_id", "user.fields": USER_FIELDS
    });
  }
}

export function normalizeXApiPosts(payload) {
  const users = new Map((payload?.includes?.users || []).map(user => [String(user.id), user]));
  return (payload?.data || []).filter(row => row?.id && row?.text).map(row => {
    const author = users.get(String(row.author_id)) || {};
    const metrics = row.public_metrics || {};
    return {
      id: String(row.id), text: String(row.text),
      url: `https://x.com/${author.username || "i"}/status/${row.id}`,
      handle: author.username ? `@${author.username}` : "", displayName: author.name || author.username || "",
      platformAuthorId: row.author_id || null, publishedAt: row.created_at || null, language: row.lang || null,
      likes: Number(metrics.like_count || 0), reposts: Number(metrics.retweet_count || 0), replies: Number(metrics.reply_count || 0), quotes: Number(metrics.quote_count || 0),
      views: Number.isFinite(Number(metrics.impression_count)) ? Number(metrics.impression_count) : null,
      followers: Number.isFinite(Number(author.public_metrics?.followers_count)) ? Number(author.public_metrics.followers_count) : null,
      verified: author.verified === true, conversationId: row.conversation_id || null,
      isReply: (row.referenced_tweets || []).some(item => item.type === "replied_to"), isQuote: (row.referenced_tweets || []).some(item => item.type === "quoted"),
      media: [], source: "x_official_api", sourceUrl: `https://x.com/${author.username || "i"}/status/${row.id}`
    };
  });
}
