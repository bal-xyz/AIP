import { extractChangeCandidates, extractTopicCandidates } from "./trending.mjs";

const HEAT_RANK = { "爆发": 4, "升温": 3, "普通": 2, "冷却": 1 };
const TEXT_DIRECTION_RULES = [
  ["Agent Skill 实践", /(?:agent.{0,24}skills?|skills?.{0,24}agent|skill\.md|技能包)/i],
  ["OpenClaw 生态", /openclaw|clawbot|龙虾/i],
  ["AI 图像生成", /seedream|gpt image|nano banana|图像模型|生图|图片生成/i],
  ["AI 视频生成", /seedance|higgsfield|视频生成|ai视频|漫剧/i],
  ["Codex 工作流", /codex/i],
  ["Claude Code 工作流", /claude code/i],
  ["MCP 生态", /\bmcp\b|model context protocol/i],
  ["Vibe Coding", /vibe[\s-]?coding|氛围编程/i],
  ["Prompt 工程", /\bprompts?\b|提示词/i],
  ["Agent 工作流", /\bagents?\b|智能体|任务代理/i],
  ["AI 开源项目", /(?:github|开源).{0,40}(?:ai|agent|模型|skill)|(?:ai|agent|模型|skill).{0,40}(?:github|开源)/i]
];

function handleKey(value = "") {
  return String(value).trim().replace(/^@/, "").toLowerCase();
}

function topicKey(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\-]+/g, "")
    .replace(/智能体/g, "agent")
    .replace(/人工智能/g, "ai");
}

function publicInteractions(post) {
  return ["views", "likes", "replies", "reposts", "bookmarks"]
    .reduce((sum, key) => sum + Math.max(0, Number(post?.[key] || 0)), 0);
}

function directionTerms(post) {
  const text = String(post.text || "");
  const explicit = TEXT_DIRECTION_RULES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const changes = extractChangeCandidates(post).map(item => item.normalizedText);
  const extracted = extractTopicCandidates(post);
  const semanticTopics = extracted.filter(item => item.kind !== "entity").map(item => item.normalizedText);
  const stored = (post.topics || []).map(String).filter(Boolean);
  const entities = extracted.filter(item => item.kind === "entity").map(item => item.normalizedText);
  const preferred = [...changes, ...semanticTopics, ...explicit];
  return [...new Set(preferred.length ? [...preferred, ...stored] : [...stored, ...entities])];
}

function heatScore(entry) {
  if (!entry?.posts?.length) return 0;
  const scores = entry.posts.map(post => Number(post.analysis?.score || 0));
  const maxScore = Math.max(...scores);
  const averageScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const interaction = entry.posts.reduce((sum, post) => sum + publicInteractions(post), 0);
  const coverage = Math.min(100, entry.posts.length * 18 + entry.handles.size * 12);
  return Math.min(100, Math.round(
    maxScore * .38 +
    averageScore * .22 +
    Math.min(100, Math.log10(interaction + 1) * 22) * .25 +
    coverage * .15
  ));
}

function buildTopicIndex(posts = []) {
  const index = new Map();
  for (const post of posts) {
    const topics = directionTerms(post);
    for (const topic of topics) {
      const key = topicKey(topic);
      if (!key) continue;
      const entry = index.get(key) || {
        key,
        label: topic,
        posts: [],
        postIds: new Set(),
        handles: new Set(),
        engagedPostCount: 0,
        hottestLevel: "普通"
      };
      if (!entry.postIds.has(post.id)) {
        entry.posts.push(post);
        entry.postIds.add(post.id);
        entry.handles.add(handleKey(post.handle || post.author));
        if (publicInteractions(post) > 0) entry.engagedPostCount += 1;
      }
      if ((HEAT_RANK[post.analysis?.level] || 0) > (HEAT_RANK[entry.hottestLevel] || 0)) {
        entry.hottestLevel = post.analysis?.level || "普通";
      }
      index.set(key, entry);
    }
  }
  return index;
}

export function buildCreatorProfiles(posts = [], creators = []) {
  const topicIndex = buildTopicIndex(posts);
  return creators.map(creator => {
    const creatorHandle = handleKey(creator.handle);
    const creatorPosts = posts
      .filter(post => handleKey(post.handle || post.author) === creatorHandle)
      .sort((a, b) => Date.parse(b.publishedAt || b.capturedAt || 0) - Date.parse(a.publishedAt || a.capturedAt || 0));
    const ownTopics = new Map();

    for (const post of creatorPosts) {
      for (const topic of directionTerms(post)) {
        const key = topicKey(topic);
        if (!key) continue;
        const item = ownTopics.get(key) || { key, label: topic, posts: [] };
        item.posts.push(post);
        ownTopics.set(key, item);
      }
    }

    const directions = [...ownTopics.values()].map(item => {
      const global = topicIndex.get(item.key);
      const externalCreatorCount = Math.max(0, (global?.handles.size || 0) - Number(global?.handles.has(creatorHandle)));
      const externalPostCount = (global?.posts || []).filter(post => handleKey(post.handle || post.author) !== creatorHandle).length;
      const verified = (global?.posts.length || 0) >= 3 &&
        (global?.handles.size || 0) >= 2 &&
        (global?.engagedPostCount || 0) > 0;
      return {
        key: item.key,
        label: global?.label || item.label,
        score: heatScore(global),
        ownPostCount: item.posts.length,
        totalPostCount: global?.posts.length || item.posts.length,
        creatorCount: global?.handles.size || 1,
        externalCreatorCount,
        externalPostCount,
        verified,
        status: verified ? "cross_verified" : externalCreatorCount > 0 ? "corroborating" : "candidate",
        hottestLevel: global?.hottestLevel || "普通"
      };
    }).sort((a, b) =>
      Number(b.verified) - Number(a.verified) ||
      b.score - a.score ||
      b.externalCreatorCount - a.externalCreatorCount ||
      b.ownPostCount - a.ownPostCount
    );

    const primaryDirection = directions[0] || null;
    const ownHeat = creatorPosts.length
      ? Math.max(...creatorPosts.map(post => Number(post.analysis?.score || 0)))
      : 0;
    const profileHeat = primaryDirection
      ? Math.round(primaryDirection.score * .72 + ownHeat * .28)
      : 0;
    const hotPosts = creatorPosts.filter(post => ["升温", "爆发"].includes(post.analysis?.level));

    return {
      ...creator,
      posts: creatorPosts,
      postCount: creatorPosts.length,
      hotCount: hotPosts.length,
      burstCount: hotPosts.filter(post => post.analysis?.level === "爆发").length,
      latestAt: creatorPosts[0]?.publishedAt || creatorPosts[0]?.capturedAt || null,
      directions,
      primaryDirection,
      profileHeat,
      profileStatus: primaryDirection?.verified
        ? "verified"
        : creatorPosts.length
          ? "collecting"
          : "awaiting"
    };
  }).sort((a, b) =>
    Number(Boolean(b.primaryDirection?.verified)) - Number(Boolean(a.primaryDirection?.verified)) ||
    b.profileHeat - a.profileHeat ||
    b.hotCount - a.hotCount ||
    Number(b.followersApprox || 0) - Number(a.followersApprox || 0)
  );
}
