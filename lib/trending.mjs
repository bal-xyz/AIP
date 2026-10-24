const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CATEGORIES = new Set(["模型与产品", "技术与能力", "应用场景", "行业趋势", "事件与发布", "争议与风险", "人物与机构"]);
const STOP_WORDS = new Set([
  "the", "this", "that", "with", "from", "your", "have", "will", "just", "into", "about",
  "what", "when", "where", "which", "using", "used", "more", "than", "here", "today",
  "use", "but", "would", "honestly", "yes", "july", "speed", "model", "models", "tool", "tools",
  "open", "new", "release", "update", "github", "google", "twitter", "https", "and", "for", "you", "are", "not",
  "ai", "模型", "工具", "代码", "科技", "智能", "发布", "使用", "更快", "强大", "好用"
]);
const ALIASES = new Map([
  ["codex", "Codex"], ["grok", "Grok"], ["kimi", "Kimi"], ["deepseek", "DeepSeek"], ["fable", "Fable"],
  ["openai", "OpenAI"], ["anthropic", "Anthropic"], ["cerebras", "Cerebras"],
  ["claude", "Claude"], ["hugging face", "Hugging Face"],
  ["claudecode", "Claude Code"], ["claude code", "Claude Code"],
  ["vibecoding", "Vibe Coding"], ["vibe coding", "Vibe Coding"],
  ["code review", "代码审查"], ["代码review", "代码审查"], ["代码 review", "代码审查"],
  ["ai agent", "AI 智能体"], ["ai agents", "AI 智能体"], ["agentic ai", "AI 智能体"],
  ["model context protocol", "MCP"], ["mcp", "MCP"],
  ["gpt 5.6", "GPT-5.6"], ["gpt-5.6", "GPT-5.6"], ["gpt5.6", "GPT-5.6"],
  ["gpt 5.6 sol", "GPT-5.6"], ["gpt-5.6 sol", "GPT-5.6"],
  ["gpt 5.6 terra", "GPT-5.6"], ["gpt-5.6 terra", "GPT-5.6"],
  ["deepseek v4", "DeepSeek V4"], ["kimi k3", "Kimi K3"], ["grok cli", "Grok CLI"],
  ["agent task execution", "Agent 任务交付"], ["智能体任务执行", "Agent 任务交付"],
  ["agent任务执行", "Agent 任务交付"], ["智能体任务交付", "Agent 任务交付"]
]);

const safeTime = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const clamp = value => Math.max(0, Math.min(100, Math.round(value)));
const slug = value => String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48);
const hasHan = value => /[\u3400-\u9fff]/u.test(value);
const hasKana = value => /[\u3040-\u30ff]/u.test(value);

const ENTITY_PATTERNS = [
  { pattern: /\bGPT[-\s]?\d+(?:\.\d+)?(?:\s+(?:Sol|Terra|Pro|Ultra))?\b/gi, category: "模型与产品" },
  { pattern: /\bClaude(?:\s+(?:Code|Opus(?:\s+\d+(?:\.\d+)?)?))?\b/gi, category: "模型与产品" },
  { pattern: /\b(?:Codex(?:\s+CLI)?|OpenCodex|DeepSeek(?:\s+V?\d+(?:\.\d+)?)?|Kimi(?:\s+K?\d+(?:\.\d+)?)?|Grok(?:\s+(?:CLI|\d+(?:\.\d+)?))?|Qwen[-\s]?\d+(?:\.\d+)?|GLM[-\s]?\d+(?:\.\d+)?|Fable(?:\s+\d+(?:\.\d+)?)?)\b/gi, category: "模型与产品" },
  { pattern: /\b(?:OpenAI|Anthropic|Hugging Face|Cerebras|Google DeepMind|Meta AI)\b/gi, category: "人物与机构" }
];

// 这些规则是未接入模型推理时的可解释兜底。Skill 输出的 extractedTopics 始终优先。
const THEME_RULES = [
  { normalizedText: "桌面自动化", category: "技术与能力", kind: "topic", confidence: .92, pattern: /desktop (?:automation|control|actions?)|computer use|桌面自动化|桌面控制|控制(?:电脑|桌面)/i },
  { normalizedText: "浏览器自动化", category: "技术与能力", kind: "topic", confidence: .91, pattern: /browser automation|browser control|浏览器自动化|浏览器控制|内置浏览器/i },
  { normalizedText: "Agent 任务交付", category: "行业趋势", kind: "topic", confidence: .9, pattern: /task delivery|deliver(?:ing)? (?:the )?(?:task|work)|complete (?:an? )?(?:task|workflow)|end[- ]to[- ]end task|任务交付|完成(?:整个|完整)?任务|从.+(?:生成|写代码).+(?:交付|完成)/i },
  { normalizedText: "多模型编排", category: "技术与能力", kind: "topic", confidence: .91, pattern: /multi[- ]model|multiple models|[3-9] models|模型编排|多模型|多个模型|skill chaining|orchestration skills?/i },
  { normalizedText: "模型路由", category: "技术与能力", kind: "topic", confidence: .9, pattern: /model rout(?:e|er|ing)|routing is knowing|route (?:a|the|each) model|模型路由|模型切换|切换(?:不同|各种)?模型/i },
  { normalizedText: "Agent Skill 生态", category: "行业趋势", kind: "topic", confidence: .91, pattern: /agent skills?|skills? ecosystem|SKILL\.md|技能生态|skill 生态|可组合的 Agent Skills?|编排型 Skill/i },
  { normalizedText: "AI 编程智能体", category: "应用场景", kind: "topic", confidence: .88, pattern: /coding agents?|AI coding|agentic coding|编程 Agent|编程智能体|AI 编程/i },
  { normalizedText: "代码审查", category: "应用场景", kind: "topic", confidence: .9, pattern: /code review|review(?:ing)? (?:the )?code|代码\s*Review|代码审查|审查代码/i },
  { normalizedText: "Vibe Coding", category: "应用场景", kind: "topic", confidence: .96, pattern: /vibe[\s-]?coding|氛围编程/i },
  { normalizedText: "AI 工作流", category: "应用场景", kind: "topic", confidence: .84, pattern: /AI workflow|agentic workflow|coding workflow|AI 工作流|agentic 工作流|智能体工作流/i },
  { normalizedText: "模型能力对比", category: "行业趋势", kind: "topic", confidence: .86, pattern: /model comparison|compare(?:d|s|ing)? .{0,25}(?:model|GPT|Claude|Kimi|Grok)|beats? (?:GPT|Claude|Kimi|Grok)|模型对比|能力对比|比.+(?:更强|更好)|谁更强/i },
  { normalizedText: "模型推理成本", category: "行业趋势", kind: "topic", confidence: .91, pattern: /inference cost|cost per token|token cost|推理成本|调用成本|模型成本|账单.+倍数|成本.+(?:降低|砍掉)/i },
  { normalizedText: "AI 产品定价", category: "行业趋势", kind: "topic", confidence: .88, pattern: /pricing|subscription price|price increase|美元\/月|订阅(?:价格|涨价)|产品定价|峰值\/谷值定价/i },
  { normalizedText: "模型越狱与沙箱逃逸", category: "争议与风险", kind: "event", confidence: .96, pattern: /sandbox escape|escaped (?:its )?sandbox|breaking out of .{0,15}sandbox|沙箱逃逸|逃出沙箱|绕过安全护栏|越狱/i },
  { normalizedText: "AI 安全风险", category: "争议与风险", kind: "topic", confidence: .9, pattern: /AI safety|cyber attack|network attack|安全风险|网络攻击|现实基础设施|安全护栏/i },
  { normalizedText: "AI 评测争议", category: "争议与风险", kind: "topic", confidence: .9, pattern: /benchmark.+(?:cheat|hack|answer)|hacked?.+benchmark|测评.+(?:答案|攻击|作弊)|评测.+(?:泄露|争议|作弊)/i },
  { normalizedText: "Agent 可审计性", category: "技术与能力", kind: "topic", confidence: .89, pattern: /audit(?:able|ability)?|evidence package|evidence bundle|可审计|证据包|复盘.+证据|解释.+得出/i },
  { normalizedText: "开源 AI 生态", category: "行业趋势", kind: "topic", confidence: .87, pattern: /open[- ]source (?:AI|model|project)|AI open source|开源(?:AI|模型|项目)|GitHub 飙升/i },
  { normalizedText: "AI 编程质量", category: "争议与风险", kind: "topic", confidence: .86, pattern: /AI.+(?:bug|regression)|generated code.+(?:bug|quality)|代码质量|AI 写的代码 Bug|编程质量|verification loop/i },
  { normalizedText: "AI 编程额度", category: "行业趋势", kind: "topic", confidence: .87, pattern: /rate limits?|weekly limits?|usage.+(?:limit|quota)|额度|用完.+(?:Codex|账号)|不经用/i },
  { normalizedText: "远程 Agent", category: "应用场景", kind: "topic", confidence: .86, pattern: /remote(?:ly)? connect|remote agent|cloud tasks?|手机.+远程|远程连接|云端运行任务/i },
  { normalizedText: "AI 内容同质化", category: "争议与风险", kind: "topic", confidence: .85, pattern: /AI slop|humanize.+prompt|内容同质化|AI 味|去 AI 味/i }
];

// 变化节点必须能回答“什么对象发生了什么变化”。未命中明确变化表达时不生成。
const CHANGE_RULES = [
  {
    normalizedText: "Codex 接入桌面语音协作", subject: "Codex", changeType: "能力升级", category: "技术与能力", confidence: .94,
    previousState: "主要通过文字输入分派和调整任务", currentState: "可在桌面端通过语音协调 Codex 与多个 Agent",
    pattern: /ChatGPT Voice.{0,100}(?:desktop|Work|Codex)|(?:voice|语音).{0,100}(?:Codex|computer|多个?\s*Agent|multiple agents)|Codex.{0,100}(?:voice|语音)|实时语音模式/i
  },
  {
    normalizedText: "Codex 增强长期项目管理", subject: "Codex", changeType: "产品升级", category: "事件与发布", confidence: .93,
    previousState: "任务上下文更偏向单次会话和短周期执行", currentState: "计划、项目和评审上下文开始跨天持续保存",
    pattern: /Codex.{0,140}(?:remember(?:s|ed)? (?:your )?plan|project manager|context for days|projects?.{0,40}organized|长期项目|项目经理|记住.{0,30}计划)|new Codex remembers your plan/i
  },
  {
    normalizedText: "编程 Agent 转向多模型协作", subject: "AI 编程 Agent", changeType: "工作流变化", category: "行业趋势", confidence: .91,
    previousState: "单个 Agent 或单一模型独立完成任务", currentState: "多个模型按规划、执行和审查角色协同工作",
    pattern: /(?:Codex|Claude|coding agents?).{0,150}(?:multi[- ]model|multiple agents?|subagents?|orchestrat|co-ordinator|coordinator|role-agent|多个模型|多模型|子代理|协作)|(?:multi[- ]model|multiple agents?|subagents?|orchestrat|多个模型|多模型|子代理).{0,150}(?:Codex|Claude|coding agents?)/i
  },
  {
    normalizedText: "AI Agent 从聊天转向任务交付", subject: "AI Agent", changeType: "能力迁移", category: "行业趋势", confidence: .92,
    previousState: "以聊天、建议或生成单项内容为主", currentState: "开始执行部署、文档、表格和跨应用完整任务",
    pattern: /does the work.{0,30}not just the chat|finish(?:es)? the job|whole deploy pipeline|complete (?:the )?(?:task|workflow)|任务交付|完成(?:整个|完整)?任务|从.{0,40}(?:聊天|生成).{0,40}(?:执行|交付|完成)/i
  },
  {
    normalizedText: "GPT-5.6 推理速度提升至 750 t/s", subject: "GPT-5.6", changeType: "性能升级", category: "事件与发布", confidence: .97,
    previousState: "前沿模型推理速度受常规算力部署限制", currentState: "Cerebras 部署信号显示输出速度提升至约 750 tokens/s",
    pattern: /GPT[-\s]?5\.6.{0,140}(?:750\s*(?:t\/s|tokens? per second)|10x faster|accelerated 10x|Cerebras)|(?:750\s*(?:t\/s|tokens? per second)|Cerebras).{0,100}GPT[-\s]?5\.6/i
  },
  {
    normalizedText: "前沿模型进入低成本竞争", subject: "前沿模型", changeType: "定价变化", category: "行业趋势", confidence: .9,
    previousState: "前沿能力通常与较高推理价格绑定", currentState: "Kimi、Fable 等模型以更低成本逼近头部能力",
    pattern: /(?:Kimi|Fable|GPT[-\s]?5\.6|Claude).{0,160}(?:20x|lower cost|cost floor|\$0\.0\d|much lower cost|pricing|价格|成本)|(?:20x|lower cost|cost floor|\$0\.0\d|价格|成本).{0,120}(?:Kimi|Fable|GPT[-\s]?5\.6|Claude)/i
  },
  {
    normalizedText: "视频生成接入编程 Agent", subject: "AI 视频工作流", changeType: "应用扩展", category: "应用场景", confidence: .9,
    previousState: "视频和动效生成依赖独立工具与手工切换", currentState: "Codex 与 Claude Code 开始直接调用视频、动效生成能力",
    pattern: /(?:Seedance|video generation|视频生成|动效|Higgsfield).{0,140}(?:Claude Code|Codex)|(?:Claude Code|Codex).{0,140}(?:Seedance|video generation|视频生成|动效|Higgsfield)/i
  },
  {
    normalizedText: "Vibe Coding 转向安全审查", subject: "Vibe Coding", changeType: "风险升温", category: "争议与风险", confidence: .92,
    previousState: "关注快速生成原型和交付速度", currentState: "讨论重点转向生产环境的安全、架构和人工审查",
    pattern: /vibe coding.{0,180}(?:security|production|review|auth flaw|API key|architecture|安全|审查|生产环境)|(?:AI-written|AI-generated).{0,100}(?:security|review|vulnerability|质量|审查|漏洞)/i
  },
  {
    normalizedText: "企业扩大 AI 编程采用", subject: "企业 AI 编程", changeType: "采用扩散", category: "行业趋势", confidence: .91,
    previousState: "AI 编程主要由个人开发者和小团队试用", currentState: "大型企业开始在数万名员工范围内部署 AI 编程工具",
    pattern: /(?:\d{4,}|thousands? of)\s+(?:employees?|developers?).{0,80}(?:coding with AI|AI coding)|企业.{0,80}(?:扩大|普及|部署).{0,50}AI 编程|员工.{0,60}(?:Claude|Codex).{0,40}(?:采用|使用|部署)/i
  },
  {
    normalizedText: "编程 Agent 扩展工具调用", subject: "AI 编程 Agent", changeType: "生态扩展", category: "技术与能力", confidence: .88,
    previousState: "主要在代码仓库和终端内完成任务", currentState: "通过 MCP 与 Skills 调用图像、文档和外部应用能力",
    pattern: /(?:MCP|SKILL\.md|skills? ecosystem).{0,140}(?:Codex|Claude|coding agent)|(?:Codex|Claude|coding agent).{0,140}(?:MCP|SKILL\.md|tool calls?|external apps?)/i
  }
];

export function normalizeTerm(value) {
  const trimmed = String(value || "").replace(/^#/, "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const key = trimmed.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const gpt = key.match(/^gpt[- ]?(\d+(?:\.\d+)?)(?:\s+(?:sol|terra|pro|ultra))?$/);
  if (gpt) return `GPT-${gpt[1]}`;
  if (/^codex cli$/i.test(trimmed)) return "Codex";
  return ALIASES.get(key) || trimmed;
}

export function detectPostLanguage(text) {
  const value = String(text || "");
  if (hasKana(value)) return "other";
  if (hasHan(value)) return "zh";
  if (/[A-Za-z]/.test(value)) return "en";
  return "other";
}

function cleanCandidate(candidate, postId) {
  const normalizedText = normalizeTerm(candidate.normalizedText || candidate.originalText);
  const confidence = Number(candidate.confidence);
  if (!normalizedText || normalizedText.length > 40 || STOP_WORDS.has(normalizedText.toLowerCase()) || !Number.isFinite(confidence) || confidence < .75) return null;
  const category = CATEGORIES.has(candidate.category) ? candidate.category : "行业趋势";
  const kind = ["entity", "topic", "event"].includes(candidate.kind) ? candidate.kind : "topic";
  const originalText = String(candidate.originalText || normalizedText).trim().slice(0, 160);
  return {
    sourcePostId: postId,
    normalizedText,
    originalText,
    kind,
    category,
    aliases: [...new Set([...(candidate.aliases || []), originalText].filter(Boolean).map(value => String(value).trim().slice(0, 160)))],
    parentTopic: candidate.parentTopic || (normalizedText !== originalText ? normalizedText : null),
    confidence: Number(Math.min(.99, confidence).toFixed(2))
  };
}

function cleanChangeCandidate(candidate, postId) {
  const normalizedText = String(candidate.normalizedText || candidate.changeSummary || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const confidence = Number(candidate.confidence);
  if (!normalizedText || !Number.isFinite(confidence) || confidence < .75) return null;
  return {
    sourcePostId: postId,
    normalizedText,
    originalText: String(candidate.originalText || candidate.evidenceText || normalizedText).trim().slice(0, 240),
    kind: "event",
    category: CATEGORIES.has(candidate.category) ? candidate.category : "事件与发布",
    subject: String(candidate.subject || candidate.parentTopic || "AI 行业").trim().slice(0, 60),
    changeType: String(candidate.changeType || "行业变化").trim().slice(0, 40),
    changeSummary: String(candidate.changeSummary || normalizedText).trim().slice(0, 160),
    previousState: candidate.previousState ? String(candidate.previousState).trim().slice(0, 240) : null,
    currentState: candidate.currentState ? String(candidate.currentState).trim().slice(0, 240) : null,
    aliases: [...new Set([...(candidate.aliases || []), normalizedText].filter(Boolean).map(value => String(value).trim().slice(0, 160)))],
    parentTopic: String(candidate.parentTopic || candidate.subject || "").trim().slice(0, 60) || null,
    confidence: Number(Math.min(.99, confidence).toFixed(2))
  };
}

function entityHasIndustryContext(originalText, text) {
  if (/\d|Claude Code|Codex CLI|Grok CLI|OpenCodex|DeepSeek\s+V|Kimi\s+K/i.test(originalText)) return true;
  const directMention = new RegExp(`@${String(originalText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  const strongContext = /\b(?:AI|LLM|model|coding|code|agent|API|prompt|token|workflow|benchmark|sandbox|inference|reasoning|developer)\b|模型|编程|智能体|工作流|推理|评测|沙箱|开发者|代码|提示词/i.test(text);
  if (directMention) return strongContext;
  return strongContext || /发布|更新|上线|教程|案例|\b(?:launch|release|update|guide|review)\b/i.test(text);
}

export function extractTopicCandidates(post) {
  const text = String(post.text || "");
  const supplied = Array.isArray(post.extractedTopics) ? post.extractedTopics : [];
  const candidates = new Map();
  const add = raw => {
    const candidate = cleanCandidate(raw, post.id);
    if (!candidate) return;
    const key = `${candidate.kind}:${candidate.normalizedText.toLowerCase()}`;
    const current = candidates.get(key);
    if (!current || candidate.confidence > current.confidence) candidates.set(key, candidate);
    else current.aliases = [...new Set([...current.aliases, ...candidate.aliases])];
  };

  for (const raw of supplied) add(raw);
  if (!supplied.length) {
    for (const rule of ENTITY_PATTERNS) {
      for (const match of text.matchAll(rule.pattern)) {
        const originalText = match[0];
        if (rule.category === "模型与产品" && !entityHasIndustryContext(originalText, text)) continue;
        add({
          normalizedText: normalizeTerm(originalText),
          originalText,
          kind: "entity",
          category: rule.category,
          aliases: [originalText],
          confidence: .94
        });
      }
    }
    for (const rule of THEME_RULES) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      add({ ...rule, originalText: match[0], aliases: [match[0]] });
    }
  }

  const all = [...candidates.values()].sort((a, b) => b.confidence - a.confidence);
  return [
    ...all.filter(item => item.kind === "entity").slice(0, 2),
    ...all.filter(item => item.kind !== "entity").slice(0, 3)
  ];
}

export function extractChangeCandidates(post) {
  const text = String(post.text || "");
  const supplied = Array.isArray(post.extractedChanges) ? post.extractedChanges : [];
  const legacyTopics = Array.isArray(post.extractedTopics) ? post.extractedTopics : [];
  const candidates = new Map();
  const add = raw => {
    const candidate = cleanChangeCandidate(raw, post.id);
    if (!candidate) return;
    const key = candidate.normalizedText.toLowerCase();
    const current = candidates.get(key);
    if (!current || candidate.confidence > current.confidence) candidates.set(key, candidate);
  };
  if (supplied.length) {
    for (const raw of supplied) add(raw);
  } else if (legacyTopics.length) {
    // 兼容已有结构化测试与旧 Skill；生产采集未提供 extractedTopics 时不会走此分支。
    for (const raw of legacyTopics) add({
      ...raw,
      subject: raw.subject || raw.parentTopic || raw.normalizedText,
      changeType: raw.changeType || (raw.kind === "entity" ? "实体信号" : "议题变化"),
      changeSummary: raw.changeSummary || raw.normalizedText
    });
  } else {
    for (const rule of CHANGE_RULES) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      add({ ...rule, originalText: match[0], evidenceText: match[0], changeSummary: rule.normalizedText });
    }
  }
  return [...candidates.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 4);
}

export function extractCandidateTerms(post) {
  return extractTopicCandidates(post).map(item => item.normalizedText);
}

function freshnessScore(lastSeenAt, now) {
  const age = Math.max(0, now - safeTime(lastSeenAt));
  if (age <= .5 * HOUR) return 100;
  if (age <= 2 * HOUR) return 70;
  if (age <= 6 * HOUR) return 40;
  return 10;
}

export function buildTrendingKeywords(posts, industries = [], previous = [], options = {}) {
  const now = options.now ? safeTime(options.now) : Date.now();
  const extractorSkillId = options.extractorSkillId || "extract-trending-keywords";
  const excluded = new Set(industries.flatMap(item => item.excludedKeywords || []).map(item => String(item).toLowerCase()));
  const recentPosts = posts.filter(post => {
    const time = safeTime(post.publishedAt || post.capturedAt);
    return post.id && time > 0 && now - time <= DAY && now >= time;
  });
  const buckets = new Map();
  for (const post of recentPosts) {
    for (const candidate of extractTopicCandidates(post)) {
      if (excluded.has(candidate.normalizedText.toLowerCase())) continue;
      const key = candidate.normalizedText.toLowerCase();
      if (!buckets.has(key)) {
        buckets.set(key, {
          normalizedText: candidate.normalizedText,
          aliases: new Set(),
          originalTexts: new Set(),
          posts: new Map(),
          candidates: new Map(),
          category: candidate.category,
          kind: candidate.kind,
          parentTopic: candidate.parentTopic
        });
      }
      const bucket = buckets.get(key);
      for (const alias of candidate.aliases) bucket.aliases.add(alias);
      bucket.aliases.add(candidate.normalizedText);
      bucket.originalTexts.add(candidate.originalText);
      bucket.posts.set(post.id, post);
      bucket.candidates.set(post.id, candidate);
    }
  }
  const old = new Map(previous.map(item => [String(item.normalizedText || "").toLowerCase(), item]));
  const calculatedAt = new Date(now).toISOString();
  const results = [];
  for (const [key, bucket] of buckets) {
    const matched = [...bucket.posts.values()];
    const creators = new Set(matched.map(post => String(post.handle || "").toLowerCase()).filter(Boolean));
    const current = matched.filter(post => now - safeTime(post.publishedAt || post.capturedAt) <= 2 * HOUR);
    const previousWindow = matched.filter(post => {
      const age = now - safeTime(post.publishedAt || post.capturedAt);
      return age > 2 * HOUR && age <= DAY;
    });
    const recentRate = current.length / 2;
    const baselineRate = previousWindow.length / 22;
    const momentumRatio = baselineRate ? recentRate / baselineRate : current.length >= 3 ? 4 : current.length ? 2 : 0;
    const risingPostCount = matched.filter(post => post.analysis?.level === "升温").length;
    const burstPostCount = matched.filter(post => post.analysis?.level === "爆发").length;
    const lastSeenAt = matched.map(post => post.publishedAt || post.capturedAt).sort().at(-1);
    const firstSeenAt = matched.map(post => post.publishedAt || post.capturedAt).sort()[0];
    const sourceLanguageBreakdown = matched.reduce((counts, post) => {
      const language = detectPostLanguage(post.text);
      counts[language] = (counts[language] || 0) + 1;
      return counts;
    }, { zh: 0, en: 0, other: 0 });
    const signalOrigin = sourceLanguageBreakdown.zh && sourceLanguageBreakdown.en
      ? "中英同步"
      : sourceLanguageBreakdown.en ? "海外信号" : sourceLanguageBreakdown.zh ? "中文圈" : "多语种";
    const extractionConfidence = bucket.candidates.size
      ? [...bucket.candidates.values()].reduce((sum, item) => sum + item.confidence, 0) / bucket.candidates.size
      : 0;
    const scoreBreakdown = {
      coverage: clamp(matched.length / 10 * 100),
      creatorDiversity: clamp(creators.size / 6 * 100),
      momentum: clamp(momentumRatio / 4 * 100),
      hotPostStrength: clamp((risingPostCount + burstPostCount * 2) / 6 * 100),
      freshness: freshnessScore(lastSeenAt, now)
    };
    const score = clamp(
      scoreBreakdown.coverage * .25 +
      scoreBreakdown.creatorDiversity * .2 +
      scoreBreakdown.momentum * .25 +
      scoreBreakdown.hotPostStrength * .2 +
      scoreBreakdown.freshness * .1
    );
    const qualifies = matched.length >= 3 && creators.size >= 2 && extractionConfidence >= .75 && (risingPostCount + burstPostCount > 0 || momentumRatio >= 2);
    const prior = old.get(key);
    let status = score >= 80 && burstPostCount > 0 && qualifies ? "burst" : score >= 60 && qualifies ? "active" : score >= 40 && qualifies ? "emerging" : "observing";
    const coolingStreak = prior && ["active", "burst", "cooling"].includes(prior.status) && score < prior.score ? (prior.coolingStreak || 0) + 1 : 0;
    if (coolingStreak === 1 && ["active", "burst"].includes(prior?.status) && !["active", "burst"].includes(status)) status = prior.status;
    if (coolingStreak >= 2 && ["active", "burst", "cooling"].includes(prior?.status)) status = "cooling";
    results.push({
      id: prior?.id || `trend-${slug(bucket.normalizedText)}`,
      normalizedText: bucket.normalizedText,
      aliases: [...bucket.aliases],
      originalTexts: [...bucket.originalTexts],
      kind: bucket.kind,
      category: bucket.category,
      parentTopic: bucket.parentTopic || null,
      status,
      score,
      scoreBreakdown,
      postCount24h: matched.length,
      creatorCount24h: creators.size,
      postCount2h: current.length,
      momentumRatio: Number(momentumRatio.toFixed(2)),
      risingPostCount,
      burstPostCount,
      firstSeenAt,
      lastSeenAt,
      sourcePostIds: matched.map(post => post.id),
      sourceLanguageBreakdown,
      signalOrigin,
      confidence: Number(extractionConfidence.toFixed(2)),
      extractorSkillId,
      extractorSkillVersion: options.extractorSkillVersion || null,
      promptVersion: options.promptVersion || null,
      coolingStreak,
      calculatedAt,
      window: { start: new Date(now - DAY).toISOString(), end: calculatedAt, momentumHours: 2 }
    });
  }
  for (const prior of previous) {
    if (!results.some(item => item.id === prior.id) && ["active", "burst", "cooling"].includes(prior.status)) {
      const coolingStreak = (prior.coolingStreak || 0) + 1;
      results.push({ ...prior, status: coolingStreak >= 2 ? "cooling" : prior.status, score: 0, coolingStreak, calculatedAt });
    }
  }
  return results.sort((a, b) => b.score - a.score || b.postCount24h - a.postCount24h);
}

export function selectHomepageKeywords(keywords, limit = 8) {
  const caps = { "模型与产品": 3, "技术与能力": 2, "应用场景": 2 };
  const counts = {};
  const selected = [];
  const eligible = [...(keywords || [])]
    .filter(item => ["active", "burst"].includes(item.status) && Number(item.score || 0) >= 60 && Number(item.confidence || 0) >= .75)
    .sort((a, b) => b.score - a.score || b.postCount24h - a.postCount24h);
  for (const item of eligible) {
    const cap = caps[item.category] ?? Infinity;
    if ((counts[item.category] || 0) >= cap) continue;
    selected.push(item);
    counts[item.category] = (counts[item.category] || 0) + 1;
    if (selected.length >= limit) break;
  }
  return selected;
}

export function enqueueTrendingJobs(state, makeId, now = Date.now()) {
  for (const keyword of state.trendingKeywords || []) {
    if (!["active", "burst"].includes(keyword.status) || keyword.score < 70 || keyword.creatorCount24h < 3) continue;
    for (const platform of ["x", "douyin"]) {
      const active = state.jobs.some(job => job.targetType === "trend" && job.trendingKeywordId === keyword.id && (job.platform || "x") === platform && ["queued", "running"].includes(job.status));
      const latest = state.jobs.filter(job => job.targetType === "trend" && job.trendingKeywordId === keyword.id && (job.platform || "x") === platform).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
      if (active || (latest && now - safeTime(latest.requestedAt) < 15 * 60_000)) continue;
      const industry = state.industries[0];
      enqueueCollectionJob(state.jobs, {
      id: makeId("job"),
      targetType: "trend",
      targetId: industry?.id || "ai-industry",
      industry: industry?.name || "AI",
      trendingKeywordId: keyword.id,
      queryCategory: "热门追踪",
      keywords: [keyword.normalizedText, ...(keyword.aliases || []).slice(0, 2)],
      query: platform === "x" ? `"${keyword.normalizedText}" (launch OR update OR guide OR review OR 发布 OR 教程)` : keyword.normalizedText,
      platform,
      language: industry?.language || "中英双语",
      reason: `热门分数 ${keyword.score}，覆盖 ${keyword.creatorCount24h} 个作者`,
      expiresAt: new Date(now + 72 * HOUR).toISOString(),
      status: "queued",
      requestedAt: new Date(now).toISOString(),
      attempts: 0
      });
    }
  }
}
import { enqueueCollectionJob } from "./job-leases.mjs";
