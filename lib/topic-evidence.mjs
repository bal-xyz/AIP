const HEAT_RANK = { "爆发": 4, "升温": 3, "普通": 2, "冷却": 1 };

function cleanHandle(value = "") {
  return String(value).trim().replace(/^@/, "");
}

export function xProfileUrl(handle = "") {
  const username = cleanHandle(handle);
  return username ? `https://x.com/${encodeURIComponent(username)}` : "https://x.com";
}

export function buildTopicCreatorEvidence(keyword, posts = [], followedCreators = []) {
  const sourceIds = new Set(keyword?.sourcePostIds || []);
  const followed = new Set(followedCreators.map(item => String(item.handle || "").toLowerCase()));
  const groups = new Map();

  for (const post of posts) {
    if (!sourceIds.has(post.id)) continue;
    const handle = String(post.handle || post.author || "unknown");
    const key = handle.toLowerCase();
    const entry = groups.get(key) || {
      handle,
      displayName: post.author || handle,
      postIds: [],
      firstSeenAt: post.publishedAt || post.capturedAt,
      lastSeenAt: post.publishedAt || post.capturedAt,
      maxHeat: "普通",
      maxScore: 0,
      followed: followed.has(key),
      xProfileUrl: xProfileUrl(handle)
    };
    entry.postIds.push(post.id);
    const postTime = post.publishedAt || post.capturedAt;
    if (Date.parse(postTime) < Date.parse(entry.firstSeenAt)) entry.firstSeenAt = postTime;
    if (Date.parse(postTime) > Date.parse(entry.lastSeenAt)) entry.lastSeenAt = postTime;
    const level = post.analysis?.level || "普通";
    if ((HEAT_RANK[level] || 0) > (HEAT_RANK[entry.maxHeat] || 0)) entry.maxHeat = level;
    entry.maxScore = Math.max(entry.maxScore, Number(post.analysis?.score || 0));
    groups.set(key, entry);
  }

  const entries = [...groups.values()].map(entry => {
    const early = Date.parse(entry.firstSeenAt) === Math.min(...[...groups.values()].map(item => Date.parse(item.firstSeenAt)));
    const role = entry.postIds.length >= 3
      ? "持续跟进"
      : entry.maxHeat === "爆发"
        ? "传播节点"
        : early
          ? "早期发现"
          : entry.maxScore >= 70
            ? "深度解读"
            : "讨论跟进";
    return { ...entry, role };
  });

  return entries.sort((a, b) =>
    Number(b.followed) - Number(a.followed) ||
    b.postIds.length - a.postIds.length ||
    (HEAT_RANK[b.maxHeat] || 0) - (HEAT_RANK[a.maxHeat] || 0) ||
    b.maxScore - a.maxScore
  );
}

export function buildFollowedCreatorSummaries(posts = [], creators = []) {
  return creators.map(creator => {
    const creatorPosts = posts
      .filter(post => String(post.handle || "").toLowerCase() === String(creator.handle || "").toLowerCase())
      .sort((a, b) => Date.parse(b.publishedAt || b.capturedAt) - Date.parse(a.publishedAt || a.capturedAt));
    const hotPosts = creatorPosts.filter(post => ["升温", "爆发"].includes(post.analysis?.level));
    return {
      ...creator,
      posts: creatorPosts,
      postCount: creatorPosts.length,
      hotCount: hotPosts.length,
      burstCount: hotPosts.filter(post => post.analysis?.level === "爆发").length,
      latestAt: creatorPosts[0]?.publishedAt || creatorPosts[0]?.capturedAt || null,
      xProfileUrl: xProfileUrl(creator.handle)
    };
  }).sort((a, b) => Date.parse(b.latestAt || 0) - Date.parse(a.latestAt || 0));
}
