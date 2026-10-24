import test from "node:test";
import assert from "node:assert/strict";
import { buildHeatMap } from "../lib/heat-map.mjs";

const NOW = Date.parse("2026-07-26T08:00:00.000Z");

function post(id, handle, options = {}) {
  const heat = options.heat || "普通";
  const snapshotCount = options.snapshotCount ?? (["升温", "爆发"].includes(heat) ? 2 : 1);
  return {
    id,
    handle,
    author: options.author || handle.replace("@", ""),
    text: options.text || `Codex 浏览器自动化讨论 ${id}`,
    url: `https://x.com/${handle.replace("@", "")}/status/${id}`,
    publishedAt: options.publishedAt || "2026-07-26T07:00:00.000Z",
    views: options.views ?? 8000,
    likes: options.likes ?? 80,
    replies: options.replies ?? 12,
    reposts: options.reposts ?? 16,
    followed: Boolean(options.followed),
    topics: options.topics || ["Codex"],
    provenance: options.provenance || { status: "direct", rootPostId: null },
    rootSourceForPostIds: options.rootSourceForPostIds || [],
    analysis: {
      level: heat,
      reasonSummary: `${heat}证据`,
      velocity: {
        count: snapshotCount,
        viewVelocity: options.viewVelocity ?? (heat === "爆发" ? 5000 : heat === "升温" ? 900 : 0),
        replyVelocity: options.replyVelocity ?? (heat === "爆发" ? 15 : heat === "升温" ? 4 : 0),
        growthRatio: options.growthRatio ?? (heat === "爆发" ? .8 : heat === "升温" ? .25 : 0)
      },
      input: { snapshotIds: Array.from({ length: snapshotCount }, (_, index) => `${id}-s${index}`) }
    }
  };
}

test("只有两个以上快照才能成为升温或爆发焦点", () => {
  const result = buildHeatMap([
    post("burst", "@source", { heat: "爆发" }),
    post("rising", "@riser", { heat: "升温" }),
    post("single", "@single", { heat: "爆发", snapshotCount: 1, views: 20000, likes: 200, replies: 40 })
  ], [], { window: "24h", now: NOW });

  assert.deepEqual(result.focusPosts.map(item => item.postId), ["burst", "rising"]);
  assert.equal(result.focusPosts[0].heatStatus, "burst");
  assert.equal(result.focusPosts[1].heatStatus, "rising");
  assert.equal(result.coverage.highHeatCandidateCount, 1);
  assert.equal(result.standard.minimumSnapshotsForHeat, 2);
});

test("默认按二十爆发、六十升温选择焦点，相关内容按真实数据浮动且最多三百条", () => {
  const crowded = [
    ...Array.from({ length: 6 }, (_, index) => post(`same-${index}`, "@same", { heat: "爆发", viewVelocity: 9000 - index })),
    ...Array.from({ length: 30 }, (_, index) => post(`burst-${index}`, `@burst${index}`, { heat: "爆发", viewVelocity: 8000 - index * 50 })),
    ...Array.from({ length: 70 }, (_, index) => post(`rising-${index}`, `@rising${index}`, { heat: "升温", viewVelocity: 2500 - index * 12 })),
    ...Array.from({ length: 340 }, (_, index) => post(`normal-${index}`, `@normal${index}`, { heat: "普通", snapshotCount: 1, viewVelocity: 0, replyVelocity: 0, growthRatio: 0 }))
  ];
  const result = buildHeatMap(crowded, [], { window: "24h", now: NOW });
  assert.equal(result.focusPosts.length, 80);
  assert.equal(result.focusPosts.filter(item => item.heatStatus === "burst").length, 20);
  assert.equal(result.focusPosts.filter(item => item.heatStatus === "rising").length, 60);
  assert.equal(result.contextPosts.length, 300);
  assert.equal(result.relatedPosts.length + result.independentSignals.length, 300);
  assert.equal(result.focusPosts.length + result.contextPosts.length, 380);
  assert.equal(result.focusPosts.filter(item => item.handle === "@same").length, 2);
  assert.deepEqual(result.standard.focusComposition, { burst: 20, rising: 60 });
  assert.equal(result.standard.contextLimit, 300);
  assert.equal(result.standard.relatedLimit, 255);
  assert.equal(result.standard.independentSignalLimit, 45);
});

test("升温数据不足时不会用额外爆发帖填满八十个焦点", () => {
  const result = buildHeatMap(
    Array.from({ length: 28 }, (_, index) =>
      post(`burst-only-${index}`, `@burstOnly${index}`, { heat: "爆发", viewVelocity: 9000 - index })
    ),
    [],
    { window: "24h", now: NOW }
  );
  assert.equal(result.focusPosts.length, 20);
  assert.equal(result.focusPosts.every(item => item.heatStatus === "burst"), true);
});

test("超过同一博主焦点上限的真实升温帖保留在外围而不是消失", () => {
  const result = buildHeatMap(
    Array.from({ length: 5 }, (_, index) =>
      post(`same-rising-${index}`, "@sameRiser", {
        heat: "升温",
        viewVelocity: 1800 - index * 80,
        topics: ["Codex"]
      })
    ),
    [],
    { window: "24h", now: NOW }
  );

  assert.equal(result.focusPosts.length, 2);
  assert.equal(result.relatedPosts.length, 3);
  assert.ok(result.relatedPosts.every(item => item.contextStatus === "verified_heat_overflow"));
  assert.ok(result.relatedPosts.every(item => item.overflowHeatStatus === "rising"));
});

test("相关内容不会为凑数量虚构或补齐固定条数", () => {
  const result = buildHeatMap([
    post("burst", "@burst", { heat: "爆发" }),
    ...Array.from({ length: 17 }, (_, index) =>
      post(`normal-${index}`, `@normal${index}`, {
        heat: "普通",
        snapshotCount: 1,
        viewVelocity: 0,
        replyVelocity: 0,
        growthRatio: 0
      })
    )
  ], [], { window: "24h", now: NOW });
  assert.equal(result.contextPosts.length, 17);
  assert.equal(result.coverage.contextCount, 17);
  assert.equal(result.relatedPosts.length + result.independentSignals.length, 17);
});

test("话题筛选数量来自真实焦点证据，不再固定截断为十八个", () => {
  const focusPosts = Array.from({ length: 22 }, (_, index) =>
    post(`topic-focus-${index}`, `@topic${index}`, {
      heat: "升温",
      text: `AI 行业方向 ${index} 正在升温`,
      topics: [`方向${index}`]
    })
  );
  const trendingKeywords = focusPosts.map((item, index) => ({
    id: `topic-${index}`,
    normalizedText: `方向${index}`,
    sourcePostIds: [item.id],
    postCount24h: 1
  }));
  const result = buildHeatMap(focusPosts, [], {
    window: "24h",
    now: NOW,
    trendingKeywords
  });
  assert.equal(result.topics.length, 22);
});

test("普通相关帖围绕焦点并保留母帖身份，话题只作为筛选数据", () => {
  const root = post("root", "@root", {
    text: "Codex 新增浏览器控制能力",
    heat: "普通",
    rootSourceForPostIds: ["focus"],
    publishedAt: "2026-07-25T20:00:00.000Z"
  });
  const focus = post("focus", "@cn", {
    text: "Codex 浏览器控制开始升温",
    heat: "升温",
    provenance: { status: "confirmed", rootPostId: "root" }
  });
  const related = post("related", "@followed", {
    text: "实测 Codex 浏览器控制工作流",
    heat: "普通",
    followed: true
  });
  const keyword = {
    id: "kw-codex-browser",
    normalizedText: "浏览器自动化",
    sourcePostIds: ["root", "focus", "related"],
    postCount24h: 3
  };
  const result = buildHeatMap([root, focus, related], [], {
    window: "24h",
    now: NOW,
    trendingKeywords: [keyword],
    topic: "kw-codex-browser"
  });

  assert.equal(result.topic.id, "kw-codex-browser");
  assert.equal(result.focusPosts.length, 1);
  assert.ok(result.contextPosts.some(item => item.postId === "root" && item.provenanceRole === "mother"));
  assert.ok(result.relatedPosts.every(item => item.relevanceStrength >= .16));
  assert.ok(result.relatedPosts.every(item => item.relevanceEvidence.length > 0));
  assert.ok(result.clusters[0].contextPostIds.includes("root"));
  assert.ok(result.clusters[0].relatedPostIds.includes("root"));
  assert.ok(result.topics.every(item => !("nodeType" in item)));
});

test("外围明确拆分相关帖子与独立高热信号，兼容字段为二者并集", () => {
  const focus = post("focus", "@focus", {
    text: "Codex 浏览器自动化正在升温",
    heat: "升温",
    topics: ["Codex"]
  });
  const related = post("related", "@related", {
    text: "实测 Codex 浏览器自动化工作流",
    heat: "普通",
    topics: ["Codex"]
  });
  const independent = post("independent", "@independent", {
    text: "Gemini 视频模型推出新能力",
    heat: "普通",
    topics: ["Gemini"],
    views: 16000,
    likes: 240,
    replies: 30,
    reposts: 60
  });
  const result = buildHeatMap([focus, related, independent], [], { window: "24h", now: NOW });

  assert.deepEqual(result.relatedPosts.map(item => item.postId), ["related"]);
  assert.deepEqual(result.independentSignals.map(item => item.postId), ["independent"]);
  assert.equal(result.independentSignals[0].candidateReason, "单快照高互动，等待复采确认");
  assert.deepEqual(result.contextPosts.map(item => item.signalType).sort(), ["independent", "related"]);
  assert.equal(result.coverage.relatedCount, 1);
  assert.equal(result.coverage.independentSignalCount, 1);
  assert.ok(result.coverage.actualCoverageStart);
  assert.ok(result.coverage.actualCoverageEnd);
});

test("标题带来源且不会退化为观点讨论等空泛文案", () => {
  const result = buildHeatMap([
    post("focus", "@focus", {
      text: "今天我发现 Agent 项目已经正式开源",
      heat: "爆发"
    })
  ], [], { window: "24h", now: NOW });
  assert.equal(result.focusPosts[0].titleSource, "rule");
  assert.match(result.focusPosts[0].displayTitle, /Agent|开源/);
  assert.doesNotMatch(result.focusPosts[0].displayTitle, /^(观点|故事|教程|列表)讨论$/);
  assert.ok([...result.focusPosts[0].displayTitle].length <= 12);
});

test("标题提炼最长约十个汉字宽度，并总结语义而不是截取句首", () => {
  const result = buildHeatMap([
    post("claude-free", "@focus", {
      text: "卧槽这是真的，我成功白嫖了 Claude MAX 20X，下面是完整操作步骤",
      heat: "爆发",
      topics: ["Claude"]
    }),
    post("funding-stop", "@funding", {
      text: "据悉 DeepSeek 已通知投资方，本轮融资流程临时中止",
      heat: "升温",
      topics: ["DeepSeek"]
    }),
    post("semantic-fallback", "@fallback", {
      text: "现在我发现了一个变化。真正值得关注的是 AI 本地模型开始进入企业工作流",
      heat: "升温",
      topics: []
    })
  ], [], { window: "24h", now: NOW });

  const titles = Object.fromEntries(result.focusPosts.map(item => [item.postId, item]));
  assert.equal(titles["claude-free"].displayTitle, "Claude免费订阅");
  assert.equal(titles["funding-stop"].displayTitle, "DeepSeek暂停融资");
  assert.doesNotMatch(titles["semantic-fallback"].displayTitle, /^(现在|我发现|现在我发现)/);
  assert.equal(titles["semantic-fallback"].titleSource, "semantic_excerpt");
});

test("结构化 Skill 标题可突破旧六字限制但保持十字级别", () => {
  const item = post("skill-title", "@skill", {
    text: "Claude Code 系统提示词发生重要变化",
    heat: "爆发"
  });
  item.analysis.displayTitle = "Claude Code系统提示词精简";
  const result = buildHeatMap([item], [], { window: "24h", now: NOW });

  assert.equal(result.focusPosts[0].titleSource, "skill");
  assert.ok(result.focusPosts[0].displayTitle.length > 6);
  assert.match(result.focusPosts[0].displayTitle, /Claude Code/);
});

test("只顺带提到 AI 的无关热帖不会进入帖子雷达", () => {
  const result = buildHeatMap([
    post("irrelevant", "@noise", {
      text: "这份道歉声明毫无诚意，他们甚至没有说这是 AI",
      topics: ["AI"],
      heat: "爆发"
    }),
    post("relevant", "@signal", {
      text: "创作者使用 AI 合成总统声音，引发版权与合规争议",
      topics: ["AI"],
      heat: "爆发"
    })
  ], [], { window: "24h", now: NOW });

  assert.deepEqual(result.focusPosts.map(item => item.postId), ["relevant"]);
  assert.equal(result.focusPosts[0].displayTitle, "AI合成声音争议");
});

test("没有曝光、点赞或公开互动证据的普通帖子不会进入任何首页层", () => {
  const result = buildHeatMap([
    post("focus", "@focus", { heat: "爆发" }),
    post("empty-related", "@empty", {
      heat: "普通",
      views: 0,
      likes: 0,
      replies: 0,
      reposts: 0,
      text: "Codex 浏览器自动化跟进内容"
    })
  ], [], { window: "24h", now: NOW });

  assert.equal(result.relatedPosts.some(item => item.postId === "empty-related"), false);
  assert.equal(result.independentSignals.some(item => item.postId === "empty-related"), false);
  assert.equal(result.contextPosts.some(item => item.postId === "empty-related"), false);
});
