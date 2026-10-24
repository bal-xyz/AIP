import { aiIndustryPost } from "./heat-map.mjs";
import { extractChangeCandidates, extractTopicCandidates, detectPostLanguage, normalizeTerm } from "./trending.mjs";
import { buildContentOpportunities } from "./content-opportunities.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DISCOVERY_PREDICTION_HOURS = 72;
export const DISCOVERY_NEW_STAGE_HOURS = 24;
const DISCOVERY_PREDICTION_WINDOW = DISCOVERY_PREDICTION_HOURS * HOUR;
const DISCOVERY_NEW_STAGE_WINDOW = DISCOVERY_NEW_STAGE_HOURS * HOUR;
const SOURCE_FREQUENCIES = {
  official: 15,
  maintainer: 15,
  english_tester: 30,
  zh_relay: 60,
  peer: 60
};
const OFFICIAL_HANDLES = new Map([
  ["openai", "OpenAI"],
  ["anthropicai", "Anthropic"],
  ["claudeai", "Claude"],
  ["huggingface", "Hugging Face"],
  ["kimi_moonshot", "Kimi"],
  ["googledeepmind", "Google DeepMind"],
  ["googleai", "Google AI"],
  ["xai", "xAI"],
  ["mistralai", "Mistral AI"],
  ["aiatmeta", "Meta AI"],
  ["qwenlm", "Qwen"]
]);
const GENERIC_SUBJECTS = new Set([
  "AI", "人工智能", "模型", "大模型", "工具", "代码", "科技", "智能", "项目", "产品",
  "Agent", "AI Agent", "AI 智能体", "AI 行业", "开源 AI 生态", "AI 工作流"
]);
const MARKETING_PATTERN = /限时优惠|返佣|代理价|私信(?:购买|下单|报量)|稳赚|躺赚|割韭菜|加群|扫码|博彩|空投/iu;
const ACTION_RULES = [
  {
    key: "open_source",
    label: "开放开源",
    category: "事件与发布",
    pattern: /(?:宣布|预计|即将|将于|正式|已经|现已|今天|今日|今晚|本周).{0,24}开源|开源(?:了|代码|权重|仓库|版本)|开放(?:模型)?权重|open[- ]?sourced|open weights?|weights?.{0,18}(?:released|available)|source code.{0,18}(?:released|available)/iu
  },
  { key: "launch", label: "正式发布", category: "事件与发布", pattern: /(?:正式)?发布|推出|上线|\blaunch(?:ed)?\b|\brelease[ds]?\b|\bship(?:ped|s)?\b|\bnow available\b/iu },
  { key: "upgrade", label: "新增能力", category: "技术与能力", pattern: /新增|升级|更新|支持|接入|集成|改版|update[ds]?|adds?|supports?|integrat(?:e|es|ed)|introduc(?:e|es|ed)/iu },
  {
    key: "workflow",
    label: "扩展工作流",
    category: "应用场景",
    pattern: /(?:(?:发布|开源|新增|上线|接入|推出|更新|built|released|launched|added|integrated|shipped).{0,36}(?:workflow|工作流|skill|plugin|插件|mcp|自动化))|(?:(?:workflow|工作流|skill|plugin|插件|mcp|自动化).{0,28}(?:发布|开源|新增|上线|接入|推出|更新|built|released|launched|added|integrated|shipped))/iu
  },
  { key: "pricing", label: "调整价格", category: "行业趋势", pattern: /降价|免费|定价|价格|成本|price|pricing|cost|free tier/iu },
  { key: "benchmark", label: "出现实测", category: "行业趋势", pattern: /实测|测评|对比|跑分|benchmark|review|beats?|outperform/iu },
  { key: "sandbox_escape", label: "沙箱逃逸入侵", category: "争议与风险", pattern: /沙盒.{0,24}(?:突破|逃逸|入侵)|sandbox.{0,26}(?:escape|broke out|breach)|broke out of (?:its |the )?sandbox|breach(?:ed)? Hugging Face/iu },
  { key: "risk", label: "出现风险", category: "争议与风险", pattern: /漏洞|越狱|泄露|攻击|失控|封号|争议|risk|security|jailbreak|exploit|leak/iu }
];
const PROJECT_PATTERNS = [
  /名叫\s*([A-Za-z][A-Za-z0-9._-]{2,30})/iu,
  /([A-Za-z][A-Za-z0-9._-]{2,30})\s*(?:项目|工具|Skill|Plugin|插件|工作流)/iu,
  /(?:项目|工具|Skill|Plugin|插件)\s*(?:叫|名为|：|:)?\s*([A-Za-z][A-Za-z0-9._-]{2,30})/iu
];

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const timeOf = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const postTime = post => timeOf(post?.publishedAt || post?.capturedAt);
const handleKey = value => String(value || "").replace(/^@/, "").toLowerCase();
const sourceKey = (platform, handle) => `${platform || "x"}:${handleKey(handle)}`;
const sourceId = (platform, handle) => `source-${platform === "douyin" ? "douyin-" : ""}${slug(handleKey(handle))}`;
const unique = values => [...new Set(values.filter(Boolean).map(String))];
const slug = value => String(value || "")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 70);

function compactTitle(value, fallback = "AI 行业出现新变化") {
  const cleaned = String(value || "")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/[“”"'`#*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return [...cleaned].slice(0, 24).join("");
}

function sourceUrlEvidence(post) {
  const urls = unique([
    ...(post?.externalUrls || []),
    ...(post?.referencedPostUrls || []),
    post?.url,
    post?.sourceUrl
  ]);
  const primary = urls.filter(value =>
    /(?:github\.com|huggingface\.co|openai\.com|anthropic\.com|deepmind\.google|ai\.google|docs\.|developer\.|\/releases?\/)/iu.test(value)
  );
  return { urls, primary };
}

function publicInteractions(post) {
  return ["likes", "replies", "reposts", "bookmarks"]
    .reduce((sum, key) => sum + Math.max(0, Number(post?.[key]) || 0), 0);
}

function projectSubject(text) {
  for (const pattern of PROJECT_PATTERNS) {
    const value = text.match(pattern)?.[1];
    if (value && !/^(this|that|with|from|github|skill|plugin|agent)$/i.test(value)) return value;
  }
  return "";
}

function bestSubject(post, topics = []) {
  const entities = topics.filter(item => item.kind === "entity" && !GENERIC_SUBJECTS.has(item.normalizedText));
  const specific = entities.find(item => /\d|Code|Codex|Kimi|Claude|GPT|DeepSeek|Grok|Qwen|GLM|Open/iu.test(item.normalizedText));
  if (specific) return { text: specific.normalizedText, evidence: specific.originalText || specific.normalizedText };
  if (entities[0]) return { text: entities[0].normalizedText, evidence: entities[0].originalText || entities[0].normalizedText };
  const project = projectSubject(String(post?.text || ""));
  if (project) return { text: normalizeTerm(project), evidence: project };
  const topic = topics.find(item =>
    !GENERIC_SUBJECTS.has(item.normalizedText) &&
    item.normalizedText.length >= 3
  );
  return topic ? { text: topic.normalizedText, evidence: topic.originalText || topic.normalizedText } : null;
}

function genericCandidate(post) {
  const text = String(post?.text || "");
  const topics = extractTopicCandidates(post);
  const action = ACTION_RULES.map(rule => ({ rule, match: text.match(rule.pattern) })).find(item => item.match);
  if (!action) return null;
  const subjectOptions = [
    ...topics
      .filter(item => item.kind === "entity" && !GENERIC_SUBJECTS.has(item.normalizedText))
      .map(item => ({ text: item.normalizedText, evidence: item.originalText || item.normalizedText })),
    projectSubject(text) ? { text: normalizeTerm(projectSubject(text)), evidence: projectSubject(text) } : null,
    ...topics
      .filter(item => !GENERIC_SUBJECTS.has(item.normalizedText) && item.normalizedText.length >= 3)
      .map(item => ({ text: item.normalizedText, evidence: item.originalText || item.normalizedText }))
  ].filter(Boolean);
  const actionIndex = Number(action.match.index || 0);
  const subjectMatch = subjectOptions
    .map(item => {
      const index = text.toLowerCase().indexOf(String(item.evidence || item.text).toLowerCase());
      return { ...item, index, distance: index < 0 ? Infinity : Math.abs(index - actionIndex) };
    })
    .filter(item => item.distance <= 90)
    .sort((a, b) => a.distance - b.distance || a.index - b.index)[0] || bestSubject(post, topics);
  const subject = subjectMatch?.text || "";
  if (!subject || !action || GENERIC_SUBJECTS.has(subject)) return null;
  const confidence = Math.min(.94, Math.max(.78, Number(topics[0]?.confidence || .78)));
  return {
    sourcePostId: String(post.id),
    normalizedText: compactTitle(`${subject}${action.rule.label}`),
    subject,
    changeType: action.rule.key,
    changeSummary: compactTitle(`${subject}${action.rule.label}`),
    category: action.rule.category,
    confidence,
    originalText: text.slice(0, 240),
    extractionOrigin: "generic"
  };
}

export function extractEventCandidates(post) {
  const structured = extractChangeCandidates(post)
    .filter(item => item.confidence >= .75 && !GENERIC_SUBJECTS.has(item.subject))
    .map(item => ({
      ...item,
      sourcePostId: String(post.id),
      normalizedText: compactTitle(item.normalizedText),
      changeType: item.changeType || "change",
      extractionOrigin: (post.extractedChanges || []).some(value =>
        normalizeTerm(value.normalizedText) === normalizeTerm(item.normalizedText)
      ) ? "skill_structured" : "rule_structured"
    }));
  if (structured.length) return structured.slice(0, 2);
  const generic = genericCandidate(post);
  return generic ? [generic] : [];
}

function sourceTypeFor(post, registryByHandle, followedHandles) {
  const key = handleKey(post?.handle || post?.author);
  const identity = sourceKey(post?.platform || "x", key);
  const registered = registryByHandle.get(identity);
  if (registered) return registered.sourceType;
  if (OFFICIAL_HANDLES.has(key)) return "official";
  const text = String(post?.text || "");
  const sourceEvidence = sourceUrlEvidence(post);
  const speaksAsBuilder = /\b(?:I|we)\s+(?:built|made|launched|released|open[- ]?sourced|shipped)\b|我(?:们)?(?:做了|开发|发布|开源|上线)/iu.test(text);
  if (sourceEvidence.primary.length && speaksAsBuilder) return "maintainer";
  if (followedHandles.has(identity)) return "peer";
  return detectPostLanguage(text) === "en" ? "english_tester" : "zh_relay";
}

function semanticTokens(text, subject = "") {
  const stop = new Set([
    "about", "with", "from", "that", "this", "have", "will", "your", "into", "just",
    "发布", "开源", "模型", "工具", "人工", "智能", "关于", "一个", "这个", "已经", "现在",
    ...String(subject).toLowerCase().split(/\s+/)
  ]);
  const value = String(text || "").toLowerCase().replace(/https?:\/\/\S+/giu, " ");
  const latin = value.match(/[a-z][a-z0-9._-]{3,}/g) || [];
  const chineseRuns = value.match(/[\u3400-\u9fff]{2,}/g) || [];
  const chinese = chineseRuns.flatMap(run => {
    const chars = [...run];
    const tokens = [];
    for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars.slice(index, index + 2).join(""));
    return tokens;
  });
  return new Set([...latin, ...chinese].filter(token => !stop.has(token)));
}

function semanticSimilarity(a, b, subject) {
  const left = semanticTokens(a?.text, subject);
  const right = semanticTokens(b?.text, subject);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function largestCoherentGroup(posts, subject) {
  if (posts.length <= 1) return posts;
  const visited = new Set();
  const groups = [];
  for (let index = 0; index < posts.length; index += 1) {
    if (visited.has(index)) continue;
    const queue = [index];
    const group = [];
    visited.add(index);
    while (queue.length) {
      const current = queue.shift();
      group.push(posts[current]);
      for (let candidate = 0; candidate < posts.length; candidate += 1) {
        if (visited.has(candidate)) continue;
        if (semanticSimilarity(posts[current], posts[candidate], subject) < .18) continue;
        visited.add(candidate);
        queue.push(candidate);
      }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => {
    const creatorsA = unique(a.map(post => handleKey(post.handle || post.author))).length;
    const creatorsB = unique(b.map(post => handleKey(post.handle || post.author))).length;
    return creatorsB - creatorsA || b.length - a.length;
  })[0] || [];
}

function sourceCredibility(type, status = "candidate") {
  const base = {
    official: 100,
    maintainer: 90,
    english_tester: 68,
    zh_relay: 58,
    peer: 50
  }[type] || 45;
  if (status === "trusted") return Math.min(100, base + 15);
  if (status === "ignored") return 0;
  return base;
}

function snapshotIndex(snapshots = []) {
  const index = new Map();
  for (const snapshot of snapshots) {
    const key = String(snapshot.postId);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(snapshot);
  }
  for (const values of index.values()) values.sort((a, b) => timeOf(a.capturedAt) - timeOf(b.capturedAt));
  return index;
}

function heatProximity(post, postSnapshots = []) {
  if (postSnapshots.length < 2) return 0;
  const latest = postSnapshots.at(-1);
  const first = [...postSnapshots].reverse().find(item =>
    timeOf(latest?.capturedAt) - timeOf(item.capturedAt) >= 10 * 60_000
  );
  if (!first || !latest || first === latest) return 0;
  const hours = Math.max((timeOf(latest.capturedAt) - timeOf(first.capturedAt)) / HOUR, 1 / 6);
  const viewVelocity = Math.max(0, Number(latest.views || 0) - Number(first.views || 0)) / hours;
  const replyVelocity = Math.max(0, Number(latest.replies || 0) - Number(first.replies || 0)) / hours;
  const growthRatio = Number(first.views) > 0
    ? Math.max(0, Number(latest.views || 0) - Number(first.views || 0)) / Number(first.views)
    : 0;
  return clamp(Math.max(
    viewVelocity / 500,
    replyVelocity / 3,
    viewVelocity >= 100 ? growthRatio / .2 : 0
  ) * 100) / 100;
}

function momentumFor(posts, now) {
  const recent = posts.filter(post => now - postTime(post) <= 2 * HOUR).length;
  const baseline = posts.filter(post => {
    const age = now - postTime(post);
    return age > 2 * HOUR && age <= DAY;
  }).length;
  const recentRate = recent / 2;
  const baselineRate = baseline / 22;
  if (baselineRate) return Number((recentRate / baselineRate).toFixed(2));
  if (recent >= 3) return 4;
  if (recent) return 2;
  return 0;
}

function freshnessScore(lastSeenAt, now) {
  const age = Math.max(0, now - timeOf(lastSeenAt));
  if (age <= .5 * HOUR) return 100;
  if (age <= 2 * HOUR) return 82;
  if (age <= 6 * HOUR) return 60;
  if (age <= DAY) return 35;
  return 10;
}

function noveltyScore(firstSeenAt, prior) {
  if (!prior) return 100;
  const age = Math.max(0, timeOf(firstSeenAt) - timeOf(prior.firstSeenAt));
  if (age >= 7 * DAY) return 90;
  return prior.stage === "graduated" ? 25 : 55;
}

function sourceRoleLabel(type) {
  return {
    official: "官方源头",
    maintainer: "项目作者",
    english_tester: "英文首测",
    zh_relay: "中文首发",
    peer: "同行验证"
  }[type] || "来源待确认";
}

function recommendedAction(score, testability, sourceStrength, zhCreatorCount) {
  if (score >= 74 && testability >= 65 && sourceStrength >= 60) return "立即实测";
  if (score >= 62 && sourceStrength >= 55) return "快速跟进";
  if (score >= 42 || zhCreatorCount < 2) return "继续观察";
  return "忽略归档";
}

function opportunityFor(posts, sourceStrength, acceleration, zhCreatorCount) {
  const combinedText = posts.map(post => post.text || "").join(" ");
  const links = posts.flatMap(post => sourceUrlEvidence(post).primary);
  const testability = clamp(
    (/\b(?:github|npm|pip|api|demo|skill|plugin|workflow|open[- ]?source)\b|安装|开源|教程|工作流|插件|实测/iu.test(combinedText) ? 75 : 28) +
    (links.length ? 20 : 0)
  );
  const immediateUse = clamp(
    /工具|项目|教程|工作流|插件|API|代码|编程|自动化|demo|workflow|plugin|skill/iu.test(combinedText) ? 82 : 42
  );
  const chineseScarcity = zhCreatorCount === 0 ? 100 : zhCreatorCount === 1 ? 88 : zhCreatorCount === 2 ? 68 : zhCreatorCount <= 4 ? 42 : 12;
  const visualEvidence = clamp(posts.some(post => post.mediaType && post.mediaType !== "none") ? 95 : links.length ? 62 : 28);
  const score = clamp(
    testability * .25 +
    immediateUse * .2 +
    chineseScarcity * .2 +
    sourceStrength * .15 +
    acceleration * .1 +
    visualEvidence * .1
  );
  return {
    score,
    breakdown: { testability, immediateUse, chineseScarcity, sourceReliability: sourceStrength, earlyGrowth: acceleration, visualEvidence },
    recommendedAction: recommendedAction(score, testability, sourceStrength, zhCreatorCount)
  };
}

function reasonsFor(event) {
  const reasons = [];
  if (event.sourceRoles.includes("official")) reasons.push("官方直接发布，适合优先核验");
  else if (event.sourceRoles.includes("maintainer")) reasons.push("项目作者提供了可验证入口");
  else if (event.enCreatorCount && !event.zhCreatorCount) reasons.push(`${event.enCreatorCount} 位英文作者讨论，中文圈尚未跟进`);
  else if (event.enCreatorCount && event.zhCreatorCount) reasons.push(`海外信号已出现 ${event.zhCreatorCount} 位中文作者跟进`);
  if (event.momentumRatio >= 2) reasons.push(`最近 2 小时讨论速度达到基线 ${event.momentumRatio.toFixed(1)} 倍`);
  if (event.heatProximity >= .7 && event.stage !== "graduated") reasons.push(`已有帖子接近正式升温线的 ${Math.round(event.heatProximity * 100)}%`);
  if (event.creatorCount >= 3) reasons.push(`${event.creatorCount} 位独立作者开始扩散`);
  if (!reasons.length) reasons.push("来源可信但传播证据仍在积累");
  return reasons.slice(0, 3);
}

function testChecklist(event) {
  return {
    access: event.primaryUrls.length
      ? "优先从原始项目、官方文档或作者提供的入口安装与访问。"
      : "先确认正式访问入口，避免使用来源不明的镜像或安装包。",
    claim: `验证“${event.normalizedTitle}”所声称的具体变化是否真实可用。`,
    tasks: [
      "完成一次最小可用流程并记录成功条件。",
      "使用一个真实工作任务与现有方案进行对比。",
      "主动测试一个边界或失败场景，记录限制。"
    ],
    comparison: "与当前常用工具或该产品上一版本进行同任务对比。",
    evidence: ["保存原始来源链接", "保存关键步骤截图或录屏", "记录耗时、成本和失败结果"],
    risks: ["核对版本与发布时间", "区分官方能力与第三方封装", "未经实测不得写成确定性结论"]
  };
}

function eventViewMatches(event, view) {
  if (!view || view === "all") return true;
  if (view === "testable") return event.newcomerOpportunityScore >= 70 && Number(event.opportunityBreakdown?.testability || 0) >= 65;
  if (view === "zh_gap") return event.zhCreatorCount <= 1;
  if (view === "overseas") return event.enCreatorCount > 0 && event.zhCreatorCount === 0;
  return true;
}

function eventSort(a, b) {
  const stageRank = { graduated: 4, near_rising: 3, spreading: 2, new: 1, expired: 0 };
  return (stageRank[b.stage] || 0) - (stageRank[a.stage] || 0) ||
    b.earlySignalScore - a.earlySignalScore ||
    timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt);
}

export function ensureDiscoveryState(state) {
  state.earlyEvents ||= [];
  state.discoveryHistory ||= [];
  state.sourceRegistry ||= [];
  state.eventAudit ||= [];
  state.validationTasks ||= [];
  for (const source of state.sourceRegistry) source.platform ||= "x";
  const byHandle = new Map(state.sourceRegistry.map(item => [sourceKey(item.platform, item.handle), item]));
  for (const [handle, displayName] of OFFICIAL_HANDLES) {
    if (byHandle.has(sourceKey("x", handle))) continue;
    const source = {
      id: `source-${slug(handle)}`,
      platform: "x",
      handle: `@${handle}`,
      displayName,
      sourceType: "official",
      status: "trusted",
      verifiedSignalCount: 0,
      falseSignalCount: 0,
      averageLeadMinutes: null,
      lastSeenAt: null,
      verifiedEventIds: []
    };
    state.sourceRegistry.push(source);
    byHandle.set(sourceKey("x", handle), source);
  }
  for (const creator of state.creators || []) {
    const key = handleKey(creator.handle);
    const platform = creator.platform || "x";
    const identity = sourceKey(platform, key);
    if (!key || byHandle.has(identity)) continue;
    const source = {
      id: sourceId(platform, key),
      platform,
      handle: creator.handle,
      displayName: creator.displayName || creator.handle,
      sourceType: "peer",
      status: "candidate",
      verifiedSignalCount: 0,
      falseSignalCount: 0,
      averageLeadMinutes: null,
      lastSeenAt: null,
      verifiedEventIds: []
    };
    state.sourceRegistry.push(source);
    byHandle.set(identity, source);
  }
  return state;
}

export function buildDiscoveryEvents(posts = [], snapshots = [], options = {}) {
  const now = Number(options.now || Date.now());
  const cutoff = now - DISCOVERY_PREDICTION_WINDOW;
  const visibleCutoff = cutoff;
  const priorById = new Map((options.previousEvents || []).map(item => [String(item.id), item]));
  const sourceRegistry = options.sourceRegistry || [];
  const registryByHandle = new Map(sourceRegistry.map(item => [sourceKey(item.platform, item.handle), item]));
  const followedHandles = new Set((options.followedCreators || []).map(item => sourceKey(item.platform, item.handle)));
  const snapshotsByPost = snapshotIndex(snapshots);
  const opportunitySet = buildContentOpportunities(posts, snapshots, {
    window: "7d",
    sort: "latest",
    trendingKeywords: options.trendingKeywords || [],
    followedCreators: options.followedCreators || [],
    now
  });
  const heatByPost = new Map((opportunitySet.items || []).map(item => [String(item.postId), item.heatStatus]));
  const eligiblePosts = posts.filter(post =>
    post?.id &&
    postTime(post) >= cutoff &&
    postTime(post) <= now &&
    aiIndustryPost(post, options.trendingKeywords || []) &&
    Number(post?.analysis?.confidence || .75) >= .75 &&
    Boolean(post.url || post.sourceUrl) &&
    !MARKETING_PATTERN.test(String(post.text || ""))
  );
  const buckets = new Map();
  for (const post of eligiblePosts) {
    for (const candidate of extractEventCandidates(post)) {
      if (candidate.confidence < .75 || !candidate.subject || GENERIC_SUBJECTS.has(candidate.subject)) continue;
      const changeKey = candidate.extractionOrigin !== "generic"
        ? normalizeTerm(candidate.normalizedText).toLowerCase()
        : String(candidate.changeType || candidate.normalizedText).toLowerCase();
      const key = `${normalizeTerm(candidate.subject).toLowerCase()}::${changeKey}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          subject: normalizeTerm(candidate.subject),
          change: candidate.changeSummary || candidate.normalizedText,
          normalizedTitle: compactTitle(candidate.normalizedText),
          category: candidate.category || "事件与发布",
          candidates: [],
          posts: new Map()
        });
      }
      const bucket = buckets.get(key);
      bucket.candidates.push(candidate);
      bucket.posts.set(String(post.id), post);
    }
  }

  const events = [];
  for (const bucket of buckets.values()) {
    let matched = [...bucket.posts.values()].sort((a, b) => postTime(a) - postTime(b));
    const requiresCoherence = bucket.candidates.some(item => item.extractionOrigin !== "skill_structured");
    if (requiresCoherence) matched = largestCoherentGroup(matched, bucket.subject).sort((a, b) => postTime(a) - postTime(b));
    const matchedIds = new Set(matched.map(post => String(post.id)));
    const matchedCandidates = bucket.candidates.filter(item => matchedIds.has(String(item.sourcePostId)));
    const currentFirstSeenAt = matched[0]?.publishedAt || matched[0]?.capturedAt;
    const lastSeenAt = matched.at(-1)?.publishedAt || matched.at(-1)?.capturedAt;
    if (!currentFirstSeenAt) continue;
    const id = `event-${slug(`${bucket.subject}-${bucket.change}`)}`;
    const prior = priorById.get(id);
    const firstSeenAt = prior?.firstSeenAt && timeOf(prior.firstSeenAt) < timeOf(currentFirstSeenAt)
      ? prior.firstSeenAt
      : currentFirstSeenAt;
    if (timeOf(firstSeenAt) < visibleCutoff) continue;
    const creators = unique(matched.map(post => handleKey(post.handle || post.author)));
    const zhPosts = matched.filter(post => detectPostLanguage(post.text) === "zh");
    const enPosts = matched.filter(post => detectPostLanguage(post.text) === "en");
    const zhCreators = unique(zhPosts.map(post => handleKey(post.handle || post.author)));
    const enCreators = unique(enPosts.map(post => handleKey(post.handle || post.author)));
    const sourceTypes = matched.map(post => sourceTypeFor(post, registryByHandle, followedHandles));
    const sourceRoles = unique(sourceTypes);
    const primaryUrls = unique(matched.flatMap(post => sourceUrlEvidence(post).primary));
    const explicitReference = matched.some(post => (post.referencedPostIds || []).length || (post.referencedPostUrls || []).length);
    const earliest = matched[0];
    const earliestSourceType = sourceTypeFor(earliest, registryByHandle, followedHandles);
    const earliestRegistry = registryByHandle.get(sourceKey(earliest.platform, earliest.handle || earliest.author));
    const trustedPrimary = ["official", "maintainer"].includes(earliestSourceType) ||
      earliestRegistry?.status === "trusted" ||
      primaryUrls.length > 0;
    if (!trustedPrimary && creators.length < 2) continue;
    const averageConfidence = matchedCandidates.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, matchedCandidates.length);
    if (averageConfidence < .75) continue;
    if (prior?.trackingStatus === "ignored") continue;
    const momentumRatio = momentumFor(matched, now);
    const maxHeatProximity = Math.max(0, ...matched.map(post => heatProximity(post, snapshotsByPost.get(String(post.id)) || [])));
    const graduatedPost = matched.find(post => ["rising", "burst"].includes(heatByPost.get(String(post.id))));
    let stage = "new";
    if (graduatedPost) stage = "graduated";
    else if (creators.length >= 3 && (momentumRatio >= 2 || maxHeatProximity >= .7)) stage = "near_rising";
    else if (matched.length >= 3 && creators.length >= 2 && (momentumRatio >= 1.5 || (zhCreators.length && enCreators.length) || explicitReference)) stage = "spreading";

    const sourceStrength = clamp(Math.max(...matched.map((post, index) => {
      const type = sourceTypes[index];
      const registry = registryByHandle.get(sourceKey(post.platform, post.handle || post.author));
      return sourceCredibility(type, registry?.status);
    })));
    const scoreBreakdown = {
      sourceCredibility: sourceStrength,
      independentSpread: clamp(creators.length / 4 * 100),
      acceleration: clamp(momentumRatio / 4 * 100),
      novelty: noveltyScore(firstSeenAt, prior),
      crossLanguage: zhCreators.length && enCreators.length ? 100 : enCreators.length ? 72 : 46,
      freshness: freshnessScore(lastSeenAt, now)
    };
    const earlySignalScore = clamp(
      scoreBreakdown.sourceCredibility * .25 +
      scoreBreakdown.independentSpread * .25 +
      scoreBreakdown.acceleration * .2 +
      scoreBreakdown.novelty * .15 +
      scoreBreakdown.crossLanguage * .1 +
      scoreBreakdown.freshness * .05
    );
    if (earlySignalScore < 45 && stage !== "graduated") continue;
    const opportunity = opportunityFor(matched, sourceStrength, scoreBreakdown.acceleration, zhCreators.length);
    const graduatedAt = stage === "graduated"
      ? prior?.graduatedAt || opportunitySet.calculatedAt || new Date(now).toISOString()
      : null;
    const leadMinutes = graduatedAt ? Math.max(0, Math.round((timeOf(graduatedAt) - timeOf(firstSeenAt)) / 60_000)) : null;
    const ageHours = Math.max(0, (now - timeOf(firstSeenAt)) / HOUR);
    const canAutoTrack = earlySignalScore >= 60 && (trustedPrimary || creators.length >= 2) && ageHours < DISCOVERY_PREDICTION_HOURS && stage !== "graduated";
    const trackingStatus = prior?.trackingStatus === "manual"
      ? "manual"
      : stage === "graduated"
        ? "graduated"
        : canAutoTrack ? "auto" : prior?.trackingStatus || "none";
    const nextMinutes = ageHours < 6 ? 15 : 30;
    const event = {
      id,
      normalizedTitle: bucket.normalizedTitle,
      subject: bucket.subject,
      change: bucket.change,
      category: bucket.category,
      stage,
      predictionStatus: stage === "graduated" ? "hit" : "active",
      predictionExpiresAt: new Date(timeOf(firstSeenAt) + DISCOVERY_PREDICTION_WINDOW).toISOString(),
      earlySignalScore,
      scoreBreakdown,
      firstSeenAt,
      lastSeenAt,
      earliestPostId: String(earliest.id),
      earliestSource: prior?.earliestSource && timeOf(prior.firstSeenAt) <= timeOf(currentFirstSeenAt)
        ? prior.earliestSource
        : {
        postId: String(earliest.id),
        author: earliest.author || earliest.handle,
        handle: earliest.handle || "",
        sourceType: earliestSourceType,
        sourceLabel: sourceRoleLabel(earliestSourceType),
        trusted: trustedPrimary,
        url: earliest.url || earliest.sourceUrl || ""
      },
      sourcePostIds: matched.map(post => String(post.id)),
      sourceCount: matched.length,
      creatorCount: creators.length,
      zhPostCount: zhPosts.length,
      zhCreatorCount: zhCreators.length,
      enPostCount: enPosts.length,
      enCreatorCount: enCreators.length,
      sourceRoles,
      confidence: Number(averageConfidence.toFixed(2)),
      momentumRatio,
      heatProximity: Number(maxHeatProximity.toFixed(2)),
      newcomerOpportunityScore: opportunity.score,
      opportunityBreakdown: opportunity.breakdown,
      recommendedAction: opportunity.recommendedAction,
      opportunityReasons: [],
      trackingStatus,
      nextRecaptureAt: ["auto", "manual"].includes(trackingStatus)
        ? new Date(now + nextMinutes * 60_000).toISOString()
        : null,
      graduatedAt,
      leadMinutes,
      primaryUrls,
      explicitReference,
      postEvidence: matched.map(post => ({
        postId: String(post.id),
        platform: post.platform || "x",
        author: post.author || post.handle,
        handle: post.handle || "",
        text: post.text || "",
        language: detectPostLanguage(post.text),
        sourceType: sourceTypeFor(post, registryByHandle, followedHandles),
        publishedAt: post.publishedAt || post.capturedAt,
        views: Number(post.views) || 0,
        likes: Number(post.likes) || 0,
        replies: Number(post.replies) || 0,
        reposts: Number(post.reposts) || 0,
        url: post.url || post.sourceUrl || ""
      })),
      testChecklist: null,
      createdAt: prior?.createdAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
    event.opportunityReasons = reasonsFor(event);
    event.testChecklist = testChecklist(event);
    events.push(event);
  }

  const activeAuto = events
    .filter(item => item.trackingStatus === "auto")
    .sort((a, b) =>
      b.earlySignalScore + b.newcomerOpportunityScore * .25 -
      (a.earlySignalScore + a.newcomerOpportunityScore * .25)
    );
  for (const event of activeAuto.slice(20)) {
    event.trackingStatus = "none";
    event.nextRecaptureAt = null;
  }
  return events.sort(eventSort);
}

export function buildDiscoveryPayload(posts = [], snapshots = [], options = {}) {
  const now = Number(options.now || Date.now());
  const computed = Array.isArray(options.events)
    ? options.events
    : buildDiscoveryEvents(posts, snapshots, options);
  const staleNewEvents = computed
    .filter(item => item.stage === "new" && now >= timeOf(item.firstSeenAt) + DISCOVERY_NEW_STAGE_WINDOW)
    .map(item => archiveDiscoveryEvent(item, "expired", now));
  const activeEvents = computed
    .filter(item => item.stage !== "new" || now < timeOf(item.firstSeenAt) + DISCOVERY_NEW_STAGE_WINDOW)
    .filter(item => item.trackingStatus !== "ignored" && item.predictionStatus !== "hit" && item.stage !== "graduated");
  const historyMap = new Map([...(options.history || []), ...staleNewEvents, ...computed.filter(item => item.stage === "graduated")]
    .map(item => [`${item.id}::${item.firstSeenAt}::${item.predictionStatus || item.stage}`, item]));
  const history = [...historyMap.values()]
    .filter(item => item.predictionStatus === "hit" || item.predictionStatus === "expired" || ["graduated", "expired"].includes(item.stage))
    .sort((a, b) => timeOf(b.resolvedAt || b.graduatedAt || b.expiredAt) - timeOf(a.resolvedAt || a.graduatedAt || a.expiredAt));
  const stage = options.stage || "";
  const view = options.view || "all";
  const visible = activeEvents
    .filter(item => !stage || item.stage === stage)
    .filter(item => eventViewMatches(item, view))
    .slice(0, 30);
  const visibleHistory = history
    .filter(item => eventViewMatches(item, view))
    .slice(0, 60);
  const groups = {
    near_rising: visible.filter(item => item.stage === "near_rising"),
    spreading: visible.filter(item => item.stage === "spreading"),
    new: visible.filter(item => item.stage === "new"),
    history: visibleHistory,
    graduated: visibleHistory.filter(item => item.predictionStatus === "hit" || item.stage === "graduated"),
    expired: visibleHistory.filter(item => item.predictionStatus === "expired" || item.stage === "expired")
  };
  return {
    window: "72h",
    lifecycleHours: DISCOVERY_PREDICTION_HOURS,
    view,
    calculatedAt: new Date(now).toISOString(),
    standard: {
      aiConfidence: .75,
      visibleLimit: 30,
      predictionHours: DISCOVERY_PREDICTION_HOURS,
      newStageHours: DISCOVERY_NEW_STAGE_HOURS,
      autoTrackLimit: 20,
      autoPromotionVerifiedSignals: 3,
      stages: {
        spreading: { minimumPosts: 3, minimumCreators: 2, momentumRatio: 1.5 },
        nearRising: { minimumCreators: 3, momentumRatio: 2, heatProximity: .7 }
      }
    },
    coverage: {
      scannedPosts: posts.length,
      eventCount: activeEvents.length,
      visibleCount: visible.length,
      historyCount: history.length,
      hitCount: groups.graduated.length,
      expiredCount: groups.expired.length,
      sourceCount: (options.sourceRegistry || []).filter(item => item.status !== "ignored").length,
      trackingCount: activeEvents.filter(item => ["auto", "manual"].includes(item.trackingStatus)).length,
      overseasCount: activeEvents.filter(item => item.enCreatorCount > 0 && item.zhCreatorCount === 0).length,
      testableCount: activeEvents.filter(item => item.newcomerOpportunityScore >= 70 && item.opportunityBreakdown.testability >= 65).length
    },
    items: visible,
    all: activeEvents,
    history: visibleHistory,
    groups
  };
}

function archiveDiscoveryEvent(event, predictionStatus, now) {
  const resolvedAt = predictionStatus === "hit"
    ? event.graduatedAt || new Date(now).toISOString()
    : new Date(now).toISOString();
  return {
    ...event,
    stage: predictionStatus === "hit" ? "graduated" : "expired",
    predictionStatus,
    trackingStatus: predictionStatus === "hit" ? "graduated" : "expired",
    predictionExpiresAt: event.predictionExpiresAt || new Date(timeOf(event.firstSeenAt) + DISCOVERY_PREDICTION_WINDOW).toISOString(),
    nextRecaptureAt: null,
    resolvedAt,
    expiredAt: predictionStatus === "expired" ? resolvedAt : event.expiredAt || null,
    updatedAt: new Date(now).toISOString()
  };
}

function discoveryLifecycleDeadline(event) {
  const predictionDeadline = timeOf(event.predictionExpiresAt) || timeOf(event.firstSeenAt) + DISCOVERY_PREDICTION_WINDOW;
  if (event.stage !== "new") return predictionDeadline;
  return Math.min(predictionDeadline, timeOf(event.firstSeenAt) + DISCOVERY_NEW_STAGE_WINDOW);
}

export function reconcileDiscoveryLifecycle(state, computedEvents = [], now = Date.now()) {
  ensureDiscoveryState(state);
  const previous = (state.earlyEvents || []).filter(item => item.trackingStatus !== "ignored");
  const ignored = (state.earlyEvents || []).filter(item => item.trackingStatus === "ignored");
  const computedById = new Map(computedEvents.map(item => [String(item.id), item]));
  const activeById = new Map();
  const history = [...(state.discoveryHistory || [])];
  const historyKeys = new Set(history.map(item => `${item.id}::${item.firstSeenAt}::${item.predictionStatus || item.stage}`));

  const archive = (event, status) => {
    const archived = archiveDiscoveryEvent(event, status, now);
    const key = `${archived.id}::${archived.firstSeenAt}::${archived.predictionStatus}`;
    if (!historyKeys.has(key)) {
      history.unshift(archived);
      historyKeys.add(key);
      state.eventAudit.unshift({
        id: `event-audit-${slug(event.id)}-${status}-${now}`,
        eventId: event.id,
        type: status === "hit" ? "prediction_hit" : "prediction_expired",
        createdAt: archived.resolvedAt,
        detail: status === "hit"
          ? "72 小时预测周期内命中正式热帖"
          : event.stage === "new" && now >= timeOf(event.firstSeenAt) + DISCOVERY_NEW_STAGE_WINDOW
            ? "新出现事件 24 小时内未形成扩散，移出当前发现流"
            : "72 小时预测周期结束，未命中正式热帖"
      });
    }
  };

  for (const event of computedEvents) {
    const expiresAt = discoveryLifecycleDeadline(event);
    if (event.stage === "graduated" || event.predictionStatus === "hit") archive(event, "hit");
    else if (now >= expiresAt) archive(event, "expired");
    else activeById.set(String(event.id), {
      ...event,
      predictionStatus: "active",
      predictionExpiresAt: new Date(expiresAt).toISOString()
    });
  }

  for (const event of previous) {
    if (computedById.has(String(event.id)) || activeById.has(String(event.id))) continue;
    const expiresAt = discoveryLifecycleDeadline(event);
    if (event.stage === "graduated" || event.predictionStatus === "hit") archive(event, "hit");
    else if (now >= expiresAt) archive(event, "expired");
    else activeById.set(String(event.id), {
      ...event,
      predictionStatus: "active",
      predictionExpiresAt: new Date(expiresAt).toISOString(),
      updatedAt: new Date(now).toISOString()
    });
  }

  state.earlyEvents = [...activeById.values()].sort(eventSort).concat(ignored);
  state.discoveryHistory = history
    .sort((a, b) => timeOf(b.resolvedAt || b.graduatedAt || b.expiredAt) - timeOf(a.resolvedAt || a.graduatedAt || a.expiredAt))
    .slice(0, 500);
  return { active: state.earlyEvents.filter(item => item.trackingStatus !== "ignored"), history: state.discoveryHistory };
}

export function refreshSourceRegistry(state, events = [], now = Date.now()) {
  ensureDiscoveryState(state);
  const byHandle = new Map(state.sourceRegistry.map(item => [sourceKey(item.platform, item.handle), item]));
  const followedHandles = new Set((state.creators || []).map(item => sourceKey(item.platform, item.handle)));
  for (const event of events) {
    for (const evidence of event.postEvidence || []) {
      const key = handleKey(evidence.handle);
      if (!key) continue;
      const platform = evidence.platform || "x";
      const identity = sourceKey(platform, key);
      let source = byHandle.get(identity);
      if (!source) {
        source = {
          id: sourceId(platform, key),
          platform,
          handle: evidence.handle,
          displayName: evidence.author || evidence.handle,
          sourceType: OFFICIAL_HANDLES.has(key)
            ? "official"
            : followedHandles.has(identity) ? "peer" : evidence.sourceType,
          status: OFFICIAL_HANDLES.has(key) ? "trusted" : "candidate",
          verifiedSignalCount: 0,
          falseSignalCount: 0,
          averageLeadMinutes: null,
          lastSeenAt: evidence.publishedAt,
          verifiedEventIds: []
        };
        state.sourceRegistry.push(source);
        byHandle.set(identity, source);
      }
      source.lastSeenAt = [source.lastSeenAt, evidence.publishedAt].filter(Boolean).sort().at(-1);
      if (event.stage === "graduated" && (event.earliestSource?.platform || "x") === platform && String(event.earliestSource?.handle || "").replace(/^@/, "").toLowerCase() === key) {
        source.verifiedEventIds ||= [];
        if (!source.verifiedEventIds.includes(event.id)) source.verifiedEventIds.push(event.id);
        source.verifiedSignalCount = source.verifiedEventIds.length;
        const leadValues = events
          .filter(item => source.verifiedEventIds.includes(item.id) && Number.isFinite(item.leadMinutes))
          .map(item => item.leadMinutes);
        source.averageLeadMinutes = leadValues.length
          ? Math.round(leadValues.reduce((sum, value) => sum + value, 0) / leadValues.length)
          : source.averageLeadMinutes;
        if (source.status === "candidate" && source.verifiedSignalCount >= 3) {
          source.status = "trusted";
          state.eventAudit.unshift({
            id: `audit-source-${source.id}-${now}`,
            type: "source_auto_promoted",
            sourceId: source.id,
            createdAt: new Date(now).toISOString(),
            detail: "连续提供 3 次可验证的更早信号，自动晋级重点源"
          });
        }
      }
    }
  }
  return state.sourceRegistry;
}

export function buildEarlySearchQueries() {
  return [
    {
      category: "工具与开源首发",
      keywords: ["AI", "Agent", "MCP", "GitHub", "open source"],
      query: `(AI OR Agent OR MCP) ("open source" OR GitHub OR launched OR released OR 开源 OR 发布) -filter:replies`
    },
    {
      category: "模型能力变化",
      keywords: ["Claude", "Codex", "GPT", "Kimi", "DeepSeek", "Grok", "Qwen"],
      query: `(Claude OR Codex OR GPT OR Kimi OR DeepSeek OR Grok OR Qwen) (adds OR supports OR benchmark OR update OR 新增 OR 支持 OR 实测) -filter:replies`
    },
    {
      category: "工作流与真实案例",
      keywords: ["AI workflow", "coding agent", "Agent 工作流", "AI 编程"],
      query: `("AI workflow" OR "coding agent" OR "Agent 工作流" OR "AI 编程") (built OR demo OR tutorial OR 实测 OR 教程 OR 复刻) -filter:replies`
    }
  ];
}

export function enqueueDiscoveryJobs(state, makeId, { now = Date.now(), force = false } = {}) {
  ensureDiscoveryState(state);
  const activeEvents = (state.earlyEvents || [])
    .filter(item => ["auto", "manual"].includes(item.trackingStatus) && now - timeOf(item.firstSeenAt) < DISCOVERY_PREDICTION_WINDOW)
    .sort((a, b) => b.earlySignalScore - a.earlySignalScore)
    .slice(0, 20);
  for (const event of activeEvents) {
    for (const platform of ["x", "douyin"]) {
      const active = state.jobs.some(job =>
      job.targetType === "event_track" &&
      job.eventId === event.id &&
      (job.platform || "x") === platform &&
      ["queued", "running"].includes(job.status)
    );
    const latest = state.jobs
      .filter(job => job.targetType === "event_track" && job.eventId === event.id && (job.platform || "x") === platform)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (active || (!force && latest && now - timeOf(latest.requestedAt) < 15 * 60_000)) continue;
    enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "event_track",
      targetId: event.id,
      eventId: event.id,
      queryCategory: "早期事件追踪",
      keywords: unique([event.subject, event.change]).slice(0, 3),
      query: platform === "x" ? `("${event.subject}" OR "${event.normalizedTitle}") -filter:replies` : unique([event.subject, event.normalizedTitle]).join(" "),
      platform,
      language: "中英双语",
      reason: "追踪早期事件的多作者扩散、中文采用和热度晋级",
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
    });
    }
  }

  for (const spec of buildEarlySearchQueries()) {
    for (const platform of ["x", "douyin"]) {
      const query = platform === "x" ? spec.query : spec.keywords.join(" ");
      const active = state.jobs.some(job =>
      job.targetType === "early_search" &&
      job.query === query &&
      (job.platform || "x") === platform &&
      ["queued", "running"].includes(job.status)
    );
    const latest = state.jobs
      .filter(job => job.targetType === "early_search" && job.query === query && (job.platform || "x") === platform)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (active || (!force && latest && now - timeOf(latest.requestedAt) < 60 * 60_000)) continue;
    enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "early_search",
      targetId: "ai-discovery",
      queryCategory: spec.category,
      keywords: spec.keywords,
      query,
      platform,
      language: "中英双语",
      reason: "发现尚未形成热词的新工具、能力变化和真实工作流",
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
    });
    }
  }

  for (const source of state.sourceRegistry.filter(item => item.status !== "ignored")) {
    const interval = SOURCE_FREQUENCIES[source.sourceType] || 60;
    const active = state.jobs.some(job =>
      job.targetType === "source_watch" &&
      job.sourceId === source.id &&
      ["queued", "running"].includes(job.status)
    );
    const latest = state.jobs
      .filter(job => job.targetType === "source_watch" && job.sourceId === source.id)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (active || (!force && latest && now - timeOf(latest.requestedAt) < interval * 60_000)) continue;
    enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "source_watch",
      targetId: source.id,
      sourceId: source.id,
      handle: source.handle,
      queryCategory: "重点来源",
      keywords: [],
      platform: source.platform || "x",
      language: source.sourceType === "english_tester" ? "英文" : "中英双语",
      reason: `监控${sourceRoleLabel(source.sourceType)}的新发布`,
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
    });
  }
}
import { enqueueCollectionJob } from "./job-leases.mjs";
