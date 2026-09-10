import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePrice, estimateCost, cacheStorageCost, matchKey, describePrice, BUILT_IN_PRICING } from "../src/pricing.mjs";
import { costReport, renderCostReport } from "../src/cost.mjs";

test("every built-in price has numeric input and output rates", () => {
  for (const [key, entry] of Object.entries(BUILT_IN_PRICING)) {
    const tiers = entry.tiers ?? [entry];
    for (const tier of tiers) {
      assert.equal(typeof tier.input, "number", key);
      assert.equal(typeof tier.output, "number", key);
    }
  }
});

test("resolvePrice matches exact ids, dated variants and the models/ prefix", () => {
  const exact = resolvePrice("gemini-3.8-flash", {}, "2026-09-10");
  assert.equal(exact.key, "gemini-3.8-flash");
  assert.equal(exact.input, 0.75);
  assert.equal(exact.source, "built-in");
  assert.equal(resolvePrice("models/gemini-3.8-flash-preview-09-2026", {}, "2026-09-10").key, "gemini-3.8-flash");
  assert.equal(resolvePrice("gemini-3.5-flash-lite", {}, "2026-09-10").key, "gemini-3.5-flash-lite");
  assert.equal(resolvePrice("gemini-3.5-flash-lite-preview", {}, "2026-09-10").input, 0.3);
  assert.equal(resolvePrice("gemini-2.5-computer-use-preview-10-2025", {}, "2026-09-10").key, "gemini-2.5-computer-use-preview");
  assert.equal(resolvePrice("gemini-9-ultra", {}, "2026-09-10"), null);
  assert.equal(matchKey(BUILT_IN_PRICING, "gemini-3.5-flashy"), null);
});

test("an announced price change applies from its date", () => {
  assert.equal(resolvePrice("gemini-3.8-flash", {}, "2026-12-31").output, 3.75);
  assert.equal(resolvePrice("gemini-3.8-flash", {}, "2027-01-01").output, 7.5);
  assert.equal(resolvePrice("gemini-3.8-flash", {}, "2027-01-01").storagePerHour, 1.0);
});

test("config prices override the table and null placeholders are ignored", () => {
  const custom = resolvePrice("gemini-3.8-flash", { "gemini-3.8-flash": { input: 1, output: 2 } }, "2026-09-10");
  assert.equal(custom.source, "config");
  assert.equal(custom.input, 1);
  const ignored = resolvePrice("gemini-3.8-flash", { "gemini-3.8-flash": { input: null, output: null } }, "2026-09-10");
  assert.equal(ignored.source, "built-in");
  const unknownModel = resolvePrice("acme-vision", { acme: { input: 3, output: 6 } }, "2026-09-10");
  assert.equal(unknownModel.source, "config");
  assert.equal(unknownModel.key, "acme");
});

test("estimateCost bills cached, uncached, output and thinking at the right rates", () => {
  const price = resolvePrice("gemini-3.8-flash", {}, "2026-09-10");
  const usage = { promptTokens: 14145, cachedTokens: 11904, candidatesTokens: 1610, thoughtsTokens: 5912 };
  const expected = ((14145 - 11904) / 1e6) * 0.75 + (11904 / 1e6) * 0.075 + ((1610 + 5912) / 1e6) * 3.75;
  assert.equal(estimateCost(usage, price), Math.round(expected * 1e6) / 1e6);
  assert.equal(estimateCost(usage, null), null);
});

test("a prompt over the long-context threshold pays the long rates", () => {
  const price = resolvePrice("gemini-2.5-pro", {}, "2026-09-10");
  const short = estimateCost({ promptTokens: 1000, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0 }, price);
  const long = estimateCost({ promptTokens: 300_000, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0 }, price);
  assert.equal(short, 0.00125);
  assert.equal(long, 0.75);
});

test("cache storage is priced per million tokens per hour", () => {
  const price = resolvePrice("gemini-3.8-flash", {}, "2026-09-10");
  assert.equal(cacheStorageCost(2_000_000, 1800, price), 0.5);
  assert.equal(cacheStorageCost(2_000_000, 1800, { input: 1, output: 1 }), 0);
  assert.match(describePrice(price), /\$0\.75\/M in, \$3\.75\/M out, \$0\.075\/M cached \(built-in, as of/);
});

test("costReport totals a ledger per run at the prices known now", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-ledger-"));
  const ledger = path.join(dir, "usage.jsonl");
  const rows = [
    { ts: "2026-09-10T14:00:00.000Z", run: "critique:a", model: "gemini-3.8-flash", promptTokens: 1_000_000, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, costUSD: null },
    { ts: "2026-09-10T14:01:00.000Z", run: "critique:a", model: "gemini-3.8-flash", promptTokens: 0, cachedTokens: 0, candidatesTokens: 1_000_000, thoughtsTokens: 0, costUSD: null },
    { ts: "2026-09-10T14:02:00.000Z", run: "compare:b", model: "mystery-model", promptTokens: 10, cachedTokens: 0, candidatesTokens: 10, thoughtsTokens: 0, costUSD: null },
  ];
  await writeFile(ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
  const report = await costReport(ledger, {});
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs[0].costUSD, 4.5);
  assert.equal(report.runs[1].priced, 0);
  assert.equal(report.totalUSD, 4.5);
  assert.equal(report.unpricedCalls, 1);
  const text = renderCostReport(report);
  assert.match(text, /critique:a/);
  assert.match(text, /Total: \$4\.5000 \(1 calls without a known price\)/);
});
