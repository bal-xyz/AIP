const WINDOWS = {
  "2h": {
    hours: 2, focusLimit: 80, burstTarget: 20, risingTarget: 60,
    relatedLimit: 255, independentSignalLimit: 45, contextLimit: 300, contextPerFocus: 12
  },
  "24h": {
    hours: 24, focusLimit: 80, burstTarget: 20, risingTarget: 60,
    relatedLimit: 255, independentSignalLimit: 45, contextLimit: 300, contextPerFocus: 12
  },
  "7d": {
    hours: 168, focusLimit: 80, burstTarget: 20, risingTarget: 60,
    relatedLimit: 255, independentSignalLimit: 45, contextLimit: 300, contextPerFocus: 12
  }
};

const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const postTime = post => safeTime(post?.publishedAt || post?.capturedAt);
const handleKey = post => String(post?.handle || post?.author || "").replace(/^@/, "").toLowerCase();
const unique = values => [...new Set(values.map(String))];

function publicInteractions(post) {
  return ["likes", "replies", "reposts", "bookmarks"]
    .reduce((sum, key) => sum + Math.max(0, Number(post?.[key]) || 0), 0);
}

const TITLE_ACTIONS = [
  ["暂停.{0,8}融资|暂缓.{0,8}融资|中止.{0,8}融资|叫停.{0,8}融资|融资.{0,12}(暂停|暂缓|中止|叫停)", "暂停融资"],
  ["免费.{0,12}(订阅|MAX|20X)|白嫖.{0,12}(Claude|订阅|MAX|20X)", "免费订阅"],
  ["支持开源模型的宣言|开源模型.{0,12}宣言|宣言.{0,12}开源模型", "开源模型宣言"],
  ["开源模型.{0,12}(部署|落地)", "开源模型部署"],
  ["开源模型.{0,18}(价格|token价格|冲击|市场份额)", "开源模型价格冲击"],
  ["没有签署|拒绝签署|拒签|反对开源", "拒签开源协议"],
  ["系统提示词.{0,28}(删除|删掉|减少|精简)|删掉.{0,28}系统提示词", "精简提示词"],
  ["AI.{0,8}合成.{0,8}(声音|语音)|合成总统声音", "AI合成声音争议"],
  ["政治敏感|涉及国安|涉密|间谍活动", "AI机构合规风险"],
  ["最强模型|模型.{0,10}(对比|排名)|benchmark", "模型能力对比"],
  ["时间差.{0,12}(投资|资本开支)|投资.{0,12}时间差", "AI投资时间差"],
  ["破解软件|找密码|破甲", "软件破解测试"],
  ["parallel QA|prep of the next release|发布前.{0,8}(测试|QA)", "版本发布测试"],
  ["mature architecture|架构.{0,12}(成熟|稳定|演进)", "架构演进"],
  ["AI交易|交易 Bot|交易机器人", "AI交易机器人"],
  ["停留在聊天|只当成聊天机器人|从聊天.{0,12}Agent", "AI转向Agent"],
  ["额度.{0,8}(重置|恢复)|(重置|恢复).{0,8}额度|reset.{0,8}(quota|limit)", "额度重置"],
  ["Claude.{0,18}订阅.{0,18}封号|封号.{0,18}Claude", "订阅封号风险"],
  ["Windows.{0,18}Codex|Codex.{0,18}Windows", "Windows适配"],
  ["不用大学|不用课堂|AI.{0,12}自学", "AI自学争议"],
  ["ChatGPT Work.{0,18}(超越|超过)|活跃用户.{0,18}超越Codex", "Work用户增长"],
  ["Gemini.{0,18}订阅.{0,18}(错误|后悔)|订阅.{0,18}Gemini.{0,18}(错误|后悔)", "订阅体验争议"],
  ["Codex.{0,18}Seedance|Seedance.{0,18}Codex", "视频制作工作流"],
  ["宕机|故障|无法正常|down", "服务故障"],
  ["融资|投资者|估值|funding", "融资动态"],
  ["投资|预算|资本开支|capex", "AI投资"],
  ["误区|误解|错误判断", "行业误区"],
  ["监管|警察|禁令|合规|policy|regulation", "AI监管"],
  ["版权|侵权|copyright", "版权争议"],
  ["论文|研究|paper|research", "研究进展"],
  ["机器人|robot", "机器人进展"],
  ["芯片|GPU|算力|数据中心", "算力建设"],
  ["收购|并购|acquisition", "收购动态"],
  ["取代|失业|岗位|裁员", "岗位影响"],
  ["提示词|prompt", "提示词技巧"],
  ["图片|图像|image", "图像生成"],
  ["开源|open.?source", "开源发布"],
  ["发布|推出|上线|launch|released?", "新品发布"],
  ["浏览器|browser", "浏览器控制"],
  ["桌面|desktop", "桌面控制"],
  ["视频生成|生成视频|文生视频|video generation|text.?to.?video", "视频生成"],
  ["降价|价格|pricing|price", "模型降价"],
  ["评测|实测|benchmark|review", "能力评测"],
  ["教程|指南|guide|workflow", "实战教程"],
  ["安全|攻击|风险|security", "安全风险"],
  ["语音|voice", "语音交互"],
  ["推理|reasoning", "推理能力"],
  ["Agent|智能体", "智能体实践"]
];
const TITLE_ENTITY_RULES = [
  [/\bGPT[-\s]?5\.6(?:\s+(?:Sol|Terra|Pro|Ultra))?/i, "GPT-5.6"],
  [/\bClaude\s+Code\b/i, "Claude Code"],
  [/\bClaude(?:\s+(?:MAX|Opus))?\b/i, "Claude"],
  [/\bOpen\s+Minis\b/i, "Open Minis"],
  [/\bOpenWorker\b/i, "OpenWorker"],
  [/\bDeepSeek\b/i, "DeepSeek"],
  [/\bAnthropic\b/i, "Anthropic"],
  [/\bOpenAI\b/i, "OpenAI"],
  [/\bChatGPT\b/i, "ChatGPT"],
  [/\bGemini\b/i, "Gemini"],
  [/\bCodex\b/i, "Codex"],
  [/\bHermes\b/i, "Hermes"],
  [/\bBento\b/i, "Bento"],
  [/\bCindy\b/i, "Cindy"],
  [/\bGrok\b/i, "Grok"],
  [/\bKimi\b/i, "Kimi"],
  [/\bQwen\b/i, "Qwen"],
  [/\bMCP\b/i, "MCP"],
  [/\bAgent\b/i, "Agent"]
];

const titleUnit = char => /[\u3400-\u9fff]/u.test(char) ? 1 : /\s/u.test(char) ? .32 : .52;
const titleUnits = value => [...String(value || "")].reduce((sum, char) => sum + titleUnit(char), 0);

function compactTitle(value, maxUnits = 10) {
  const text = String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[@#][^\s，。！？；、]+/gu, "")
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[，。！？；、:：\s-]+|[，。！？；、:：\s-]+$/g, "")
    .trim();
  if (titleUnits(text) <= maxUnits) return text;
  let result = "";
  let used = 0;
  for (const char of text) {
    const next = used + titleUnit(char);
    if (next > maxUnits) break;
    result += char;
    used = next;
  }
  return result.replace(/[\s，。！？；、:：-]+$/g, "").trim();
}

function validSkillTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || /^(观点|故事|教程|列表|内容|行业|话题)(讨论|分享|信号)?$/u.test(text)) return "";
  return compactTitle(text);
}

function entityFor(text, post, matchedKeyword) {
  const matched = TITLE_ENTITY_RULES.find(([pattern]) => pattern.test(text))?.[1];
  if (matched) return matched;
  const topic = (post?.topics || []).find(value => {
    const normalized = String(value || "").trim();
    return normalized &&
      !/^(AI|大模型|模型|工具|科技|代码|智能|融资|开源|开源模型|机器人|视频|图像)$/u.test(normalized) &&
      titleUnits(normalized) <= 10;
  });
  if (topic) return String(topic).trim();
  if (matchedKeyword && !/^(AI|大模型|模型|工具|科技|代码|智能)$/u.test(String(matchedKeyword))) {
    return String(matchedKeyword).trim();
  }
  return "";
}

export function aiIndustryPost(post, trendingKeywords = []) {
  const text = String(post?.text || "");
  if ((post?.topics || []).some(value =>
    !/^(AI|大模型|模型|工具|科技|代码|智能)$/u.test(String(value || "").trim())
  )) return true;
  const hasEntity = TITLE_ENTITY_RULES.some(([pattern]) => pattern.test(text));
  const hasIndustryContext = /模型|智能体|Agent|算力|芯片|数据中心|开源|代码|编程|提示词|token|推理|生成|机器人|自动化|浏览器|桌面|语音|图像|视频生成|订阅|额度|融资|资本开支|监管|安全|评测|API|系统提示词|AI\s*Labs?/iu.test(text);
  if (hasEntity && hasIndustryContext) return true;
  return /(?:AI|人工智能|大模型|AIGC).{0,28}(?:模型|智能体|Agent|算力|芯片|开源|代码|编程|提示词|推理|生成|机器人|自动化|语音|图像|融资|投资|资本开支|监管|安全|合成|实验室|Labs?)|(?:模型|智能体|Agent|算力|芯片|开源|代码|编程|提示词|推理|生成|机器人|自动化|语音|图像|融资|投资|资本开支|监管|安全|合成|实验室|Labs?).{0,28}(?:AI|人工智能|大模型|AIGC)/iu.test(text);
}

function semanticExcerpt(text) {
  const clauses = text
    .split(/[\n。！？；]+/u)
    .flatMap(sentence => sentence.split(/[，,:：]+/u))
    .map(value => value
      .replace(/^(?:哈|啊|卧槽|这事儿|今天|现在|目前|最新|终于|刚刚|刚看完|我发现|我觉得|我们发现|不少人|很多人|有人|关于)+/u, "")
      .replace(/^(?:这个|这些|那个|那种|属于|就是|其实|似乎|可能|据悉|看来|不得不说)+/u, "")
      .replace(/\([^)]*\)/g, "")
      .trim())
    .filter(value => value.length >= 4 && !/^https?:/i.test(value));
  const score = clause => {
    const hasEntity = TITLE_ENTITY_RULES.some(([pattern]) => pattern.test(clause));
    const hasAction = TITLE_ACTIONS.some(([pattern]) => new RegExp(pattern, "i").test(clause));
    const hasAi = /AI|模型|智能体|Agent|开源|算力|芯片|机器人|提示词|语音|图像|视频/u.test(clause);
    const specific = /融资|发布|上线|开源|降价|评测|实测|控制|协议|合成|投资|风险|故障|教程|系统/u.test(clause);
    return Number(hasEntity) * 6 + Number(hasAction) * 5 + Number(hasAi) * 3 + Number(specific) * 2 -
      Number(/^(我|你|他|大家|很多|不少|这个|那个)/u.test(clause)) * 2 -
      Math.max(0, clause.length - 34) * .04;
  };
  const best = clauses.sort((a, b) => score(b) - score(a) || a.length - b.length)[0] || "";
  return compactTitle(best
    .replace(/(?:非常|真的|一个|一种|一款|相关|已经|开始|主要|核心|最新|目前|现在|终于|直接|基本上)/gu, "")
    .replace(/(?:可以|需要|能够|可能|似乎|认为|觉得|发现)/gu, ""));
}

function titleFor(post, trendingKeywords = []) {
  const text = String(post?.text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const skillTitle = validSkillTitle(
    post?.analysis?.displayTitle ||
    post?.analysis?.title ||
    post?.analysis?.summary ||
    post?.analysis?.contentSummary ||
    post?.analysis?.changeSummary ||
    post?.analysis?.skillOutputs?.title
  );
  if (skillTitle) return { text: skillTitle, source: "skill" };
  const action = TITLE_ACTIONS.find(([pattern]) => new RegExp(pattern, "i").test(text))?.[1] || "";
  const matchedKeyword = trendingKeywords.find(item =>
    (item.sourcePostIds || []).some(id => String(id) === String(post?.id))
  )?.normalizedText;
  const entity = entityFor(text, post, matchedKeyword);
  if (/^(AI机构|AI合成|AI投资|AI自学|AI转向|AI交易|开源模型)/u.test(action)) {
    return { text: validSkillTitle(action), source: "rule" };
  }
  if (entity && action) {
    if (String(entity).replace(/\s+/g, "").includes(String(action).replace(/\s+/g, ""))) {
      return { text: validSkillTitle(entity), source: "rule" };
    }
    const compactAction = action.replace(/动态|能力|实践/g, "");
    const compactEntity = action === "精简提示词" && entity === "Claude Code" ? "Claude" : entity;
    if (String(compactEntity).includes("开源") && compactAction.includes("开源")) {
      return { text: validSkillTitle(compactAction), source: "rule" };
    }
    const separator = /[A-Za-z0-9]$/.test(String(compactEntity)) && /^[A-Za-z0-9]/.test(compactAction) ? " " : "";
    return { text: validSkillTitle(`${compactEntity}${separator}${compactAction}`), source: "rule" };
  }
  if (action) return { text: validSkillTitle(action), source: "rule" };
  const semantic = semanticExcerpt(text);
  if (semantic && semantic.toLowerCase() !== String(entity || "").toLowerCase()) {
    return { text: semantic, source: "semantic_excerpt" };
  }
  if (entity) return { text: validSkillTitle(entity), source: "rule" };
  if (matchedKeyword) {
    return { text: validSkillTitle(String(matchedKeyword).replace(/\s+/g, "")), source: "keyword" };
  }
  const words = text.match(/[A-Za-z][A-Za-z0-9+_.-]*/g) || [];
  const english = compactTitle(words.slice(0, 3).join(" "));
  return { text: english || "内容待提炼", source: english ? "semantic_excerpt" : "fallback" };
}

function postSnapshotCount(post, snapshotsByPost) {
  const fromInput = Number(post?.analysis?.velocity?.count || post?.analysis?.input?.snapshotIds?.length || 0);
  return Math.max(fromInput, snapshotsByPost.get(String(post?.id))?.length || 0);
}

function verifiedHeat(post, snapshotCount) {
  if (snapshotCount < 2 || Number(post?.views) <= 0 || Number(post?.likes) <= 0 || publicInteractions(post) <= 0) return null;
  const velocity = post?.analysis?.velocity || {};
  const viewVelocity = Math.max(0, Number(velocity.viewVelocity) || 0);
  const replyVelocity = Math.max(0, Number(velocity.replyVelocity) || 0);
  const growthRatio = Math.max(0, Number(velocity.growthRatio) || 0);
  if (viewVelocity >= 3000 || replyVelocity >= 12 || (growthRatio >= .75 && viewVelocity >= 1000)) return "burst";
  if (viewVelocity >= 500 || replyVelocity >= 3 || (growthRatio >= .2 && viewVelocity >= 100)) return "rising";
  return null;
}

function highHeatCandidate(post, snapshotCount) {
  return snapshotCount < 2 &&
    Number(post?.views) >= 1000 &&
    Number(post?.likes) >= 5 &&
    publicInteractions(post) >= 8;
}

function topicIdsFor(post, trendingKeywords) {
  const postId = String(post?.id);
  return unique([
    ...(post?.topics || []).map(value => `text:${String(value).toLowerCase()}`),
    ...trendingKeywords
      .filter(item => (item.sourcePostIds || []).some(id => String(id) === postId))
      .map(item => item.id)
  ]);
}

function latinTokens(text) {
  return String(text || "").toLowerCase().match(/[a-z][a-z0-9+_.-]{2,}/g) || [];
}

function chineseBigrams(text) {
  const chars = [...String(text || "").replace(/[^\u3400-\u9fff]/gu, "")];
  const result = [];
  for (let index = 0; index < chars.length - 1; index += 1) result.push(`${chars[index]}${chars[index + 1]}`);
  return result;
}

function tokenSet(post) {
  return new Set([...latinTokens(post?.text), ...chineseBigrams(post?.text), ...(post?.topics || []).map(value => String(value).toLowerCase())]);
}

function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.max(2, Math.min(a.size, b.size));
}

function relevance(focus, candidate, focusTopics, candidateTopics, tokensByPost) {
  const focusId = String(focus.id);
  const candidateId = String(candidate.id);
  if (String(focus?.provenance?.rootPostId || "") === candidateId) return { score: 1, evidence: ["mother_post"] };
  if (String(candidate?.provenance?.rootPostId || "") === focusId) return { score: .98, evidence: ["confirmed_source"] };
  if (focus?.provenance?.rootPostId && focus.provenance.rootPostId === candidate?.provenance?.rootPostId) {
    return { score: .94, evidence: ["shared_mother_post"] };
  }
  if ((focus.rootSourceForPostIds || []).some(id => String(id) === candidateId)) {
    return { score: .98, evidence: ["mother_post"] };
  }
  if ((candidate.rootSourceForPostIds || []).some(id => String(id) === focusId)) {
    return { score: .98, evidence: ["confirmed_source"] };
  }
  const sharedTopics = [...focusTopics].filter(id => candidateTopics.has(id)).length;
  const semantic = overlapScore(tokensByPost.get(focusId), tokensByPost.get(candidateId));
  const ageDistance = Math.abs(postTime(focus) - postTime(candidate)) / 3_600_000;
  const timeAffinity = clamp(1 - ageDistance / 72);
  const score = clamp(sharedTopics * .3 + semantic * .58 + timeAffinity * .12);
  const evidence = [];
  if (sharedTopics) evidence.push("shared_topic");
  if (semantic >= .08) evidence.push("semantic_overlap");
  if (timeAffinity >= .7) evidence.push("time_affinity");
  return { score, evidence };
}

function provenanceRole(post, allPostsById) {
  const rootId = String(post?.provenance?.rootPostId || "");
  if ((post?.rootSourceForPostIds || []).length) return "mother";
  if (rootId && allPostsById.has(rootId)) return post?.provenance?.status === "confirmed" ? "derivative" : "inferred_derivative";
  if (post?.provenance?.status === "searching") return "tracing";
  return "direct";
}

function focusPayload(post, snapshotsByPost, trendingKeywords, allPostsById) {
  const snapshotCount = postSnapshotCount(post, snapshotsByPost);
  const heatStatus = verifiedHeat(post, snapshotCount);
  const title = titleFor(post, trendingKeywords);
  return {
    postId: String(post.id),
    author: post.author || post.handle,
    handle: post.handle || "",
    displayTitle: title.text,
    titleSource: title.source,
    heatStatus,
    heatEvidence: {
      viewVelocity: Math.round(Number(post.analysis?.velocity?.viewVelocity) || 0),
      replyVelocity: Number((Number(post.analysis?.velocity?.replyVelocity) || 0).toFixed(1)),
      growthRatio: Number((Number(post.analysis?.velocity?.growthRatio) || 0).toFixed(3)),
      reason: post.analysis?.reasonSummary || post.analysis?.evidence || ""
    },
    snapshotCount,
    views: Number(post.views) || 0,
    likes: Number(post.likes) || 0,
    replies: Number(post.replies) || 0,
    reposts: Number(post.reposts) || 0,
    publishedAt: post.publishedAt || post.capturedAt,
    followed: Boolean(post.followed),
    provenanceRole: provenanceRole(post, allPostsById),
    rootPostId: post.provenance?.rootPostId ? String(post.provenance.rootPostId) : null,
    topicIds: topicIdsFor(post, trendingKeywords),
    url: post.url || post.sourceUrl || ""
  };
}

function focusRank(post) {
  const status = post.heatStatus === "burst" ? 2 : 1;
  const evidence = post.heatEvidence || {};
  return status * 1e12 +
    Math.min(100_000, evidence.viewVelocity || 0) * 1e6 +
    Math.min(1000, evidence.replyVelocity || 0) * 1e3 +
    postTime(post);
}

function resolveTopicFilter(value, trendingKeywords) {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  return trendingKeywords.find(item =>
    String(item.id).toLowerCase() === normalized ||
    String(item.normalizedText || "").toLowerCase() === normalized
  ) || null;
}

function selectFocusPosts(posts, snapshotsByPost, trendingKeywords, allPostsById, config) {
  const limit = config.burstTarget + config.risingTarget;
  const candidates = posts
    .map(post => focusPayload(post, snapshotsByPost, trendingKeywords, allPostsById))
    .filter(post => post.heatStatus)
    .sort((a, b) => focusRank(b) - focusRank(a));
  const authorCounts = new Map();
  const selected = [];
  const selectedIds = new Set();
  const take = (values, target) => {
    for (const post of values) {
      if (selected.length >= target || selected.length >= limit) break;
      const key = handleKey(post);
      if (selectedIds.has(post.postId) || (authorCounts.get(key) || 0) >= 2) continue;
      selected.push(post);
      selectedIds.add(post.postId);
      authorCounts.set(key, (authorCounts.get(key) || 0) + 1);
    }
  };
  take(candidates.filter(post => post.heatStatus === "burst"), config.burstTarget);
  take(candidates.filter(post => post.heatStatus === "rising"), config.burstTarget + config.risingTarget);
  selected.sort((a, b) => focusRank(b) - focusRank(a));
  return selected;
}

function peripheralPayload(post, snapshotsByPost, trendingKeywords, allPostsById) {
  const snapshotCount = postSnapshotCount(post, snapshotsByPost);
  const title = titleFor(post, trendingKeywords);
  return {
    postId: String(post.id),
    author: post.author || post.handle,
    handle: post.handle || "",
    displayTitle: title.text,
    titleSource: title.source,
    provenanceRole: provenanceRole(post, allPostsById),
    rootPostId: post.provenance?.rootPostId ? String(post.provenance.rootPostId) : null,
    snapshotCount,
    publicMetrics: {
      views: Number(post.views) || 0,
      likes: Number(post.likes) || 0,
      replies: Number(post.replies) || 0,
      reposts: Number(post.reposts) || 0
    },
    views: Number(post.views) || 0,
    likes: Number(post.likes) || 0,
    replies: Number(post.replies) || 0,
    reposts: Number(post.reposts) || 0,
    publishedAt: post.publishedAt || post.capturedAt,
    followed: Boolean(post.followed),
    url: post.url || post.sourceUrl || ""
  };
}

function hasPublicEvidence(post) {
  return Number(post?.views) > 0 && Number(post?.likes) > 0 && publicInteractions(post) > 0;
}

function independentSignalEligible(post, snapshotCount) {
  if (!hasPublicEvidence(post)) return false;
  return Boolean(verifiedHeat(post, snapshotCount)) ||
    highHeatCandidate(post, snapshotCount) ||
    (Number(post.views) >= 1000 && Number(post.likes) >= 5 && publicInteractions(post) >= 8);
}

function independentRank(post, snapshotsByPost) {
  const snapshotCount = postSnapshotCount(post, snapshotsByPost);
  const heatStatus = verifiedHeat(post, snapshotCount);
  return Number(heatStatus === "burst") * 2e15 +
    Number(heatStatus === "rising") * 1.5e15 +
    Number(highHeatCandidate(post, snapshotCount)) * 1e15 +
    Math.min(10_000_000, Number(post.views) || 0) * 1e4 +
    Math.min(100_000, publicInteractions(post)) * 1e2 +
    postTime(post);
}

function topicOptions(focusPosts, trendingKeywords) {
  const focusIds = new Set(focusPosts.map(post => post.postId));
  return trendingKeywords
    .map(item => {
      const matched = unique(item.sourcePostIds || []).filter(id => focusIds.has(id));
      return {
        id: item.id,
        label: item.normalizedText,
        focusCount: matched.length,
        postCount: Number(item.postCount24h || item.sourcePostIds?.length || 0)
      };
    })
    .filter(item => item.focusCount > 0)
    .sort((a, b) => b.focusCount - a.focusCount || b.postCount - a.postCount);
}

export function buildHeatMap(posts = [], snapshots = [], options = {}) {
  const window = WINDOWS[options.window] ? options.window : "24h";
  const config = WINDOWS[window];
  const now = Number(options.now || Date.now());
  const cutoff = now - config.hours * 3_600_000;
  const trendingKeywords = options.trendingKeywords || [];
  const topicFilter = resolveTopicFilter(options.topic, trendingKeywords);
  const allPostsById = new Map(posts.map(post => [String(post.id), post]));
  const snapshotsByPost = new Map();
  for (const snapshot of snapshots) {
    const key = String(snapshot.postId);
    if (!snapshotsByPost.has(key)) snapshotsByPost.set(key, []);
    snapshotsByPost.get(key).push(snapshot);
  }

  let inWindow = posts
    .filter(post => postTime(post) >= cutoff && postTime(post) <= now)
    .filter(post => aiIndustryPost(post, trendingKeywords));
  if (topicFilter) {
    const sourceIds = new Set((topicFilter.sourcePostIds || []).map(String));
    const filterText = String(topicFilter.normalizedText || "").toLowerCase();
    inWindow = inWindow.filter(post =>
      sourceIds.has(String(post.id)) ||
      (post.topics || []).some(topic => String(topic).toLowerCase() === filterText) ||
      String(post.text || "").toLowerCase().includes(filterText)
    );
  }

  const focusPosts = selectFocusPosts(inWindow, snapshotsByPost, trendingKeywords, allPostsById, config);
  const focusIds = new Set(focusPosts.map(post => post.postId));
  const tokensByPost = new Map(posts.map(post => [String(post.id), tokenSet(post)]));
  const topicIdsByPost = new Map(posts.map(post => [String(post.id), new Set(topicIdsFor(post, trendingKeywords))]));
  const relatedById = new Map();
  const clusterByKey = new Map();

  for (const focus of focusPosts) {
    const source = allPostsById.get(focus.postId);
    const rootPostId = focus.rootPostId && allPostsById.has(focus.rootPostId) ? focus.rootPostId : null;
    const root = rootPostId ? allPostsById.get(rootPostId) : null;
    const candidates = [...inWindow, ...(root && !inWindow.includes(root) ? [root] : [])]
      .filter(post => String(post.id) !== focus.postId && !focusIds.has(String(post.id)))
      .filter(hasPublicEvidence)
      .map(post => {
        const detail = relevance(
          source,
          post,
          topicIdsByPost.get(focus.postId) || new Set(),
          topicIdsByPost.get(String(post.id)) || new Set(),
          tokensByPost
        );
        return { post, ...detail };
      })
      .filter(item => item.score >= .16 || String(item.post.id) === rootPostId)
      .sort((a, b) => {
        const aRoot = String(a.post.id) === rootPostId ? 1 : 0;
        const bRoot = String(b.post.id) === rootPostId ? 1 : 0;
        return bRoot - aRoot || Number(b.post.followed) - Number(a.post.followed) || b.score - a.score ||
          postTime(b.post) - postTime(a.post);
      })
      .slice(0, config.contextPerFocus);

    for (const { post, score, evidence } of candidates) {
      const postId = String(post.id);
      const snapshotCount = postSnapshotCount(post, snapshotsByPost);
      const overflowHeatStatus = verifiedHeat(post, snapshotCount);
      const existing = relatedById.get(postId);
      const focusPostIds = unique([...(existing?.focusPostIds || []), focus.postId]);
      relatedById.set(postId, {
        ...peripheralPayload(post, snapshotsByPost, trendingKeywords, allPostsById),
        focusPostIds,
        contextStatus: overflowHeatStatus ? "verified_heat_overflow" :
          highHeatCandidate(post, snapshotCount) ? "high_heat_candidate" : "normal",
        overflowHeatStatus,
        relevanceStrength: Math.max(score, Number(existing?.relevanceStrength) || 0),
        relevanceEvidence: unique([...(existing?.relevanceEvidence || []), ...evidence])
      });
    }

    const clusterKey = rootPostId || focus.postId;
    const existingCluster = clusterByKey.get(clusterKey);
    clusterByKey.set(clusterKey, {
      id: `heat-cluster-${clusterKey}`,
      rootPostId,
      focusPostIds: unique([...(existingCluster?.focusPostIds || []), focus.postId]),
      relatedPostIds: unique([...(existingCluster?.relatedPostIds || []), ...candidates.map(item => item.post.id)]),
      topicIds: unique([...(existingCluster?.topicIds || []), ...focus.topicIds])
    });
  }

  const rankedRelatedCandidates = [...relatedById.values()]
    .sort((a, b) =>
      Number(b.followed) - Number(a.followed) ||
      Number(Boolean(b.overflowHeatStatus)) - Number(Boolean(a.overflowHeatStatus)) ||
      Number(b.contextStatus === "high_heat_candidate") - Number(a.contextStatus === "high_heat_candidate") ||
      b.relevanceStrength - a.relevanceStrength ||
      Number(b.views) - Number(a.views) ||
      postTime(b) - postTime(a)
    );
  const relatedCandidateIds = new Set(rankedRelatedCandidates.map(post => post.postId));
  const independentCandidates = inWindow
    .filter(post => !focusIds.has(String(post.id)) && !relatedCandidateIds.has(String(post.id)))
    .filter(post => independentSignalEligible(post, postSnapshotCount(post, snapshotsByPost)))
    .sort((a, b) => independentRank(b, snapshotsByPost) - independentRank(a, snapshotsByPost))
    .map(post => {
      const snapshotCount = postSnapshotCount(post, snapshotsByPost);
      const overflowHeatStatus = verifiedHeat(post, snapshotCount);
      return {
        ...peripheralPayload(post, snapshotsByPost, trendingKeywords, allPostsById),
        focusPostIds: [],
        contextStatus: overflowHeatStatus ? "verified_heat_overflow" :
          highHeatCandidate(post, snapshotCount) ? "high_heat_candidate" : "normal",
        overflowHeatStatus,
        candidateReason: overflowHeatStatus
          ? `已验证${overflowHeatStatus === "burst" ? "爆发" : "升温"}，因焦点容量或同博主上限进入外围`
          : highHeatCandidate(post, snapshotCount)
          ? "单快照高互动，等待复采确认"
          : "公开互动较高，尚未关联焦点帖子"
      };
    });

  const reservedIndependentCount = Math.min(config.independentSignalLimit, independentCandidates.length);
  const relatedCapacity = config.contextLimit - reservedIndependentCount;
  const relatedPosts = rankedRelatedCandidates.slice(0, relatedCapacity);
  const independentCapacity = config.contextLimit - relatedPosts.length;
  const independentSignals = independentCandidates.slice(0, independentCapacity);
  const contextPosts = [
    ...relatedPosts.map(post => ({ ...post, signalType: "related" })),
    ...independentSignals.map(post => ({
      ...post,
      signalType: "independent",
      relevanceStrength: 0,
      relevanceEvidence: []
    }))
  ];
  const retainedRelatedIds = new Set(relatedPosts.map(post => post.postId));
  const clusters = [...clusterByKey.values()].map(cluster => ({
    ...cluster,
    relatedPostIds: cluster.relatedPostIds.filter(id => retainedRelatedIds.has(String(id))),
    contextPostIds: cluster.relatedPostIds.filter(id => retainedRelatedIds.has(String(id)))
  }));
  const candidates = inWindow
    .filter(post => !focusIds.has(String(post.id)))
    .filter(post => highHeatCandidate(post, postSnapshotCount(post, snapshotsByPost)));
  const coverageTimes = inWindow.map(postTime).filter(Boolean).sort((a, b) => a - b);

  return {
    window,
    topic: topicFilter ? { id: topicFilter.id, label: topicFilter.normalizedText } : null,
    calculatedAt: new Date(now).toISOString(),
    standard: {
      totalLimit: config.focusLimit + config.contextLimit,
      focusLimit: config.focusLimit,
      relatedLimit: config.relatedLimit,
      independentSignalLimit: config.independentSignalLimit,
      contextLimit: config.contextLimit,
      focusComposition: { burst: config.burstTarget, rising: config.risingTarget },
      contextPerFocus: config.contextPerFocus,
      perCreatorFocusLimit: 2,
      minimumSnapshotsForHeat: 2,
      risingThresholds: { viewVelocity: 500, replyVelocity: 3, growthRatio: .2, growthViewVelocity: 100 },
      burstThresholds: { viewVelocity: 3000, replyVelocity: 12, growthRatio: .75, growthViewVelocity: 1000 },
      rising: { viewVelocity: 500, replyVelocity: 3, growthRatio: .2 },
      burst: { viewVelocity: 3000, replyVelocity: 12, growthRatio: .75 }
    },
    coverage: {
      requestedHours: config.hours,
      postCount: inWindow.length,
      focusCount: focusPosts.length,
      burstCount: focusPosts.filter(post => post.heatStatus === "burst").length,
      risingCount: focusPosts.filter(post => post.heatStatus === "rising").length,
      relatedCount: relatedPosts.length,
      independentSignalCount: independentSignals.length,
      contextCount: contextPosts.length,
      highHeatCandidateCount: candidates.length,
      actualCoverageStart: coverageTimes.length ? new Date(coverageTimes[0]).toISOString() : null,
      actualCoverageEnd: coverageTimes.length ? new Date(coverageTimes.at(-1)).toISOString() : null
    },
    topics: topicOptions(selectFocusPosts(posts.filter(post => postTime(post) >= cutoff), snapshotsByPost, trendingKeywords, allPostsById, config), trendingKeywords),
    focusPosts,
    relatedPosts,
    independentSignals,
    contextPosts,
    clusters
  };
}
