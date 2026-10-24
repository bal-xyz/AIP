(function (scope) {
  const { parseMetric, parseNamedMetric } = scope.AIPMetrics;

  function textOf(node) {
    return String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function xFollowers(linkText, bodyText) {
    return parseNamedMetric(linkText, ["followers", "follower", "粉丝", "关注者"]) ||
      parseNamedMetric(bodyText, ["followers", "follower", "粉丝", "关注者"]) || null;
  }

  function xMetric(article, testId, fallbackWord) {
    const element = article.querySelector(`[data-testid="${testId}"]`);
    if (element) {
      const raw = element.getAttribute("aria-label") || element.textContent || "";
      return /\d/.test(raw) ? parseMetric(raw) : null;
    }
    const candidate = [...article.querySelectorAll("[aria-label]")].find(node => (node.getAttribute("aria-label") || "").toLowerCase().includes(fallbackWord));
    const raw = candidate?.getAttribute("aria-label") || "";
    return /\d/.test(raw) ? parseMetric(raw) : null;
  }

  function xStatusLink(article) {
    const timestampLink = article.querySelector("time")?.closest('a[href*="/status/"]')?.href;
    return timestampLink || [...article.querySelectorAll('a[href*="/status/"]')]
      .map(node => node.href || node.getAttribute("href") || "")
      .find(href => /(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(href)) || "";
  }

  function scrapeXArticle(article) {
    const textNode = article.querySelector('[data-testid="tweetText"], [data-testid="tweetText"] [dir="auto"], div[lang]');
    const url = xStatusLink(article);
    const id = url.match(/\/status\/(\d+)/)?.[1];
    if (!textNode || !id) return null;
    const handle = url.match(/(?:x\.com|twitter\.com)\/([^/]+)\/status/i)?.[1];
    const time = article.querySelector("time");
    const images = [...article.querySelectorAll('img[src*="pbs.twimg.com/media"]')];
    const video = article.querySelector("video");
    const viewsNode = article.querySelector('a[href$="/analytics"]') || [...article.querySelectorAll("[aria-label]")].find(node => /views?|查看|次观看/i.test(node.getAttribute("aria-label") || ""));
    const bookmarkNode = [...article.querySelectorAll("button")].find(node => /bookmark|书签|收藏/i.test(node.getAttribute("aria-label") || ""));
    const bookmarkLabel = bookmarkNode?.getAttribute("aria-label") || "";
    const bookmarkCount = parseNamedMetric(bookmarkLabel, ["bookmarks", "bookmark", "书签", "收藏"]);
    const baseStatusUrl = url.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i)?.[0] || url;
    const referencedPostUrls = unique(
      [...article.querySelectorAll('a[href*="/status/"]')]
        .map(node => (node.href || node.getAttribute("href") || "").match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i)?.[0])
        .filter(candidate => candidate && candidate !== baseStatusUrl)
    );
    const externalUrls = unique(
      [...textNode.querySelectorAll("a[href]")]
        .map(node => node.getAttribute("data-expanded-url") || node.href)
        .filter(href => /^https?:/i.test(href) && !/(?:x\.com|twitter\.com)\/[^/]+\/status\//i.test(href))
    );
    const socialContext = textOf(article.querySelector('[data-testid="socialContext"]'));
    const replyContext = textOf(article).match(/Replying to|回复\s*@/i);
    return {
      id,
      platform: "x",
      handle: handle ? `@${handle}` : "",
      author: article.querySelector('[data-testid="User-Name"]')?.textContent?.split("@")[0]?.trim() || handle || "",
      text: textNode.innerText.trim(),
      url,
      publishedAt: time?.dateTime || null,
      age: time?.textContent || "",
      replies: xMetric(article, "reply", "repl"),
      reposts: xMetric(article, "retweet", "repost"),
      likes: xMetric(article, "like", "like"),
      bookmarks: bookmarkCount,
      bookmarksAvailable: Boolean(bookmarkLabel && /\d/.test(bookmarkLabel)),
      views: viewsNode ? (parseNamedMetric(viewsNode.getAttribute("aria-label"), ["views", "view", "次观看", "查看"]) || parseMetric(viewsNode.getAttribute("aria-label") || viewsNode.textContent)) : null,
      mediaType: video ? "video" : images.length ? "image" : "none",
      mediaCount: video ? 1 : images.length,
      mediaUrls: unique([...images.map(image => image.src), video?.poster]),
      hasLink: externalUrls.length > 0,
      externalUrls,
      referencedPostUrls,
      referencedPostIds: referencedPostUrls.map(value => value.match(/\/status\/(\d+)/)?.[1]).filter(Boolean),
      isRepost: /reposted|转发了/i.test(socialContext),
      isReply: Boolean(replyContext)
    };
  }

  function mergeXThreads(posts) {
    const byId = new Map(posts.map(post => [String(post.id), post]));
    const children = new Set();
    for (const post of posts) {
      if (!post.isReply) continue;
      const parent = (post.referencedPostIds || []).map(id => byId.get(String(id))).find(candidate => candidate && candidate.handle === post.handle);
      if (!parent) continue;
      parent.threadItems ||= [];
      parent.threadItems.push({ id: post.id, text: post.text, url: post.url, publishedAt: post.publishedAt, metrics: {
        likes: post.likes, replies: post.replies, reposts: post.reposts, views: post.views
      } });
      parent.text = `${parent.text}\n\n${post.text}`.trim();
      children.add(String(post.id));
    }
    return posts.filter(post => !children.has(String(post.id)) && !post.isRepost && !post.isReply);
  }

  function douyinProfile() {
    const body = textOf(document.body);
    const followers = parseNamedMetric(body, ["粉丝", "followers", "follower"]);
    const title = document.querySelector("h1") || document.querySelector('[data-e2e="user-title"]');
    const handle = location.pathname.match(/\/user\/([^/?#]+)/)?.[1] || "";
    return {
      displayName: textOf(title) || document.title.split("-")[0].trim(),
      followers: followers || null,
      platformAuthorId: handle,
      profileUrl: location.href
    };
  }

  function awemeRecordToPost(record) {
    const id = String(record?.aweme_id || record?.awemeId || "").trim();
    const text = String(record?.desc || record?.description || record?.item_title || "").trim();
    if (!id || !text) return null;
    const author = record.author || {};
    const statistics = record.statistics || record.stats || {};
    const images = (record.images || record.image_list || [])
      .map(item => item?.url_list?.[0] || item?.url || item?.uri)
      .filter(Boolean);
    const cover = record.video?.cover?.url_list?.[0] || record.video?.origin_cover?.url_list?.[0] || images[0] || null;
    const created = Number(record.create_time || record.createTime || 0);
    const imagePost = images.length > 0 || Number(record.aweme_type) === 68;
    return {
      id, platform: "douyin",
      handle: String(author.unique_id || author.short_id || author.sec_uid || ""),
      author: String(author.nickname || author.name || ""),
      text: text.slice(0, 1200),
      url: `https://www.douyin.com/${imagePost ? "note" : "video"}/${id}`,
      publishedAt: created > 0 ? new Date(created * 1000).toISOString() : null,
      age: "",
      replies: Number.isFinite(Number(statistics.comment_count)) ? Number(statistics.comment_count) : null,
      reposts: Number.isFinite(Number(statistics.share_count)) ? Number(statistics.share_count) : null,
      likes: Number.isFinite(Number(statistics.digg_count)) ? Number(statistics.digg_count) : null,
      bookmarks: null, bookmarksAvailable: false,
      views: Number.isFinite(Number(statistics.play_count)) ? Number(statistics.play_count) : null,
      mediaType: imagePost ? "image" : "video", mediaCount: imagePost ? Math.max(1, images.length) : 1,
      mediaUrls: cover ? [cover] : [], hasLink: false, externalUrls: [], referencedPostUrls: [], referencedPostIds: []
    };
  }

  function extractAwemePosts(root, limit = 20) {
    const posts = new Map();
    const seen = new Set();
    const stack = [root];
    let visited = 0;
    while (stack.length && posts.size < limit && visited < 50_000) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      const post = awemeRecordToPost(value);
      if (post) posts.set(post.id, post);
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        if (child && typeof child === "object") stack.push(child);
      }
    }
    return [...posts.values()];
  }

  function parseDouyinStateText(value, limit = 20) {
    let text = String(value || "").trim();
    if (!text) return [];
    try {
      if (text.startsWith("%7B") || text.startsWith("%5B")) text = decodeURIComponent(text);
      return extractAwemePosts(JSON.parse(text), limit);
    } catch {
      return [];
    }
  }

  function douyinCandidateIdentity({ href = "", dataAwemeId = "", ancestorAwemeId = "", awemeType = "" } = {}) {
    const pathMatch = String(href).match(/\/(video|note)\/(\d+)/);
    let modalId = "";
    try { modalId = new URL(String(href), "https://www.douyin.com/").searchParams.get("modal_id") || ""; } catch {}
    const id = String(pathMatch?.[2] || modalId || dataAwemeId || ancestorAwemeId || "").trim();
    if (!id) return null;
    const type = pathMatch?.[1] || (String(awemeType) === "68" ? "note" : "video");
    return { id, type, url: `https://www.douyin.com/${type}/${id}` };
  }

  function douyinEmbeddedPosts(limit = 20) {
    const posts = new Map();
    for (const script of document.querySelectorAll('script[type="application/json"], script#RENDER_DATA')) {
      for (const post of parseDouyinStateText(script.textContent, limit)) posts.set(post.id, post);
      if (posts.size >= limit) break;
    }
    return [...posts.values()].slice(0, limit);
  }

  function douyinCard(node) {
    const link = node.matches?.("a[href]") ? node : node.querySelector?.("a[href]");
    const identity = douyinCandidateIdentity({
      href: link?.href || "",
      dataAwemeId: node.getAttribute?.("data-aweme-id") || "",
      ancestorAwemeId: node.closest?.("[data-aweme-id]")?.getAttribute("data-aweme-id") || "",
      awemeType: node.getAttribute?.("data-aweme-type") || node.closest?.("[data-aweme-type]")?.getAttribute("data-aweme-type") || ""
    });
    if (!identity) return null;
    const container = node.closest?.("li, article, [data-e2e], div[class]") || node;
    const raw = textOf(container);
    const image = container.querySelector("img");
    const authorLink = container.querySelector('a[href*="/user/"]');
    const handle = authorLink?.href.match(/\/user\/([^/?#]+)/)?.[1] || location.pathname.match(/\/user\/([^/?#]+)/)?.[1] || "";
    const labels = [...container.querySelectorAll("[aria-label], [title]")]
      .map(node => `${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`)
      .join(" ");
    const metricText = `${labels} ${raw}`;
    const likes = /(?:点赞|赞|likes?|like)\D{0,8}\d|\d[^\n]{0,8}(?:点赞|赞|likes?|like)/iu.test(metricText)
      ? parseNamedMetric(metricText, ["点赞", "赞", "likes", "like"])
      : null;
    const comments = parseNamedMetric(`${labels} ${raw}`, ["评论", "comments", "comment"]);
    const shares = parseNamedMetric(`${labels} ${raw}`, ["分享", "转发", "shares", "share"]);
    const text = link?.getAttribute("title") || image?.alt || raw.replace(/[\d.]+\s*[万亿]?\s*(?:点赞|赞|评论|分享).*/u, "").trim();
    if (!text) return null;
    return {
      id: identity.id,
      platform: "douyin",
      handle,
      author: textOf(authorLink) || handle,
      text: text.slice(0, 1200),
      url: identity.url,
      publishedAt: null,
      age: "",
      replies: comments || null,
      reposts: shares || null,
      likes: likes || null,
      bookmarks: null,
      bookmarksAvailable: false,
      views: null,
      mediaType: identity.type === "note" ? "image" : "video",
      mediaCount: 1,
      mediaUrls: image?.src ? [image.src] : [],
      hasLink: false,
      externalUrls: [],
      referencedPostUrls: [],
      referencedPostIds: []
    };
  }

  function douyinDetail() {
    const match = location.href.match(/\/(video|note)\/(\d+)/);
    if (!match) return null;
    const body = textOf(document.body);
    const description = document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      textOf(document.querySelector('[data-e2e="video-desc"], [data-e2e="note-desc"], h1'));
    const authorLink = document.querySelector('a[href*="/user/"]');
    const timeNode = document.querySelector("time, [data-e2e*=time], [class*=time]");
    const timeText = timeNode?.dateTime || timeNode?.getAttribute?.("datetime") || textOf(timeNode);
    const publishedAt = timeText && !Number.isNaN(Date.parse(timeText)) ? new Date(timeText).toISOString() : null;
    const image = document.querySelector('meta[property="og:image"]')?.content || document.querySelector("img")?.src || null;
    return {
      id: match[2], platform: "douyin",
      handle: authorLink?.href.match(/\/user\/([^/?#]+)/)?.[1] || "",
      author: textOf(authorLink), text: String(description || document.title).slice(0, 1200),
      url: location.href, publishedAt, age: timeText || "",
      replies: parseNamedMetric(body, ["评论", "comments", "comment"]),
      reposts: parseNamedMetric(body, ["分享", "转发", "shares", "share"]),
      likes: parseNamedMetric(body, ["点赞", "赞", "likes", "like"]),
      bookmarks: null, bookmarksAvailable: false, views: null,
      mediaType: match[1] === "note" ? "image" : "video", mediaCount: 1,
      mediaUrls: image ? [image] : [], hasLink: false, externalUrls: [], referencedPostUrls: [], referencedPostIds: []
    };
  }

  async function scrollCollect(selector, scraper, limit = 30) {
    const all = new Map();
    for (let page = 0; page < 5; page += 1) {
      for (const node of document.querySelectorAll(selector)) {
        const post = scraper(node);
        if (post) all.set(`${post.platform}:${post.id}`, post);
      }
      if (all.size >= limit) break;
      window.scrollBy({ top: Math.max(window.innerHeight * 1.8, 1100), behavior: "instant" });
      await new Promise(resolve => setTimeout(resolve, 1400));
    }
    return [...all.values()].slice(0, limit);
  }

  function xFollowingProfiles() {
    return unique([...document.querySelectorAll('[data-testid="UserCell"] a[href^="/"]')]
      .map(link => link.getAttribute("href")?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1])
      .filter(handle => handle && !["home", "explore", "notifications", "messages", "settings"].includes(handle.toLowerCase())))
      .map(handle => ({ platformAuthorId: handle, handle: `@${handle}`, profileUrl: `https://x.com/${handle}` }));
  }

  function douyinFollowingProfiles() {
    const profiles = new Map();
    for (const link of document.querySelectorAll('a[href*="/user/"]')) {
      const platformAuthorId = link.href.match(/\/user\/([^/?#]+)/)?.[1];
      if (!platformAuthorId) continue;
      profiles.set(platformAuthorId, {
        platformAuthorId,
        handle: platformAuthorId,
        displayName: textOf(link) || null,
        profileUrl: link.href
      });
    }
    return [...profiles.values()];
  }

  const adapters = {
    x: {
      authenticated() {
        return !(/\/i\/flow\/login|\/login/.test(location.pathname) || document.body.innerText.includes("Sign in to X"));
      },
      async collect(job = {}) {
        if (job.targetType === "following_import") return { profile: {}, posts: [], following: xFollowingProfiles() };
        const collected = await scrollCollect('article[data-testid="tweet"], article, [data-testid="tweet"]', scrapeXArticle, Number(job.limit || 20));
        const cutoff = job.backfillDays ? Date.now() - Number(job.backfillDays) * 86_400_000 : null;
        const posts = mergeXThreads(collected).filter(post => !cutoff || (Number.isFinite(Date.parse(post.publishedAt)) && Date.parse(post.publishedAt) >= cutoff));
        const titleName = document.title.match(/^(.*?)\s+\(@[^)]+\)\s*\/\s*X$/)?.[1]?.trim();
        const displayName = titleName || document.querySelector('[data-testid="UserName"]')?.textContent?.split("@")[0]?.trim() || "";
        const followersText = [...document.querySelectorAll('a[href$="/verified_followers"], a[href$="/followers"]')].map(textOf).join(" ");
        return { profile: { displayName, followers: xFollowers(followersText, textOf(document.body)), profileUrl: location.href }, posts };
      }
    },
    douyin: {
      authenticated() {
        return !/\/login/.test(location.pathname) && !/登录后即可/.test(textOf(document.body));
      },
      async collect(job = {}) {
        if (job.targetType === "following_import") return { profile: douyinProfile(), posts: [], following: douyinFollowingProfiles() };
        const detail = douyinDetail();
        const limit = Number(job.limit || 20);
        const embedded = detail ? [] : douyinEmbeddedPosts(limit);
        const posts = detail ? [detail] : embedded.length ? embedded : await scrollCollect('a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="], [data-aweme-id]', douyinCard, limit);
        return { profile: douyinProfile(), posts };
      }
    }
  };

  scope.AIPPlatforms = {
    current() {
      if (/^https?:\/\/(?:www\.)?douyin\.com$/i.test(location.origin)) return { id: "douyin", ...adapters.douyin };
      return { id: "x", ...adapters.x };
    }
  };
  scope.AIPPlatformTesting = { mergeXThreads, xFollowers, xStatusLink, scrapeXArticle, extractAwemePosts, parseDouyinStateText, douyinCandidateIdentity, douyinCard };
})(globalThis);
