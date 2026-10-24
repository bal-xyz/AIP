import { createHash } from "node:crypto";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STAGE_RANK = { candidate: 0, new: 1, spreading: 2, hot: 3, burst: 4, cooling: 0, pending: 0 };

const SUBJECTS = [
  ["openai", /\bopenai\b|\bchatgpt\b|\bgpt[-\s]?\d|开放人工智能/iu],
  ["anthropic", /\banthropic\b|\bclaude\b|克劳德/iu],
  ["google-gemini", /\bgemini\b|\bgoogle\s*(?:ai|deepmind)\b|谷歌.*(?:模型|人工智能)/iu],
  ["xai-grok", /\bxai\b|\bgrok\b|格罗克/iu],
  ["meta-llama", /\bmeta\s*ai\b|\bllama\b|大羊驼模型/iu],
  ["deepseek", /\bdeepseek\b|深度求索/iu],
  ["qwen", /\bqwen\b|通义千问/iu],
  ["kimi", /\bkimi\b|月之暗面/iu],
  ["doubao", /\bdoubao\b|豆包/iu],
  ["minimax", /\bminimax\b|稀宇科技/iu],
  ["mistral", /\bmistral\b|米斯特拉尔/iu],
  ["huggingface", /\bhugging\s*face\b|抱抱脸/iu],
  ["nvidia", /\bnvidia\b|英伟达/iu],
  ["codex", /\bcodex\b/iu],
  ["copilot", /\b(?:github|microsoft)?\s*copilot\b|智能副驾/iu]
];

const ACTIONS = [
  ["release", /发布|上线|推出|正式开放|\blaunch(?:ed)?\b|\breleas(?:e|ed)\b|\bship(?:ped)?\b/iu],
  ["upgrade", /升级|更新|新增能力|支持了|\bupdat(?:e|ed)\b|\bupgrad(?:e|ed)\b|\badds?\b|\bsupports?\b/iu],
  ["open-source", /开源|开放权重|\bopen[-\s]?source(?:d)?\b|\bopen\s+weights?\b/iu],
  ["pricing", /降价|涨价|免费|定价|价格调整|\bpricing\b|\bprice\b|\bfree\s+tier\b/iu],
  ["outage", /故障|宕机|服务中断|\boutage\b|\bdown\b|\bservice disruption\b/iu],
  ["security", /漏洞|泄露|攻击|越狱|安全事件|\bvulnerability\b|\bleak\b|\bexploit\b|\bjailbreak\b/iu],
  ["benchmark", /实测|评测|基准测试|跑分|\bbenchmark\b|\breview\b|\boutperform/iu],
  ["funding", /融资|收购|投资|\bfunding\b|\bacqui(?:re|sition)\b|\binvestment\b/iu]
];

function normalizeDetail(value) {
  return String(value || "").toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\u3400-\u9fff.-]/gu, "");
}

const BROAD_CHANGES = new Set([
  "image-generation", "video-generation", "speech-audio", "coding", "reasoning",
  "agent", "context", "api-update", "model", "new-model", "upgrade", "release", "outage", "security"
]);

function specificDetail(value, action, version = "") {
  const candidate = normalizeDetail(version || value);
  if (!candidate || BROAD_CHANGES.has(candidate)) return "";
  if (["outage", "security"].includes(action)) {
    return /(?:cve-\d{4}-\d{4,7}|inc(?:ident)?-?\d{3,})/iu.test(candidate) ? candidate : "";
  }
  const knownProduct = /(?:gpt|claude|gemini|grok|llama|qwen|kimi|deepseek|dall-?e|sora|whisper|operator|chatgpt|codex|computer-?use|deep-?research)/iu.test(candidate);
  const versionedCapability = /\d/.test(candidate) && /[a-z\u3400-\u9fff]/iu.test(candidate);
  return knownProduct || versionedCapability ? candidate : "";
}

function subjectForDetail(subject, detail) {
  const normalized = normalizeDetail(detail);
  const mapped = [
    [/^deepseek(?:-|$)/u, "deepseek"],
    [/^claude(?:-|$)/u, "anthropic"],
    [/^gemini(?:-|$)/u, "google-gemini"],
    [/^grok(?:-|$)/u, "xai-grok"],
    [/^llama(?:-|$)/u, "meta-llama"],
    [/^qwen(?:-|$)/u, "qwen"],
    [/^kimi(?:-|$)/u, "kimi"],
    [/^gpt(?:-|$)/u, "openai"],
    [/^chatgpt(?:-|$)/u, "openai"],
    [/^codex(?:-|$)/u, "codex"]
  ].find(([pattern]) => pattern.test(normalized));
  return mapped?.[1] || subject;
}

function exactChange(text, action) {
  const product = text.match(/\b(?:dall[-\s]?e|sora(?:\s+image)?|whisper|operator|chatgpt|codex|computer\s+use|deep\s+research)[-\s]?[a-z]?\d*(?:\.\d+){0,2}\b/iu)?.[0];
  const incident = text.match(/\b(?:CVE-\d{4}-\d{4,7}|INC(?:IDENT)?[-\s]?\d{3,})\b/iu)?.[0];
  if (["outage", "security"].includes(action)) return normalizeDetail(incident || "");
  return normalizeDetail(product || incident || "");
}

function timeOf(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function languageOf(post) {
  if (post.language) return post.language;
  return /[\u3400-\u9fff]/u.test(String(post.text || "")) ? "zh" : "en";
}

function platformOf(post) {
  return post.platform || (String(post.source || "").startsWith("douyin") ? "douyin" : "x");
}

function authorIdentity(post) {
  if (post.sourceFamilyId) return String(post.sourceFamilyId);
  return `${platformOf(post)}:${String(post.platformAuthorId || post.handle || post.author || "").replace(/^@/, "").toLowerCase()}`;
}

function gradeOf(post) {
  return post.quality?.grade || post.qualityGrade || post.analysis?.qualityGrade || post.analysis?.grade || null;
}

function momentumOf(post) {
  return post.momentum?.status || post.momentumStatus || post.analysis?.momentumStatus || null;
}

export function extractEventFields(post) {
  if (post.eventFields?.subject && post.eventFields?.action) {
    const action = String(post.eventFields.action);
    const version = specificDetail("", action, post.eventFields.version || "");
    const change = specificDetail(post.eventFields.change || post.eventFields.product || "", action);
    if (!version && !change) return null;
    return {
      subject: subjectForDetail(String(post.eventFields.subject), version || change),
      action,
      version,
      change,
      confidence: Number(post.eventFields.confidence || 1),
      origin: post.eventFields.origin || "structured"
    };
  }
  const text = String(post.text || "");
  const subject = SUBJECTS.find(([, pattern]) => pattern.test(text))?.[0];
  const action = ACTIONS.find(([, pattern]) => pattern.test(text))?.[0];
  if (!subject || !action) return null;
  const version = text.match(/\b(?:gpt|claude|gemini|grok|llama|qwen|kimi|deepseek)[-\s]?[a-z]?\d+(?:\.\d+){0,2}\b/iu)?.[0]?.toLowerCase().replace(/\s+/g, "-") || "";
  const change = exactChange(text, action);
  const specificVersion = specificDetail("", action, version);
  const specificChange = specificDetail(change, action);
  if (!specificVersion && !specificChange) return null;
  return { subject: subjectForDetail(subject, specificVersion || specificChange), action, version: specificVersion, change: specificChange, confidence: 0.82, origin: "deterministic" };
}

export function eventKey(fields) {
  if (!fields?.subject || !fields?.action) return null;
  const detail = fields.version || fields.change || "";
  if (!detail) return null;
  return `${fields.subject}|${fields.action}|${detail}`;
}

function stageFor(posts, acceleration) {
  const authorCount = new Set(posts.map(authorIdentity).filter(Boolean)).size;
  const t1 = posts.filter(post => gradeOf(post) === "T1").length;
  const t2 = posts.filter(post => gradeOf(post) === "T2").length;
  const t3 = posts.filter(post => gradeOf(post) === "T3").length;
  const rising = posts.some(post => ["rising", "burst"].includes(momentumOf(post)));
  const official = posts.some(post => post.sourceType === "official" || post.isOfficial);
  if (posts.length >= 12 && authorCount >= 8 && (t3 >= 1 || t2 >= 2) && acceleration.accelerating) return "burst";
  if (posts.length >= 8 && authorCount >= 5 && (t1 >= 2 || t2 >= 1 || t3 >= 1)) return "hot";
  if (posts.length >= 5 && authorCount >= 3 && (t1 >= 1 || t2 >= 1 || t3 >= 1 || rising)) return "spreading";
  if ((posts.length >= 3 && authorCount >= 2) || official) return "new";
  return "candidate";
}

function accelerationFor(posts, now) {
  const recent = posts.filter(post => now - timeOf(post.publishedAt || post.capturedAt) <= 2 * HOUR);
  const previous = posts.filter(post => {
    const age = now - timeOf(post.publishedAt || post.capturedAt);
    return age > 2 * HOUR && age <= 4 * HOUR;
  });
  const recentAuthors = new Set(recent.map(authorIdentity).filter(Boolean)).size;
  const ratio = previous.length ? recent.length / previous.length : (recent.length ? Infinity : 0);
  return {
    accelerating: recentAuthors >= 3 && (previous.length === 0 || ratio >= 1.5),
    recentPosts: recent.length,
    previousPosts: previous.length,
    recentAuthors,
    ratio
  };
}

function coverageValid(coverage) {
  if (!coverage) return false;
  return coverage.nodeHealthy === true &&
    Number(coverage.successRate) >= 0.8 &&
    coverage.authRequired !== true &&
    coverage.parserFailure !== true;
}

function stageLabel(stage) {
  return {
    candidate: "候选",
    new: "新出现",
    spreading: "开始扩散",
    hot: "热点",
    burst: "爆发热点",
    cooling: "冷却",
    pending: "阶段待确认"
  }[stage] || stage;
}

function eventTitle(fields) {
  const subject = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    "google-gemini": "Google Gemini",
    "xai-grok": "xAI Grok",
    "meta-llama": "Meta Llama",
    deepseek: "DeepSeek",
    qwen: "通义千问",
    kimi: "Kimi",
    doubao: "豆包",
    minimax: "MiniMax",
    mistral: "Mistral",
    huggingface: "Hugging Face",
    nvidia: "NVIDIA",
    codex: "Codex",
    copilot: "Copilot"
  }[fields.subject] || fields.subject;
  const action = {
    release: "正式发布",
    upgrade: "能力升级",
    "open-source": "开源",
    pricing: "价格调整",
    outage: "发生服务故障",
    security: "出现安全事件",
    benchmark: "集中实测",
    funding: "融资或收购"
  }[fields.action] || fields.action;
  let detail = String(fields.version || fields.change || "").replace(/-/g, " ");
  const subjectKey = String(fields.subject || "").replace(/-/g, " ").toLowerCase();
  const detailPrefix = {
    deepseek: "deepseek",
    anthropic: "claude",
    "google-gemini": "gemini",
    "xai-grok": "grok",
    "meta-llama": "llama",
    qwen: "qwen",
    kimi: "kimi",
    codex: "codex"
  }[fields.subject] || subjectKey;
  if (detail.toLowerCase() === detailPrefix) detail = "";
  if (detail.toLowerCase().startsWith(`${detailPrefix} `)) detail = detail.slice(detailPrefix.length + 1);
  return `${subject}${detail ? ` ${detail}` : ""} ${action}`;
}

export function buildEvents(posts, options = {}) {
  const now = Number(options.now || Date.now());
  const initialWindowMs = Number(options.initialWindowHours || 72) * HOUR;
  const buckets = new Map();
  for (const post of posts) {
    if (post.isPureRepost || post.contentType === "repost" || post.aiRelevant === false) continue;
    const publishedAt = timeOf(post.publishedAt || post.capturedAt);
    if (publishedAt === null || now - publishedAt > initialWindowMs || publishedAt > now) continue;
    const fields = extractEventFields(post);
    const key = eventKey(fields);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, { fields, posts: [] });
    const identity = `${platformOf(post)}:${post.id}`;
    if (!buckets.get(key).posts.some(item => `${platformOf(item)}:${item.id}` === identity)) buckets.get(key).posts.push(post);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const values = bucket.posts.sort((a, b) => timeOf(a.publishedAt || a.capturedAt) - timeOf(b.publishedAt || b.capturedAt));
    const eventCoverage = options.coverageForPosts?.(values) || options.coverageWindows || [];
    const acceleration = accelerationFor(values, now);
    const calculated = stageFor(values, acceleration);
    const previous = options.previousEvents?.find(event => event.key === key);
    let stage = calculated;
    let stageReason = "当前证据满足阶段门槛";
    const lastSeenAt = values.at(-1)?.publishedAt || values.at(-1)?.capturedAt;
    const hoursSinceNew = (now - timeOf(lastSeenAt)) / HOUR;
    if (previous && (hoursSinceNew >= 48 || STAGE_RANK[calculated] < STAGE_RANK[previous.stage])) {
      const recentCoverage = eventCoverage.slice(-2);
      const validWindows = recentCoverage.length >= 2 && recentCoverage.every(coverageValid);
      if (!validWindows) {
        stage = "pending";
        stageReason = "采集覆盖不足，暂停负向阶段转换";
      } else if (hoursSinceNew >= 48 && !values.some(post =>
        now - timeOf(post.publishedAt || post.capturedAt) <= 4 * HOUR &&
        ["T2", "T3"].includes(gradeOf(post))
      )) {
        stage = "cooling";
        stageReason = "两个有效观察窗口下降且没有新增高等级热帖";
      } else {
        stage = previous.stage;
        stageReason = "尚未满足冷却条件，保留上一阶段";
      }
    }
    const authors = [...new Set(values.map(authorIdentity).filter(Boolean))];
    const languages = values.reduce((result, post) => {
      const language = languageOf(post);
      result[language] = (result[language] || 0) + 1;
      return result;
    }, {});
    const platforms = values.reduce((result, post) => {
      const platform = platformOf(post);
      result[platform] = (result[platform] || 0) + 1;
      return result;
    }, {});
    const first = values[0];
    return {
      id: `event-${sha(`${key}|${new Date(timeOf(first.publishedAt || first.capturedAt)).toISOString().slice(0, 10)}`)}`,
      key,
      title: eventTitle(bucket.fields),
      fields: bucket.fields,
      stage,
      stageLabel: stageLabel(stage),
      stageReason,
      firstSeenAt: first.publishedAt || first.capturedAt,
      lastSeenAt,
      earliestPostId: first.id,
      earliestSource: { author: first.author, handle: first.handle, url: first.url, platform: platformOf(first) },
      postIds: values.map(post => post.id),
      postCount: values.length,
      authorCount: authors.length,
      languageCounts: languages,
      platformCounts: platforms,
      acceleration,
      representativePosts: [...values]
        .sort((a, b) => ({ T3: 3, T2: 2, T1: 1 }[gradeOf(b)] || 0) - ({ T3: 3, T2: 2, T1: 1 }[gradeOf(a)] || 0) || Number(b.likes || 0) - Number(a.likes || 0))
        .slice(0, 4),
      coverage: eventCoverage.at(-1) || null
    };
  }).sort((a, b) => STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt));
}

export { STAGE_RANK, coverageValid };
