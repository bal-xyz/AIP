import { extractChangeCandidates, extractTopicCandidates } from "./trending.mjs";
import { enqueueCollectionJob } from "./job-leases.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const isChinese = post => /[\u3400-\u9fff]/u.test(String(post?.text || ""));
const handleKey = post => String(post?.handle || post?.author || "").replace(/^@/, "").toLowerCase();
const quote = value => /\s/.test(value) ? `"${value}"` : value;
const statusId = value => String(value || "").match(/\/status\/(\d+)/)?.[1] || null;

export function buildChineseHotQueries() {
  return [
    {
      category: "中文 AI 热点",
      keywords: ["AI", "人工智能", "大模型"],
      query: `("AI" OR "人工智能" OR "大模型") lang:zh min_faves:20 -filter:replies`
    },
    {
      category: "模型与产品",
      keywords: ["Codex", "Claude", "ChatGPT", "Gemini", "DeepSeek", "Kimi", "Qwen"],
      query: `(Codex OR Claude OR ChatGPT OR Gemini OR DeepSeek OR Kimi OR Qwen) lang:zh min_faves:20 -filter:replies`
    },
    {
      category: "Agent 与工作流",
      keywords: ["Agent", "智能体", "AI 编程", "Vibe Coding"],
      query: `(Agent OR 智能体 OR "AI 编程" OR "Vibe Coding") lang:zh min_faves:15 -filter:replies`
    },
    {
      category: "多模态与基础设施",
      keywords: ["开源模型", "视频生成", "多模态", "机器人", "AI 芯片"],
      query: `("开源模型" OR "视频生成" OR 多模态 OR 机器人 OR "AI 芯片") lang:zh min_faves:15 -filter:replies`
    },
    {
      category: "产业与风险",
      keywords: ["AI 创业", "融资", "AI 安全", "推理成本", "模型评测"],
      query: `("AI 创业" OR 融资 OR "AI 安全" OR 推理成本 OR 模型评测) lang:zh min_faves:15 -filter:replies`
    }
  ];
}

export function enqueueChineseHotJobs(state, makeId, { now = Date.now(), force = false } = {}) {
  const industry = state.industries?.[0];
  for (const spec of buildChineseHotQueries()) {
    for (const platform of ["x", "douyin"]) {
      const query = platform === "x" ? spec.query : spec.keywords.join(" ");
      const active = state.jobs.some(job =>
      job.targetType === "chinese_hot" &&
      job.query === query &&
      (job.platform || "x") === platform &&
      ["queued", "running"].includes(job.status)
    );
    const latest = state.jobs
      .filter(job => job.targetType === "chinese_hot" && job.query === query && (job.platform || "x") === platform)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (active || (!force && latest && now - safeTime(latest.requestedAt) < HOUR)) continue;
    enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "chinese_hot",
      targetId: industry?.id || "ai-industry",
      industry: industry?.name || "AI",
      queryCategory: spec.category,
      keywords: spec.keywords,
      query,
      platform,
      language: "中文",
      reason: "先发现中文 AI 圈正在升温的真实帖子，再反向追溯母帖",
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
    });
    }
  }
}

function traceTerms(post) {
  const entities = extractTopicCandidates(post)
    .filter(item => item.kind === "entity")
    .map(item => item.normalizedText);
  const changes = extractChangeCandidates(post);
  const subjects = changes.map(item => item.subject).filter(Boolean);
  return [...new Set([...entities, ...subjects, ...(post.topics || [])])]
    .filter(term => term && !["AI", "人工智能", "大模型"].includes(term))
    .slice(0, 3);
}

function traceQuery(post, terms) {
  const published = safeTime(post.publishedAt || post.capturedAt) || Date.now();
  const since = new Date(published - 4 * DAY).toISOString().slice(0, 10);
  const until = new Date(published + DAY).toISOString().slice(0, 10);
  return `(${terms.map(quote).join(" OR ")}) since:${since} until:${until} -filter:replies`;
}

export function enqueueRootTraceJobs(state, makeId, { now = Date.now(), force = false, limit = 8 } = {}) {
  const candidates = (state.posts || [])
    .filter(post =>
      isChinese(post) &&
      post.analysis?.hot &&
      now - safeTime(post.publishedAt || post.capturedAt) <= 48 * HOUR
    )
    .sort((a, b) => Number(b.analysis?.score || 0) - Number(a.analysis?.score || 0))
    .slice(0, limit);

  for (const post of candidates) {
    if (post.provenance?.relation === "explicit_reference" && post.provenance.rootPostId) continue;
    const active = state.jobs.some(job =>
      job.targetType === "root_trace" &&
      job.sourcePostId === post.id &&
      ["queued", "running"].includes(job.status)
    );
    const latest = state.jobs
      .filter(job => job.targetType === "root_trace" && job.sourcePostId === post.id)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    if (active || (!force && latest && now - safeTime(latest.requestedAt) < DAY)) continue;

    const referencedUrl = (post.referencedPostUrls || []).find(url => statusId(url) && statusId(url) !== String(post.id));
    const terms = traceTerms(post);
    if (!referencedUrl && !terms.length) continue;
    enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "root_trace",
      targetId: post.id,
      sourcePostId: post.id,
      sourcePostUrl: post.url || post.sourceUrl,
      targetUrl: referencedUrl || null,
      queryCategory: referencedUrl ? "显式母帖" : "母帖追溯",
      keywords: terms,
      query: referencedUrl ? "" : traceQuery(post, terms),
      platform: "x",
      language: "中英双语",
      reason: referencedUrl ? "中文热帖包含明确 X 引用" : "根据中文热帖中的对象、事件与发布时间反向寻找更早来源",
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
    });
  }
}

function evidenceTerms(post) {
  return new Set([
    ...extractTopicCandidates(post).map(item => item.normalizedText.toLowerCase()),
    ...extractChangeCandidates(post).flatMap(item => [item.normalizedText, item.subject]).filter(Boolean).map(value => value.toLowerCase()),
    ...(post.topics || []).map(value => String(value).toLowerCase())
  ]);
}

export function buildPostProvenance(posts = []) {
  const byId = new Map(posts.map(post => [String(post.id), post]));
  const termsById = new Map(posts.map(post => [String(post.id), evidenceTerms(post)]));
  const childrenByRoot = new Map();

  const enriched = posts.map(post => {
    if (!isChinese(post) || !post.analysis?.hot) return { ...post };
    const published = safeTime(post.publishedAt || post.capturedAt);
    const references = [
      ...(post.referencedPostIds || []),
      ...(post.referencedPostUrls || []).map(statusId)
    ].filter(Boolean).map(String);
    const explicit = references
      .map(id => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => safeTime(a.publishedAt || a.capturedAt) - safeTime(b.publishedAt || b.capturedAt))[0];

    let root = explicit || null;
    let relation = explicit ? "explicit_reference" : null;
    let confidence = explicit ? .99 : 0;
    let evidence = explicit ? "中文热帖包含明确的 X 帖子引用" : null;

    if (!root) {
      const childTerms = termsById.get(String(post.id)) || new Set();
      const ranked = posts
        .filter(candidate =>
          candidate.id !== post.id &&
          handleKey(candidate) !== handleKey(post) &&
          safeTime(candidate.publishedAt || candidate.capturedAt) > 0 &&
          safeTime(candidate.publishedAt || candidate.capturedAt) < published &&
          published - safeTime(candidate.publishedAt || candidate.capturedAt) <= 7 * DAY
        )
        .map(candidate => {
          const candidateTerms = termsById.get(String(candidate.id)) || new Set();
          const shared = [...childTerms].filter(term => candidateTerms.has(term));
          const traced = candidate.discovery?.rootTraceSourcePostId === post.id;
          const sameChange = extractChangeCandidates(post).some(childChange =>
            extractChangeCandidates(candidate).some(parentChange =>
              childChange.normalizedText.toLowerCase() === parentChange.normalizedText.toLowerCase()
            )
          );
          const score = shared.length * 18 + Number(traced) * 42 + Number(sameChange) * 28 + Number(!isChinese(candidate)) * 6;
          return { candidate, shared, traced, sameChange, score };
        })
        .filter(item => item.shared.length && item.score >= 42)
        .sort((a, b) =>
          b.score - a.score ||
          safeTime(a.candidate.publishedAt || a.candidate.capturedAt) - safeTime(b.candidate.publishedAt || b.candidate.capturedAt)
        )[0];
      if (ranked) {
        root = ranked.candidate;
        relation = ranked.traced || ranked.sameChange ? "trace_match" : "semantic_timeline";
        confidence = ranked.traced || ranked.sameChange ? .84 : .7;
        evidence = ranked.traced
          ? `母帖追溯任务命中，且共享 ${ranked.shared.join("、")}`
          : `更早发布且共享 ${ranked.shared.join("、")}`;
      }
    }

    if (!root) return { ...post, provenance: { status: "searching", rootPostId: null, confidence: 0 } };
    if (!childrenByRoot.has(String(root.id))) childrenByRoot.set(String(root.id), []);
    childrenByRoot.get(String(root.id)).push(String(post.id));
    return {
      ...post,
      referencedPostId: relation === "explicit_reference" ? String(root.id) : post.referencedPostId || null,
      provenance: {
        status: relation === "explicit_reference" ? "confirmed" : "candidate",
        rootPostId: String(root.id),
        rootPostUrl: root.url || root.sourceUrl,
        rootHandle: root.handle,
        relation,
        confidence,
        evidence
      }
    };
  });

  return enriched.map(post => ({
    ...post,
    rootSourceForPostIds: childrenByRoot.get(String(post.id)) || post.rootSourceForPostIds || []
  }));
}
