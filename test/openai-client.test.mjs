import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAIClient } from "../src/openai.mjs";

/** A canned Responses API reply, shaped like the real one. */
function reply(text, extra = {}) {
  return {
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ text: "looked at both captures" }] },
      { type: "message", content: [{ type: "output_text", text }] },
    ],
    usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 100 } },
    ...extra,
  };
}

test("OpenAIClient sends a strict structured request, parses the reply and keeps a priced ledger", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-openai-"));
  const ledger = path.join(dir, "usage.jsonl");
  const seen = [];
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(reply('{"score": 71, "verdict": "fine"}')), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new OpenAIClient({
      model: "gpt-5.4-mini",
      thinking: { level: "medium", includeThoughts: true },
      generation: { temperature: 0.3, maxOutputTokens: 4096 },
      cache: { enabled: true },
      pricing: {},
      ledgerPath: ledger,
      runLabel: "critique:test",
    });
    assert.equal(await client.ensureCache([]), null, "no explicit cache on OpenAI");
    const schema = { type: "OBJECT", properties: { score: { type: "INTEGER" }, verdict: { type: "STRING" } }, required: ["score", "verdict"] };
    const parts = [{ text: "Review this" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }];
    const { data, usage, thoughts } = await client.generateJSON({ parts, schema, op: "page:/" });
    assert.deepEqual(data, { score: 71, verdict: "fine" });
    assert.equal(usage.cachedTokens, 1000);
    assert.equal(usage.thoughtsTokens, 100);
    assert.equal(usage.candidatesTokens, 200);
    assert.equal(thoughts, "looked at both captures");

    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/v1\/responses$/);
    assert.equal(seen[0].init.headers.Authorization, "Bearer test-key-not-real");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.schema.type, "object");
    assert.equal(body.text.format.schema.additionalProperties, false);
    assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(body.temperature, undefined, "reasoning models take no temperature");
    assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.input[0].content[0].type, "input_text");
    assert.equal(body.input[0].content[1].type, "input_image");

    const summary = client.summary();
    assert.equal(summary.provider, "openai");
    assert.equal(summary.calls, 1);
    assert.ok(summary.estimatedCostUSD > 0, "priced from the built-in OpenAI table");
    assert.match(summary.price, /\$0\.75\/M in, \$4\.5\/M out, \$0\.075\/M cached/);
    const lines = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].provider, "openai");
    assert.equal(lines[0].op, "page:/");
    assert.ok(lines[0].costUSD > 0);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

test("OpenAIClient retries a truncated output with a larger budget and surfaces a refusal", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  const budgets = [];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    budgets.push(body.max_output_tokens);
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify(reply("", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })), { status: 200 });
    return new Response(JSON.stringify(reply('{"ok": true}')), { status: 200 });
  };
  try {
    const client = new OpenAIClient({ model: "gpt-4.1-mini", thinking: {}, generation: { maxOutputTokens: 1024 }, cache: {}, pricing: {}, ledgerPath: null });
    const { data } = await client.generateJSON({ parts: [{ text: "x" }], schema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] }, op: "t" });
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(budgets, [1024, 2048]);
    const first = JSON.parse((await (async () => { const b = []; globalThis.fetch = async (u, i) => { b.push(JSON.parse(i.body)); return new Response(JSON.stringify(reply('{"ok":true}')), { status: 200 }); }; await client.generateJSON({ parts: [{ text: "x" }], schema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] }, op: "t2" }); return JSON.stringify(b[0]); })()));
    assert.equal(first.temperature, 0.3, "non-reasoning models take the temperature");
    assert.equal(first.reasoning, undefined);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage: {} }), { status: 200 });
    await assert.rejects(client.generateJSON({ parts: [{ text: "x" }], schema: { type: "OBJECT", properties: {}, required: [] }, op: "t3" }), /refused/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }
});
