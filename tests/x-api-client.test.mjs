import test from "node:test";
import assert from "node:assert/strict";
import { XApiClient, normalizeXApiPosts } from "../lib/x-api-client.mjs";

test("X 官方接口使用 Bearer 令牌和增量游标", async () => {
  let request;
  const client = new XApiClient({ token: "token", fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  await client.search("AI -is:retweet", { maxResults: 200, sinceId: "123" });
  assert.match(request.url, /\/2\/tweets\/search\/recent/);
  assert.match(request.url, /since_id=123/);
  assert.match(request.url, /max_results=100/);
  assert.equal(request.options.headers.Authorization, "Bearer token");
});

test("X 官方接口返回字段可归一为现有帖子结构", () => {
  const [post] = normalizeXApiPosts({ data: [{ id: "1", text: "OpenAI", author_id: "2", created_at: "2026-08-08T00:00:00Z", public_metrics: { like_count: 10, retweet_count: 2, reply_count: 1 } }], includes: { users: [{ id: "2", username: "openai", name: "OpenAI", verified: true, public_metrics: { followers_count: 100 } }] } });
  assert.equal(post.source, "x_official_api");
  assert.equal(post.handle, "@openai");
  assert.equal(post.likes, 10);
  assert.match(post.url, /openai\/status\/1$/);
});
