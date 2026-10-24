const GENERAL_TERMS = [
  "AI", "artificial intelligence", "LLM", "大模型", "生成式人工智能", "多模态", "推理模型", "智能体", "机器学习", "具身智能"
];

const SUBJECT_TERMS = [
  "OpenAI", "ChatGPT", "GPT", "Codex", "Anthropic", "Claude", "Google DeepMind", "Gemini",
  "xAI", "Grok", "Meta AI", "Llama", "Microsoft Copilot", "GitHub Copilot", "DeepSeek",
  "Qwen", "通义千问", "Kimi", "豆包", "GLM", "MiniMax", "Mistral", "Hugging Face", "NVIDIA", "英伟达"
];

const EVENT_TERMS = [
  "发布", "上线", "更新", "升级", "开源", "开放权重", "价格", "降价", "免费", "融资", "收购", "合作",
  "基准测试", "评测", "实测", "故障", "宕机", "安全", "漏洞", "越狱", "泄露", "版权", "监管",
  "launch", "release", "update", "upgrade", "open source", "open weights", "pricing", "benchmark",
  "outage", "security", "vulnerability", "jailbreak", "leak"
];

const DOMAIN_TERMS = [
  "人工智能编程", "智能体工作流", "检索增强生成", "提示词", "上下文工程", "图像生成", "视频生成",
  "语音生成", "语音识别", "机器人", "芯片", "算力", "推理成本", "agent", "agentic", "RAG",
  "prompt", "context engineering", "text to image", "text to video", "speech to text", "robotics", "inference"
];

function nowIso() {
  return new Date().toISOString();
}

export const DEFAULT_MONITORING_RULES = [
  {
    id: "rule-subjects",
    name: "AI 主体与产品",
    category: "subject",
    terms: SUBJECT_TERMS,
    excludedTerms: [],
    platforms: ["x", "douyin"],
    languages: ["zh", "en"],
    priority: "normal",
    enabled: true,
    version: 1
  },
  {
    id: "rule-general",
    name: "AI 通用主题",
    category: "domain",
    terms: GENERAL_TERMS,
    excludedTerms: [],
    platforms: ["x", "douyin"],
    languages: ["zh", "en"],
    priority: "normal",
    enabled: true,
    version: 1
  },
  {
    id: "rule-events",
    name: "发布与突发事件",
    category: "event",
    terms: EVENT_TERMS,
    excludedTerms: [],
    platforms: ["x", "douyin"],
    languages: ["zh", "en"],
    priority: "high",
    enabled: true,
    version: 1
  },
  {
    id: "rule-domains",
    name: "AI 能力与领域",
    category: "domain",
    terms: DOMAIN_TERMS,
    excludedTerms: ["skill"],
    platforms: ["x", "douyin"],
    languages: ["zh", "en"],
    priority: "normal",
    enabled: true,
    version: 1
  }
].map(rule => ({ ...rule, createdAt: nowIso(), updatedAt: nowIso() }));

function normalized(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function includesTerm(text, terms) {
  const content = normalized(text);
  return terms.some(term => content.includes(normalized(term)));
}

export function ensureMonitoringRules(current = []) {
  const existing = new Map(current.map(rule => [rule.id, rule]));
  for (const rule of DEFAULT_MONITORING_RULES) {
    if (!existing.has(rule.id)) existing.set(rule.id, structuredRule(rule));
  }
  return [...existing.values()].map(structuredRule);
}

export function structuredRule(rule) {
  const terms = [...new Set((rule.terms || rule.keywords || []).map(String).map(value => value.trim()).filter(Boolean))];
  const excludedTerms = [...new Set((rule.excludedTerms || rule.excludedKeywords || []).map(String).map(value => value.trim()).filter(Boolean))];
  return {
    id: String(rule.id),
    name: String(rule.name || "未命名规则"),
    category: ["subject", "event", "domain", "exclude"].includes(rule.category) ? rule.category : "domain",
    terms,
    keywords: terms,
    excludedTerms,
    excludedKeywords: excludedTerms,
    platforms: (rule.platforms || (rule.platform ? [rule.platform] : ["x", "douyin"])).filter(value => ["x", "douyin"].includes(value)),
    languages: (rule.languages || ["zh", "en"]).filter(value => ["zh", "en"].includes(value)),
    priority: rule.priority === "high" ? "high" : "normal",
    frequency: rule.priority === "high" ? "15分钟" : "1小时",
    enabled: rule.enabled !== false,
    version: Math.max(1, Number(rule.version) || 1),
    createdAt: rule.createdAt || nowIso(),
    updatedAt: rule.updatedAt || nowIso()
  };
}

export function evaluateAIRelevance(post, rules = []) {
  const text = `${post.text || ""} ${(post.topics || []).join(" ")}`;
  const active = rules.filter(rule => rule.enabled !== false);
  const excluded = active.flatMap(rule => rule.excludedTerms || []);
  if (includesTerm(text, excluded)) return { relevant: false, confidence: 0.92, reason: "命中排除词", matchedRuleIds: [] };
  const subjectRules = active.filter(rule => rule.category === "subject");
  const eventRules = active.filter(rule => rule.category === "event");
  const domainRules = active.filter(rule => rule.category === "domain");
  const matchedSubjects = subjectRules.filter(rule => includesTerm(text, rule.terms));
  const matchedDomains = domainRules.filter(rule => includesTerm(text, rule.terms));
  const matchedEvents = eventRules.filter(rule => includesTerm(text, rule.terms));
  const matchedRuleIds = [...matchedSubjects, ...matchedDomains, ...matchedEvents].map(rule => rule.id);
  if (matchedSubjects.length && (matchedEvents.length || matchedDomains.length)) {
    return { relevant: true, confidence: 0.96, reason: "主体词与事件/领域词同时命中", matchedRuleIds };
  }
  if (matchedSubjects.length || matchedDomains.length) {
    return { relevant: true, confidence: 0.82, reason: "明确命中 AI 主体或领域", matchedRuleIds };
  }
  if (matchedEvents.length) {
    return { relevant: null, confidence: 0.45, reason: "只命中事件词，需要语义复核", matchedRuleIds };
  }
  return { relevant: false, confidence: 0.8, reason: "未命中启用的 AI 监控词", matchedRuleIds: [] };
}

export function monitoringQueries(rules = []) {
  const active = rules.filter(rule => rule.enabled !== false);
  const subjects = active.filter(rule => rule.category === "subject").flatMap(rule => rule.terms);
  const events = active.filter(rule => rule.category === "event").flatMap(rule => rule.terms);
  const domains = active.filter(rule => rule.category === "domain").flatMap(rule => rule.terms);
  const queries = [];
  for (const platform of ["x", "douyin"]) {
    for (const subject of subjects) {
      queries.push({ platform, query: subject, category: "主体追踪", priority: "normal", keywords: [subject] });
      for (const event of events.slice(0, 12)) {
        queries.push({ platform, query: `${subject} ${event}`, category: "事件窄查询", priority: "high", keywords: [subject, event] });
      }
    }
    for (const domain of domains) {
      queries.push({ platform, query: domain, category: "领域追踪", priority: "normal", keywords: [domain] });
    }
  }
  const seen = new Set();
  return queries.filter(item => {
    const key = `${item.platform}:${normalized(item.query)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function upsertRule(rules, input) {
  const next = structuredRule({ ...input, id: input.id || `rule-${Date.now().toString(36)}` });
  const index = rules.findIndex(rule => rule.id === next.id);
  if (index >= 0) {
    next.version = Math.max(Number(rules[index].version || 1) + 1, next.version);
    next.createdAt = rules[index].createdAt;
    next.updatedAt = nowIso();
    rules[index] = next;
  } else {
    rules.unshift(next);
  }
  return next;
}

export { DOMAIN_TERMS, EVENT_TERMS, GENERAL_TERMS, SUBJECT_TERMS };
