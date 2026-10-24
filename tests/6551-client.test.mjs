import test from "node:test";
import assert from "node:assert/strict";
import { normalize6551Posts, OpenTwitterClient } from "../lib/6551-client.mjs";

test("6551 客户端使用 Bearer 令牌并限制查询数量", async () => {
  let request;
  const client = new OpenTwitterClient({
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  await client.search({ keywords: "OpenAI", maxResults: 999 });
  assert.equal(request.url, "https://ai.6551.io/open/twitter_search");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.parse(request.options.body).maxResults, 100);
});

test("6551 帖子字段可归一为现有 X 指标结构", () => {
  const [post] = normalize6551Posts({ data: [{
    id: "1", text: "OpenAI", createdAt: "2026-08-04T10:00:00Z", userScreenName: "openai",
    userName: "OpenAI", userIdStr: "2", favoriteCount: 10, retweetCount: 3, replyCount: 2,
    quoteCount: 1, viewCount: 100, userFollowers: 1000
  }] });
  assert.equal(post.platformAuthorId, "2");
  assert.equal(post.likes, 10);
  assert.equal(post.followers, 1000);
  assert.equal(post.source, "x_6551_api");
  assert.match(post.url, /\/status\/1$/);
});
