import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingConfig, usageOf, estimateCost, GeminiClient } from "../src/gemini.mjs";

test("thinkingConfig maps levels, budgets and thoughts", () => {
  assert.deepEqual(thinkingConfig({ level: "high" }), { thinkingLevel: "high" });
  assert.deepEqual(thinkingConfig({ level: "off" }), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfig({ level: "low", budget: 512 }), { thinkingBudget: 512 });
  assert.deepEqual(thinkingConfig({ level: "medium", includeThoughts: true }), { thinkingLevel: "medium", includeThoughts: true });
  assert.equal(thinkingConfig({}), undefined);
});

test("usageOf normalises the API metadata", () => {
  assert.deepEqual(usageOf({ promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15 }), {
    promptTokens: 10,
    cachedTokens: 4,
    candidatesTokens: 3,
    thoughtsTokens: 2,
    totalTokens: 15,
  });
  assert.equal(usageOf(undefined).totalTokens, 0);
});

test("estimateCost bills cached tokens at the cached rate and thoughts as output", () => {
  const usage = { promptTokens: 1_000_000, cachedTokens: 400_000, candidatesTokens: 100_000, thoughtsTokens: 50_000, totalTokens: 1_150_000 };
  const cost = estimateCost(usage, { input: 1, output: 4, cached: 0.25 });
  // 600k uncached at $1 + 400k cached at $0.25 + 150k output at $4
  assert.equal(cost, 1.3);
  assert.equal(estimateCost(usage, { input: 1, output: 4 }), 1.6);
  assert.equal(estimateCost(usage, null), null);
  assert.equal(estimateCost(usage, { input: null, output: null }), null);
});

test("summary totals calls and reports cache and thinking state", () => {
  const client = new GeminiClient({ model: "m", thinking: { level: "low" }, cache: { enabled: false }, pricing: { m: { input: 1, output: 2 } } });
  client.calls.push({ promptTokens: 10, cachedTokens: 0, candidatesTokens: 5, thoughtsTokens: 1, totalTokens: 16, costUSD: 0.001 });
  client.calls.push({ promptTokens: 20, cachedTokens: 5, candidatesTokens: 5, thoughtsTokens: 0, totalTokens: 30, costUSD: 0.002 });
  const s = client.summary();
  assert.equal(s.calls, 2);
  assert.equal(s.totalTokens, 46);
  assert.equal(s.cachedTokens, 5);
  assert.equal(s.estimatedCostUSD, 0.003);
  assert.deepEqual(s.cache, { used: false, reason: "disabled" });
  assert.deepEqual(s.thinking, { thinkingLevel: "low" });
});

test("summary reports an unknown cost when pricing is missing", () => {
  const client = new GeminiClient({ model: "m", cache: { enabled: true } });
  client.calls.push({ promptTokens: 1, cachedTokens: 0, candidatesTokens: 1, thoughtsTokens: 0, totalTokens: 2, costUSD: null });
  const s = client.summary();
  assert.equal(s.estimatedCostUSD, null);
  assert.equal(s.pricingKnown, false);
  assert.equal(s.cache.used, false);
});
