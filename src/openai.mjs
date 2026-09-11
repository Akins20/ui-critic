import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { resolvePrice, estimateCost, describePrice } from "./pricing.mjs";

const BACKOFF_MS = [0, 3000, 8000, 15000];
const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const OUTPUT_CEILING = 65_536;

function baseUrl() {
  return (process.env.OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set (export it in your shell; this tool never stores it)");
  return key;
}

function headers() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` };
}

/** Reasoning models take an effort setting and no temperature; the others the reverse. */
export function isReasoningModel(model) {
  return /^(o\d|gpt-[5-9])/i.test(String(model ?? ""));
}

/**
 * Maps the tool's thinking config onto OpenAI's reasoning setting. "off" becomes
 * the lowest effort the model accepts (gpt-5 has minimal, the o-series low);
 * includeThoughts asks for a reasoning summary, which is the only form of thoughts
 * the API exposes.
 */
export function reasoningConfig(thinking, model) {
  if (!isReasoningModel(model)) return null;
  const level = thinking?.level ?? "high";
  const effort = level === "off" ? (/^gpt-[5-9]/i.test(model) ? "minimal" : "low") : level;
  const out = { effort };
  if (thinking?.includeThoughts) out.summary = "auto";
  return out;
}

/**
 * Turns the tool's Gemini-style schema (uppercase types, required lists) into the
 * strict JSON Schema OpenAI structured outputs want: lowercase types, every
 * property required, no additional properties. Enums and descriptions carry over.
 */
export function toStrictSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const type = String(schema.type ?? "").toLowerCase();
  const out = {};
  if (type) out.type = type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = [...schema.enum];
  if (type === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) out.properties[key] = toStrictSchema(value);
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (type === "array") out.items = toStrictSchema(schema.items ?? { type: "STRING" });
  return out;
}

/** Converts the tool's neutral parts into Responses API input items. */
export function toInputItems(parts) {
  return parts.map((p) => {
    if (p.inlineData) return { type: "input_image", image_url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`, detail: "auto" };
    return { type: "input_text", text: p.text ?? "" };
  });
}

/** Normalises a Responses API usage block into the tool's token counts. */
export function usageOf(u = {}) {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    promptTokens: input,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
    candidatesTokens: Math.max(0, output - reasoning),
    thoughtsTokens: reasoning,
    totalTokens: u.total_tokens ?? input + output,
  };
}

/** The message text, the reasoning summary and the incomplete reason of a response. */
export function readOutput(out) {
  let textOut = "";
  let refusal = null;
  const thoughts = [];
  for (const item of out.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text") textOut += c.text ?? "";
        if (c.type === "refusal") refusal = c.refusal ?? "refused";
      }
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) if (s.text) thoughts.push(s.text);
    }
  }
  return { text: textOut, refusal, thoughts: thoughts.join("\n\n") || null, incomplete: out.status === "incomplete" ? out.incomplete_details?.reason ?? "incomplete" : null };
}

function nextBudget(current) {
  const next = current * 2;
  return next > OUTPUT_CEILING ? (current < OUTPUT_CEILING ? OUTPUT_CEILING : null) : next;
}

/** Lists the chat-capable, vision-capable generation models the key can use. */
export async function listModels(filter) {
  const res = await fetch(`${baseUrl()}/v1/models`, { headers: headers() });
  if (!res.ok) throw new Error(`models: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const skip = /audio|realtime|tts|transcri|embedding|moderation|image|dall-e|whisper|search|instruct|codex|batch|computer-use|deep-research/i;
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o\d)/i.test(id) && !skip.test(id))
    .sort()
    .map((id) => ({ name: id, displayName: "" }))
    .filter((m) => !filter || m.name.includes(filter));
}

/**
 * The OpenAI critic: the same surface as the Gemini client, over the Responses
 * API with strict structured outputs. Prompts are already ordered stable-prefix
 * first, so OpenAI's automatic prompt caching applies on its own; there is no
 * explicit cache to create or delete. Every call is recorded in memory and in the
 * usage ledger with its estimated cost.
 */
export class OpenAIClient {
  constructor({ model, thinking, generation, cache, pricing, ledgerPath, runLabel }) {
    this.provider = "openai";
    this.model = model;
    this.thinking = thinking ?? {};
    this.generation = generation ?? {};
    this.cache = cache ?? { enabled: false };
    this.price = resolvePrice(model, pricing ?? {}, new Date());
    this.ledgerPath = ledgerPath;
    this.runLabel = runLabel ?? "";
    this.cacheName = null;
    this.cacheSkipped = "OpenAI caches repeated prompt prefixes automatically";
    this.calls = [];
  }

  /** OpenAI has no explicit context cache; prefix caching is automatic. */
  async ensureCache() {
    return null;
  }

  async close() {}

  cacheSeconds() {
    return 0;
  }

  /**
   * One structured call: the parts as a single user turn, the schema as a strict
   * JSON schema, reasoning effort from the thinking level. Transient failures are
   * retried with backoff, an output cut off at the token limit is retried with a
   * larger limit, and a refusal or malformed JSON fails with the reason.
   */
  async generateJSON({ parts, schema, op, temperature, maxOutputTokens }) {
    let budget = maxOutputTokens ?? this.generation.maxOutputTokens ?? 32_768;
    const reasoning = reasoningConfig(this.thinking, this.model);
    let lastErr;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      const body = {
        model: this.model,
        input: [{ role: "user", content: toInputItems(parts) }],
        text: { format: { type: "json_schema", name: "ui_critic", strict: true, schema: toStrictSchema(schema) } },
        max_output_tokens: budget,
        store: false,
      };
      if (reasoning) body.reasoning = reasoning;
      else body.temperature = temperature ?? this.generation.temperature ?? 0.3;

      const started = Date.now();
      const res = await fetch(`${baseUrl()}/v1/responses`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      if (RETRY_STATUSES.has(res.status)) {
        lastErr = new Error(`openai: HTTP ${res.status} on attempt ${attempt + 1}`);
        continue;
      }
      if (!res.ok) throw new Error(`openai: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
      const out = await res.json();
      const usage = usageOf(out.usage);
      const { text: textOut, refusal, thoughts, incomplete } = readOutput(out);
      if (refusal) {
        await this.record({ op, usage, started, budget, finishReason: "REFUSAL", ok: false });
        throw new Error(`openai: the model refused (${refusal})`);
      }
      if (incomplete === "max_output_tokens") {
        await this.record({ op, usage, started, budget, finishReason: "MAX_TOKENS", ok: false });
        const next = nextBudget(budget);
        if (next === null) throw new Error(`openai: output still truncated at the ${budget} token ceiling (${op})`);
        process.stderr.write(`  ${op}: output hit ${budget} tokens, retrying with ${next}\n`);
        budget = next;
        continue;
      }
      let data;
      try {
        data = JSON.parse(textOut);
      } catch {
        await this.record({ op, usage, started, budget, finishReason: incomplete ?? "BAD_JSON", ok: false });
        lastErr = new Error(`openai: response was not valid JSON (${incomplete ?? "complete"})`);
        continue;
      }
      await this.record({ op, usage, started, budget, finishReason: incomplete ?? "STOP", ok: true });
      return { data, usage, thoughts, finishReason: incomplete ?? "STOP" };
    }
    throw lastErr ?? new Error("openai: request failed");
  }

  /** Records one call in memory and, when a ledger path is set, in the JSON-lines ledger. */
  async record({ op, usage, started, finishReason, budget, ok }) {
    const entry = {
      ts: new Date().toISOString(),
      run: this.runLabel,
      provider: "openai",
      model: this.model,
      op,
      ...usage,
      costUSD: estimateCost(usage, this.price),
      priceSource: this.price?.source ?? null,
      cached: false,
      thinking: reasoningConfig(this.thinking, this.model),
      maxOutputTokens: budget,
      durationMs: Date.now() - started,
      finishReason,
      ok,
    };
    this.calls.push(entry);
    if (!this.ledgerPath) return;
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await appendFile(this.ledgerPath, JSON.stringify(entry) + "\n");
  }

  /** Totals for the run: tokens by kind, estimated cost, cache status, reasoning config. */
  summary() {
    const totals = { calls: this.calls.length, promptTokens: 0, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, totalTokens: 0 };
    let cost = 0;
    let costKnown = Boolean(this.price);
    for (const c of this.calls) {
      for (const k of ["promptTokens", "cachedTokens", "candidatesTokens", "thoughtsTokens", "totalTokens"]) totals[k] += c[k];
      if (c.costUSD == null) costKnown = false;
      else cost += c.costUSD;
    }
    return {
      provider: "openai",
      model: this.model,
      ...totals,
      estimatedCostUSD: costKnown ? Math.round(cost * 1e6) / 1e6 : null,
      cacheStorageUSD: 0,
      pricingKnown: Boolean(this.price),
      price: this.price ? describePrice(this.price) : null,
      cache: { used: false, reason: this.cacheSkipped },
      thinking: reasoningConfig(this.thinking, this.model),
    };
  }
}
