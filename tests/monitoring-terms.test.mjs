import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureMonitoringRules, evaluateAIRelevance, monitoringQueries, upsertRule } from "../lib/monitoring-terms.mjs";

test("默认监控词覆盖中英文、双平台并排除 skill", () => {
  const rules = ensureMonitoringRules([]);
  assert.equal(rules.length, 4);
  assert.ok(rules.every(rule => rule.platforms.includes("x") && rule.platforms.includes("douyin")));
  assert.equal(evaluateAIRelevance({ text: "新的 skill 教程" }, rules).relevant, false);
  assert.equal(evaluateAIRelevance({ text: "OpenAI 发布 GPT-6" }, rules).relevant, true);
  assert.ok(monitoringQueries(rules).some(query => query.platform === "douyin" && query.query.includes("OpenAI")));
});

test("编辑监控词会提升版本并保留创建时间", () => {
  const rules = ensureMonitoringRules([]);
  const original = rules[0];
  const updated = upsertRule(rules, { ...original, terms: [...original.terms, "新产品"] });
  assert.equal(updated.version, original.version + 1);
  assert.equal(updated.createdAt, original.createdAt);
});
