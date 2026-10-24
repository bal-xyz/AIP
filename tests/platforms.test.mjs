import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function testingHooks() {
  const metrics = readFileSync(new URL("../extension/metrics.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../extension/platforms.js", import.meta.url), "utf8");
  const context = {
    globalThis: null,
    URL,
    location: { pathname: "/search/AI", href: "https://www.douyin.com/search/AI" }
  };
  context.globalThis = context;
  vm.runInNewContext(metrics, context);
  vm.runInNewContext(source, context);
  return context.AIPPlatformTesting;
}

test("X 帖子串只合并同作者的明确回复并排除纯转发", () => {
  const { mergeXThreads } = testingHooks();
  const posts = [
    { id: "root", handle: "@a", text: "首帖", referencedPostIds: [] },
    { id: "child", handle: "@a", text: "续帖", isReply: true, referencedPostIds: ["root"] },
    { id: "quote", handle: "@a", text: "自引述", isReply: false, referencedPostIds: ["root"] },
    { id: "repost", handle: "@b", text: "转发", isRepost: true, referencedPostIds: [] }
  ];
  const result = mergeXThreads(posts);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "首帖\n\n续帖");
  assert.equal(result[0].threadItems.length, 1);
  assert.equal(result[1].id, "quote");
});

test("X 粉丝数优先读取主页链接，并在链接缺失时使用页面文本", () => {
  const { xFollowers } = testingHooks();
  assert.equal(xFollowers("4.2M Followers", ""), 4_200_000);
  assert.equal(xFollowers("", "OpenAI 4.2M Followers Joined 2015"), 4_200_000);
  assert.equal(xFollowers("1.8万 关注者", ""), 18_000);
});

test("X 采集兼容新版推文节点和旧 Twitter 链接", () => {
  const { xStatusLink } = testingHooks();
  const link = { href: "https://twitter.com/example/status/123456789" };
  const article = {
    querySelector: selector => selector === "time" ? null : null,
    querySelectorAll: selector => selector.includes("/status/") ? [link] : []
  };
  assert.equal(xStatusLink(article), link.href);
  const source = readFileSync(new URL("../extension/platforms.js", import.meta.url), "utf8");
  assert.match(source, /article\[data-testid="tweet"\], article, \[data-testid="tweet"\]/);
});

test("抖音适配器包含列表、视频详情和图文详情入口", () => {
  const source = readFileSync(new URL("../extension/platforms.js", import.meta.url), "utf8");
  assert.match(source, /a\[href\*="\/video\/"\]/);
  assert.match(source, /a\[href\*="\/note\/"\]/);
  assert.match(source, /function douyinDetail\(\)/);
  assert.match(source, /script#RENDER_DATA/);
  assert.match(source, /modal_id/);
  assert.match(source, /publishedAt/);
  assert.match(source, /mediaType: match\[1\] === "note" \? "image" : "video"/);
});

test("抖音内嵌状态可以提取作品、作者、时间和公开指标", () => {
  const { extractAwemePosts } = testingHooks();
  const [post] = extractAwemePosts({ data: { aweme_list: [{
    aweme_id: "123456", desc: "AI 工作流实测", create_time: 1785556800, aweme_type: 0,
    author: { unique_id: "maker", nickname: "Maker" },
    statistics: { digg_count: 12, comment_count: 3, share_count: 2, play_count: 99 },
    video: { cover: { url_list: ["https://example.com/cover.jpg"] } }
  }] } });
  assert.equal(post.id, "123456");
  assert.equal(post.handle, "maker");
  assert.equal(post.likes, 12);
  assert.equal(post.replies, 3);
  assert.equal(post.reposts, 2);
  assert.equal(post.views, 99);
  assert.equal(post.mediaType, "video");
  assert.match(post.url, /\/video\/123456$/);
  assert.ok(post.publishedAt);
});

test("抖音普通作品节点和弹窗链接都能生成稳定作品地址", () => {
  const { douyinCandidateIdentity } = testingHooks();
  assert.deepEqual(
    { ...douyinCandidateIdentity({ dataAwemeId: "1001" }) },
    { id: "1001", type: "video", url: "https://www.douyin.com/video/1001" }
  );
  assert.deepEqual(
    { ...douyinCandidateIdentity({ href: "https://www.douyin.com/jingxuan?modal_id=1002", awemeType: "68" }) },
    { id: "1002", type: "note", url: "https://www.douyin.com/note/1002" }
  );
});

test("抖音 URI 编码渲染数据可以解析作品", () => {
  const { parseDouyinStateText } = testingHooks();
  const encoded = encodeURIComponent(JSON.stringify({ aweme_list: [{
    aweme_id: "1003", desc: "编码状态作品", author: { nickname: "作者" }, statistics: {}
  }] }));
  const [post] = parseDouyinStateText(encoded);
  assert.equal(post.id, "1003");
  assert.equal(post.text, "编码状态作品");
});

test("抖音普通 data-aweme-id 节点无需链接也能解析", () => {
  const { douyinCard } = testingHooks();
  const node = {
    textContent: "AI 视频作品",
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: name => name === "data-aweme-id" ? "1004" : null,
    closest: selector => selector === "[data-aweme-id]" ? node : null
  };
  const post = douyinCard(node);
  assert.equal(post.id, "1004");
  assert.equal(post.text, "AI 视频作品");
  assert.equal(post.url, "https://www.douyin.com/video/1004");
});
