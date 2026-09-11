import { test } from "node:test";
import assert from "node:assert/strict";
import { runPool, serialWriter } from "../src/pool.mjs";
import { parseDecisions, decisionsSection, withholdSettled } from "../src/decisions.mjs";
import { mergeAdjudication, gateHits } from "../src/compare.mjs";
import { isReasoningModel, reasoningConfig, toStrictSchema, toInputItems, usageOf, readOutput } from "../src/openai.mjs";
import { summarizeRuntime, redirectedAway } from "../src/capture.mjs";
import { providerFor } from "../src/provider.mjs";
import { resolvePrice } from "../src/pricing.mjs";

test("runPool keeps input order, honours the limit and finishes in-flight work on failure", async () => {
  let inFlight = 0;
  let peak = 0;
  const order = await runPool([30, 10, 20, 5], 2, async (ms) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight -= 1;
    return ms;
  });
  assert.deepEqual(order, [30, 10, 20, 5]);
  assert.equal(peak, 2);

  const seen = [];
  await assert.rejects(
    runPool([1, 2, 3, 4], 1, async (n) => {
      seen.push(n);
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
  assert.deepEqual(seen, [1, 2], "no new items start after a failure");
});

test("serialWriter never interleaves writes", async () => {
  const log = [];
  const write = serialWriter(async (n) => {
    log.push(`start ${n}`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`end ${n}`);
  });
  await Promise.all([write(1), write(2)]);
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2"]);
});

test("decisions parse from bullets, close in the prompt and withhold matching findings", () => {
  const list = parseDecisions("# Settled\n\n- Footer keeps the Gmail address: it is real.\n* Lists stay flat: brand.\n2. Numbered too\nnot a bullet\n");
  assert.deepEqual(list, ["Footer keeps the Gmail address: it is real.", "Lists stay flat: brand.", "Numbered too"]);
  assert.match(decisionsSection(list), /Settled decisions \(closed\)[\s\S]*1\. Footer keeps/);
  assert.equal(decisionsSection([]), "");
  const { kept, withheld } = withholdSettled([
    { id: "a", conflicts_with_decision: "" },
    { id: "b", conflicts_with_decision: "Footer keeps the Gmail address: it is real." },
    { id: "c", conflicts_with_decision: "none" },
    { id: "d" },
  ]);
  assert.deepEqual(kept.map((f) => f.id), ["a", "c", "d"]);
  assert.deepEqual(withheld.map((f) => f.id), ["b"]);
});

test("mergeAdjudication keeps confirmed regressions, parks the rest, and revises an unsupported verdict", () => {
  const first = { verdict: "mixed", improved: ["bigger title"], regressed: ["link too small", "colour changed"], still_open: [], notes: "" };
  const merged = mergeAdjudication(first, {
    verdicts: [
      { item: 1, confirmed: true, kind: "measured", reason: "15px in the facts" },
      { item: 2, confirmed: false, kind: "judged", reason: "same colour in both captures" },
    ],
  });
  assert.deepEqual(merged.regressed, ["link too small"]);
  assert.equal(merged.regressed_detail[0].kind, "measured");
  assert.equal(merged.unconfirmed_regressions.length, 1);
  assert.equal(merged.verdict, "mixed", "a confirmed regression keeps the verdict");

  const none = mergeAdjudication(first, { verdicts: [{ item: 1, confirmed: false, kind: "judged", reason: "x" }, { item: 2, confirmed: false, kind: "judged", reason: "y" }] });
  assert.equal(none.verdict, "better");
  assert.match(none.notes, /second look/);
  assert.equal(mergeAdjudication({ ...first, improved: [] }, { verdicts: [] }).verdict, "same");
});

test("gateHits distinguishes measured, any and worse", () => {
  const results = [
    { route: "/a", verdict: "better", regressed: ["x"], regressed_detail: [{ text: "x", kind: "judged" }] },
    { route: "/b", verdict: "worse", regressed: ["y"], regressed_detail: [{ text: "y", kind: "measured" }] },
    { route: "/c", verdict: "better", regressed: [], regressed_detail: [] },
  ];
  assert.deepEqual(gateHits(results, "measured").map((r) => r.route), ["/b"]);
  assert.deepEqual(gateHits(results, "regressed").map((r) => r.route), ["/a", "/b"]);
  assert.deepEqual(gateHits(results, "worse").map((r) => r.route), ["/b"]);
  assert.deepEqual(gateHits(results, undefined), []);
});

test("openai helpers: reasoning mapping, strict schema, input items, usage and output parsing", () => {
  assert.equal(isReasoningModel("gpt-5.4-mini"), true);
  assert.equal(isReasoningModel("o4-mini"), true);
  assert.equal(isReasoningModel("gpt-4.1"), false);
  assert.deepEqual(reasoningConfig({ level: "high", includeThoughts: true }, "gpt-5.4"), { effort: "high", summary: "auto" });
  assert.deepEqual(reasoningConfig({ level: "off" }, "gpt-5"), { effort: "minimal" });
  assert.deepEqual(reasoningConfig({ level: "off" }, "o3"), { effort: "low" });
  assert.equal(reasoningConfig({ level: "high" }, "gpt-4.1"), null);

  const strict = toStrictSchema({
    type: "OBJECT",
    properties: {
      score: { type: "INTEGER" },
      verdict: { type: "STRING", enum: ["a", "b"], description: "d" },
      items: { type: "ARRAY", items: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] } },
    },
    required: ["score"],
  });
  assert.equal(strict.type, "object");
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ["score", "verdict", "items"]);
  assert.deepEqual(strict.properties.verdict.enum, ["a", "b"]);
  assert.equal(strict.properties.items.items.properties.ok.type, "boolean");

  const items = toInputItems([{ text: "hi" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }]);
  assert.deepEqual(items[0], { type: "input_text", text: "hi" });
  assert.equal(items[1].type, "input_image");
  assert.match(items[1].image_url, /^data:image\/png;base64,AAAA$/);

  assert.deepEqual(usageOf({ input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 30 } }), {
    promptTokens: 100,
    cachedTokens: 40,
    candidatesTokens: 20,
    thoughtsTokens: 30,
    totalTokens: 150,
  });

  const parsed = readOutput({
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ text: "thought" }] },
      { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] },
    ],
  });
  assert.equal(parsed.text, '{"a":1}');
  assert.equal(parsed.thoughts, "thought");
  assert.equal(parsed.incomplete, null);
  const cut = readOutput({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
  assert.equal(cut.incomplete, "max_output_tokens");
});

test("providers resolve from the model id unless configured, and OpenAI prices resolve", () => {
  assert.equal(providerFor({ model: "gemini-3.8-flash" }), "gemini");
  assert.equal(providerFor({ model: "gpt-5.4-mini" }), "openai");
  assert.equal(providerFor({ model: "o4-mini" }), "openai");
  assert.equal(providerFor({ model: "gpt-5.4-mini", provider: "gemini" }), "gemini");
  const price = resolvePrice("gpt-5.4-mini-2026-08-01", {}, "2026-09-11");
  assert.equal(price.key, "gpt-5.4-mini");
  assert.equal(price.output, 4.5);
  assert.equal(resolvePrice("gpt-5.4", {}, "2026-09-11").input, 2.5);
});

test("runtime facts deduplicate and cap, and redirects are detected by path", () => {
  const rt = summarizeRuntime({ consoleErrors: ["a", "a", "b"], pageErrors: [], failedRequests: Array.from({ length: 15 }, (_, i) => `u${i}`), httpErrors: ["404 /x"] }, 0.123);
  assert.deepEqual(rt.consoleErrors, ["a", "b"]);
  assert.equal(rt.failedRequests.length, 10);
  assert.equal(rt.cls, 0.123);
  assert.equal(redirectedAway("/account/plans", "http://localhost:3000/login?next=%2Faccount%2Fplans", "http://localhost:3000"), true);
  assert.equal(redirectedAway("/shop?q=wig", "http://localhost:3000/shop?q=wig", "http://localhost:3000"), false);
  assert.equal(redirectedAway("/shop/", "http://localhost:3000/shop", "http://localhost:3000"), false);
});
