const numberWords = /\b\d+\b|\d+[个条步种款倍%％]/;
const tutorialWords = /教程|保姆级|步骤|实操|从0|工作流|操作指南|使用指南|how[\s-]?to|tutorial|step[\s-]?by[\s-]?step/i;
const listWords = /清单|盘点|合集|汇总|以下|这[0-9一二三四五六七八九十]+|top\s?\d+|features?|包括|分别|推荐这/i;
const firstPersonWords = /(?:^|[，。！？；\s])(?:我|我们|本人|自己)(?:[在用从曾做把的，。！？；\s]|$)/i;
const experienceWords = /我用|我在|我从|我曾|亲自|实测|踩坑|复盘|体验|第一次|经历|故事/i;
const opinionWords = /最强|最好|不如|胜过|甘拜下风|我认为|我觉得|结论|本质|意味着|必须|不要|应该|取代|看好|真正|根本|bullish/i;
const itemMarker = /(?:^|\n)\s*(?:\d{1,2}[.)、：:]|[一二三四五六七八九十]+[、.）)]|[-•▪●])\s*/gim;
const stepMarker = /第[一二三四五六七八九十\d]+步|step\s*\d+|首先|然后|接着|随后|下一步|最后|最终/gi;
const instructionWords = /打开|点击|选择|输入|复制|粘贴|安装|配置|运行|执行|进入|创建|添加|上传|下载|保存|切换|调用|注册|登录/g;
const temporalWords = /去年|今年|后来|当时|起初|开始时|之后|随后|直到|最终|最后|前段时间|几天后|小时后|从.+到/gi;
const storyOutcomeWords = /终于|没想到|结果|意识到|发现|决定|成功|失败|辞职|转型|赚到|失去|改变|自由|踩坑|教训/g;
const argumentWords = /因为|所以|但|但是|然而|反而|相比|相较|原因|问题在于|关键是|这说明|这意味着|换句话说/g;
const questionClaim = /为什么|凭什么|是否|到底|还能不能|会不会|怎么可能|[？?]/;
const shapeDefinitions = {
  故事: "有明确主体，并形成时间推进、经历变化与结果转折的叙事弧",
  列表: "至少三个可独立阅读的并列条目，或明确清单承诺加并列结构",
  观点: "围绕一个判断进行解释、比较、质疑或论证",
  教程: "按先后依赖关系给出可执行动作，读者能够跟随完成结果"
};

const quote = value => /\s/.test(value) ? `"${value}"` : value;
const safeDate = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const matchCount = (text, pattern) => (String(text).match(pattern) || []).length;
const boundedConfidence = (top, second) => {
  if (top <= 1) return .45;
  return Math.min(.96, Math.max(.56, .58 + (top - second) * .075 + Math.min(.18, top * .018)));
};

export function contentShape(post) {
  const text = String(post.text || "").trim();
  const itemCount = matchCount(text, itemMarker);
  const stepCount = matchCount(text, stepMarker);
  const instructionCount = matchCount(text, instructionWords);
  const temporalCount = matchCount(text, temporalWords);
  const outcomeCount = matchCount(text, storyOutcomeWords);
  const argumentCount = matchCount(text, argumentWords);
  const firstPerson = firstPersonWords.test(text);
  const experiential = experienceWords.test(text);
  const explicitTutorial = tutorialWords.test(text);
  const explicitList = listWords.test(text);
  const explicitOpinion = opinionWords.test(text);
  const hasOrderedOutcome = /完成|实现|搭建|生成|做出|解决|部署|学会|复刻/.test(text);
  const parallelSeparators = matchCount(text, /[；;]|(?:^|\n)\s*[①②③④⑤⑥⑦⑧⑨⑩]/gm);
  const enumerationSeparators = matchCount(text, /、/g);
  const declaredSteps = /\d+\s*步|[一二三四五六七八九十]+\s*步/i.test(text);
  const tutorialStructure = instructionCount >= 2 && stepCount >= 1 ||
    explicitTutorial && (declaredSteps || instructionCount >= 2);
  const listStructure = itemCount >= 3 ||
    explicitList && (itemCount >= 2 || parallelSeparators >= 2 || enumerationSeparators >= 2);
  const narrativeArc = (firstPerson || experiential) && temporalCount >= 1 && outcomeCount >= 1;

  const scores = {
    教程: Number(tutorialStructure) * 5 +
      Math.min(2.4, stepCount * .8) +
      Math.min(2.4, instructionCount * .6) +
      Number(tutorialStructure && hasOrderedOutcome) * 1.2,
    列表: Number(listStructure) * 5 +
      Math.min(3.6, itemCount * .9) +
      Math.min(1.8, (parallelSeparators + enumerationSeparators) * .35),
    故事: Number(narrativeArc) * 5 +
      Number(firstPerson && experiential) * 1.2 +
      Math.min(2.4, temporalCount * .8) +
      Math.min(2.1, outcomeCount * .7),
    观点: Number(explicitOpinion) * 3.4 +
      Math.min(3.2, argumentCount * .8) +
      Number(questionClaim.test(text)) * 2 +
      Number(/更|最|不如|超过|取代|领先|落后|风险|泡沫|机会/.test(text)) * 1.2
  };

  // A numbered tutorial is defined by dependent actions, not merely by a
  // numbered list. Conversely, a tool/resource roundup remains a list even
  // when it contains recommendations.
  if (tutorialStructure) scores.教程 += 1.8;
  if (listStructure && !tutorialStructure) scores.列表 += 1.8;
  if (narrativeArc) scores.故事 += 2;
  if (explicitTutorial && listStructure && !tutorialStructure) scores.列表 += 1.2;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || (
    ["教程", "列表", "故事", "观点"].indexOf(a[0]) - ["教程", "列表", "故事", "观点"].indexOf(b[0])
  ));
  const type = ranked[0][1] > 0 ? ranked[0][0] : "观点";
  const confidence = boundedConfidence(ranked[0][1], ranked[1]?.[1] || 0);
  const media = post.mediaType === "video" ? "视频" : post.mediaType === "image" ? "图文" : "纯文字";
  const structuralSignal = {
    故事: "时间线叙事",
    列表: "并列条目",
    观点: "判断论证",
    教程: "步骤流程"
  }[type];
  const signals = [
    type === "教程" && explicitTutorial ? "明确教学承诺" : "",
    type === "教程" && tutorialStructure ? `${instructionCount || "多"} 个连续操作动作` : "",
    type === "列表" && listStructure ? `${Math.max(itemCount, enumerationSeparators + 1)} 个并列条目` : "",
    type === "故事" && (firstPerson || experiential) ? "明确叙事主体" : "",
    type === "故事" && temporalCount ? "时间推进" : "",
    type === "故事" && outcomeCount ? "结果或转折" : "",
    type === "观点" && explicitOpinion ? "明确判断" : "",
    type === "观点" && (argumentCount || questionClaim.test(text)) ? "争议或论证" : ""
  ].filter(Boolean);
  const structure = [
    structuralSignal,
    numberWords.test(text) ? "数字钩子" : "",
    text.length > 180 ? "长内容" : "短内容",
    post.hasLink ? "外链" : ""
  ].filter(Boolean);
  return {
    type,
    label: `${type}型`,
    definition: shapeDefinitions[type],
    confidence: Number(confidence.toFixed(2)),
    scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Number(value.toFixed(1))])),
    signals,
    media,
    structure
  };
}

function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function deltaRate(current, previous, hours) {
  if (!previous || hours <= 0) return 0;
  return Math.max(0, (Number(current) - Number(previous)) / hours);
}

function snapshotEvidence(post, snapshots) {
  const history = snapshots
    .filter(item => item.postId === post.id)
    .sort((a, b) => safeDate(a.capturedAt) - safeDate(b.capturedAt));
  if (history.length < 2) return { count: history.length, viewVelocity: 0, replyVelocity: 0, growthRatio: 0, slowing: false };
  const current = history.at(-1);
  const previous = history.at(-2);
  const hours = Math.max((safeDate(current.capturedAt) - safeDate(previous.capturedAt)) / 3_600_000, 1 / 60);
  const viewVelocity = deltaRate(current.views, previous.views, hours);
  const replyVelocity = deltaRate(current.replies, previous.replies, hours);
  const growthRatio = Number(previous.views) ? Math.max(0, (Number(current.views) - Number(previous.views)) / Number(previous.views)) : 0;
  let slowing = false;
  if (history.length >= 3) {
    const before = history.at(-3);
    const beforeHours = Math.max((safeDate(previous.capturedAt) - safeDate(before.capturedAt)) / 3_600_000, 1 / 60);
    slowing = viewVelocity < deltaRate(previous.views, before.views, beforeHours) * .45;
  }
  return { count: history.length, viewVelocity, replyVelocity, growthRatio, slowing };
}

function topicsFor(post, industries) {
  const text = String(post.text || "").toLowerCase();
  const keywords = industries.flatMap(industry => industry.keywords || []);
  const traced = post.discovery?.keywords || [];
  return [...new Set([...traced, ...keywords].filter(word => text.includes(String(word).toLowerCase())))].slice(0, 2);
}

export function analyzePosts(posts, snapshots = [], industries = [], creators = []) {
  const byHandle = new Map();
  for (const post of posts) {
    const key = String(post.handle || "").toLowerCase();
    if (!byHandle.has(key)) byHandle.set(key, []);
    byHandle.get(key).push(post);
  }
  const followed = new Set(creators.filter(item => item.status === "followed" || !item.status).map(item => String(item.handle || "").toLowerCase()));

  return posts.map(post => {
    const peers = byHandle.get(String(post.handle || "").toLowerCase()) || [];
    const baseline = median(peers.map(item => Number(item.views) || 0));
    const views = Number(post.views) || 0;
    const replies = Number(post.replies) || 0;
    const reposts = Number(post.reposts) || 0;
    const likes = Number(post.likes) || 0;
    const bookmarks = Number(post.bookmarks) || 0;
    const total = replies + reposts + likes + bookmarks;
    const ratios = {
      interaction: views ? total / views : 0,
      reply: views ? replies / views : 0,
      repost: views ? reposts / views : 0,
      like: views ? likes / views : 0,
      bookmark: views ? bookmarks / views : 0,
      reachMultiple: baseline ? views / baseline : 0
    };
    const velocity = snapshotEvidence(post, snapshots);
    const enoughReachData = peers.length >= 3 && views >= 1000;
    const rising = velocity.viewVelocity >= 500 || velocity.replyVelocity >= 3 || (enoughReachData && ratios.reachMultiple >= 1.5) || (views >= 1000 && ratios.interaction >= .02);
    const burst = velocity.viewVelocity >= 3000 || velocity.replyVelocity >= 12 || (enoughReachData && ratios.reachMultiple >= 3);
    const cooling = velocity.count >= 3 && velocity.slowing && !burst;
    const heat = cooling ? "冷却" : burst ? "爆发" : rising ? "升温" : "普通";
    const reasons = [];
    if (velocity.count >= 2) reasons.push(`最近每小时新增 ${Math.round(velocity.viewVelocity).toLocaleString("zh-CN")} 曝光、${velocity.replyVelocity.toFixed(1)} 回复`);
    if (enoughReachData && ratios.reachMultiple >= 1.5) reasons.push(`曝光是该博主近期中位数的 ${ratios.reachMultiple.toFixed(1)} 倍`);
    if (post.bookmarksAvailable && ratios.bookmark >= .005) reasons.push(`收藏率 ${(ratios.bookmark * 100).toFixed(2)}%，实用价值强`);
    if (ratios.repost >= .0025) reasons.push(`转发率 ${(ratios.repost * 100).toFixed(2)}%，具备传播价值`);
    if (ratios.reply >= .0015) reasons.push(`回复率 ${(ratios.reply * 100).toFixed(2)}%，触发讨论`);
    if (tutorialWords.test(post.text || "")) reasons.push("内容提供可执行的方法或步骤");
    if (numberWords.test(post.text || "")) reasons.push("数字信息降低理解成本");
    if (!reasons.length) reasons.push(velocity.count < 2 ? "只有一个指标快照，暂不推测增长趋势" : "互动尚未显著高于该博主近期基线");
    const publishedAgeHours = Math.max(0, (Date.now() - safeDate(post.publishedAt || post.capturedAt)) / 3_600_000);
    const recency = Math.max(0, 100 - Math.min(publishedAgeHours, 168) / 1.68);
    const scoreBreakdown = {
      relevance: topicsFor(post, industries).length ? (post.discovery?.queryId ? 100 : 75) : 0,
      recency: Math.round(recency),
      viewVelocity: Math.min(100, Math.round(velocity.viewVelocity / 30)),
      replyVelocity: Math.min(100, Math.round(velocity.replyVelocity * 8)),
      propagation: Math.min(100, Math.round(ratios.repost * 10_000)),
      excessReach: Math.min(100, Math.round(ratios.reachMultiple * 25)),
      discussion: Math.min(100, Math.round(ratios.reply * 10_000))
    };
    const recommendationScore = Math.round(
      scoreBreakdown.relevance * .24 + scoreBreakdown.recency * .16 +
      scoreBreakdown.viewVelocity * .18 + scoreBreakdown.replyVelocity * .14 +
      scoreBreakdown.propagation * .1 + scoreBreakdown.excessReach * .1 +
      scoreBreakdown.discussion * .08
    );
    const shape = contentShape(post);
    return {
      ...post,
      topics: topicsFor(post, industries),
      followed: followed.has(String(post.handle || "").toLowerCase()),
      lifecycle: heat === "普通" && velocity.count === 0 ? "新发现" : heat,
      nextVisitMinutes: heat === "爆发" ? 15 : heat === "升温" ? 60 : heat === "冷却" ? 720 : 180,
      analysis: {
        version: "deterministic-v2",
        model: "rules",
        generatedAt: new Date().toISOString(),
        confidence: velocity.count >= 2 ? .9 : peers.length >= 3 ? .72 : .48,
        shape,
        ratios,
        velocity,
        baselineViews: baseline,
        hot: ["升温", "爆发"].includes(heat),
        level: heat,
        reasons,
        reasonSummary: reasons.slice(0, 2).join("；"),
        evidence: `曝光 ${views.toLocaleString("zh-CN")} · 互动率 ${(ratios.interaction * 100).toFixed(2)}% · 基线 ${Math.round(baseline).toLocaleString("zh-CN")} · ${velocity.count} 个快照`,
        input: { postId: post.id, snapshotIds: snapshots.filter(item => item.postId === post.id).map(item => item.id) },
        score: recommendationScore,
        scoreBreakdown
      }
    };
  });
}

export function buildSearchQueries(industry) {
  const words = [...new Set((industry.keywords || []).map(value => String(value).trim()).filter(Boolean))].slice(0, 12);
  const patterns = [
    { category: "产品动态", suffix: "(发布 OR 更新 OR launch OR update)", reason: "发现 AI 产品发布与更新" },
    { category: "教程案例", suffix: "(教程 OR 案例 OR guide OR workflow)", reason: "发现可复用方法与真实案例" },
    { category: "评测争议", suffix: "(评测 OR 对比 OR 争议 OR review)", reason: "发现产品评价与行业争议" }
  ];
  return words.flatMap((word, index) => {
    const pattern = patterns[index % patterns.length];
    return [{
      category: pattern.category,
      keywords: [word],
      query: `${quote(word)} ${pattern.suffix}`,
      platform: "x",
      language: industry.language || "中英双语",
      reason: pattern.reason
    }];
  });
}

export function buildIndustrySignals(industries, posts) {
  return industries.map(industry => {
    const excluded = (industry.excludedKeywords || []).map(x => x.toLowerCase());
    const keywords = (industry.keywords || []).filter(Boolean);
    const matches = posts.filter(post => {
      const text = String(post.text || "").toLowerCase();
      return !excluded.some(word => text.includes(word)) && keywords.some(word => text.includes(String(word).toLowerCase()));
    });
    const accounts = new Set(matches.map(post => String(post.handle || "").toLowerCase())).size;
    const threshold = Number(industry.thresholdAccounts) || 3;
    const hotPosts = matches.filter(post => post.analysis?.hot);
    return {
      id: `signal-${industry.id || industry.name}`,
      industryId: industry.id,
      industry: industry.name,
      mentions: matches.length,
      accounts,
      trend: hotPosts.some(post => post.analysis.level === "爆发") ? "爆发" : accounts >= threshold || hotPosts.length >= 2 ? "升温" : matches.length ? "萌芽" : "暂无信号",
      confidence: accounts >= threshold ? "高" : accounts >= 2 ? "中" : "低",
      keywords: keywords.filter(word => matches.some(post => String(post.text || "").toLowerCase().includes(String(word).toLowerCase()))),
      reason: matches.length ? `${accounts} 个账号出现 ${matches.length} 条相关内容，其中 ${hotPosts.length} 条正在升温或爆发。` : "当前真实样本中尚未命中相关词。",
      representativePostIds: [...matches].sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0)).slice(0, 3).map(post => post.id),
      firstSeenAt: matches.map(post => post.publishedAt).filter(Boolean).sort()[0] || null
    };
  });
}

export function buildCreatorCandidates(posts, creators, existing = []) {
  const followed = new Set(creators.map(item => String(item.handle || "").toLowerCase()));
  const previous = new Map(existing.map(item => [String(item.handle || "").toLowerCase(), item]));
  const groups = new Map();
  for (const post of posts.filter(item =>
    item.analysis?.hot &&
    item.topics?.length &&
    !followed.has(String(item.handle || "").toLowerCase())
  )) {
    const key = String(post.handle || "").toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  const generated = [...groups.entries()].map(([key, items]) => {
    const types = { 故事: 0, 列表: 0, 观点: 0, 教程: 0 };
    items.forEach(item => { types[item.analysis.shape.type] += 1; });
    const total = items.length || 1;
    const representative = [...items].sort((a, b) => (b.analysis.score || 0) - (a.analysis.score || 0))[0];
    return {
      id: previous.get(key)?.id || `candidate-${key.replace(/^@/, "")}`,
      handle: representative.handle,
      displayName: representative.author || representative.handle,
      status: previous.get(key)?.status || "discovered",
      industryFocus: Math.min(100, 60 + items.length * 10),
      representativePostId: representative.id,
      postIds: items.map(item => item.id),
      distribution: Object.fromEntries(Object.entries(types).map(([type, count]) => [type, Math.round(count / total * 100)])),
      reason: `${items.length} 条升温或爆发帖子进入发现流；代表帖子评分 ${representative.analysis.score}。`,
      evidence: items.slice(0, 3).map(item => ({ postId: item.id, heat: item.analysis.level, evidence: item.analysis.evidence }))
    };
  });
  const generatedHandles = new Set(generated.map(item => String(item.handle || "").toLowerCase()));
  return [
    ...generated,
    ...existing.filter(item => !generatedHandles.has(String(item.handle || "").toLowerCase()))
  ];
}
