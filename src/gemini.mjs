import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API = "https://generativelanguage.googleapis.com/v1beta";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [0, 3000, 8000, 15000];

/** The largest output budget the escalation on MAX_TOKENS will climb to. */
export const MAX_OUTPUT_TOKENS_CEILING = 65_536;

/** The key comes from the environment only; it is never read from disk or logged. */
function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set (export it in your shell; this tool never stores it)");
  }
  return key;
}

function headers() {
  return { "content-type": "application/json", "x-goog-api-key": apiKey() };
}

/** Lists models that support generateContent, optionally filtered by substring. */
export async function listModels(filter) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": apiKey() } });
  if (!res.ok) throw new Error(`models: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ name: m.name.replace(/^models\//, ""), displayName: m.displayName ?? "" }))
    .filter((m) => !filter || m.name.includes(filter));
}

export { imagePart, text } from "./parts.mjs";

/**
 * Maps the tool's thinking config onto the API's thinkingConfig. Gemini 3.x models
 * take thinkingLevel; older models take a thinkingBudget; "off" is a zero budget,
 * which 3.x models accept and ignore (they always think at least at the low level).
 */
export function thinkingConfig(thinking = {}) {
  const out = {};
  if (thinking.budget !== undefined) out.thinkingBudget = thinking.budget;
  else if (thinking.level === "off") out.thinkingBudget = 0;
  else if (thinking.level) out.thinkingLevel = thinking.level;
  if (thinking.includeThoughts) out.includeThoughts = true;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The output budget to retry with after a MAX_TOKENS truncation: double, up to the
 * ceiling; null when the ceiling has already been reached, so the caller stops.
 */
export function nextOutputBudget(current, ceiling = MAX_OUTPUT_TOKENS_CEILING) {
  if (current >= ceiling) return null;
  return Math.min(current * 2, ceiling);
}

/** Normalises usageMetadata into plain counts. */
export function usageOf(meta = {}) {
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    cachedTokens: meta.cachedContentTokenCount ?? 0,
    candidatesTokens: meta.candidatesTokenCount ?? 0,
    thoughtsTokens: meta.thoughtsTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
  };
}

import { resolvePrice, estimateCost, cacheStorageCost, describePrice } from "./pricing.mjs";
export { estimateCost };

/**
 * A client bound to one model and one run: it owns the optional context cache,
 * applies the thinking and generation config to every call, and records every
 * call's tokens and estimated cost in memory and in an append-only ledger.
 */
export class GeminiClient {
  constructor({ model, thinking, generation, cache, pricing, ledgerPath, runLabel }) {
    this.model = model;
    this.thinking = thinking ?? {};
    this.generation = generation ?? {};
    this.cache = cache ?? { enabled: false };
    // The config's pricing block wins over the built-in table; either way the
    // price that applies on the day of the run is fixed at construction.
    this.price = resolvePrice(model, pricing ?? {}, new Date());
    this.ledgerPath = ledgerPath;
    this.runLabel = runLabel ?? "";
    this.cacheName = null;
    this.calls = [];
  }

  /** Counts the tokens of a set of parts, used to decide whether a cache is worth it. */
  async countTokens(parts) {
    const res = await fetch(`${API}/models/${this.model}:countTokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    });
    if (!res.ok) throw new Error(`countTokens: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).totalTokens ?? 0;
  }

  /**
   * Creates an explicit context cache for the stable prefix (rules, brief, shared
   * screenshots) so every subsequent call pays the cached rate for it. Skipped when
   * caching is off or the prefix is below the configured floor; any failure falls
   * back to sending the prefix inline, since caching is an optimisation only.
   */
  async ensureCache(prefixParts, displayName = "ui-critic") {
    if (!this.cache.enabled || this.cacheName) return this.cacheName;
    try {
      const tokens = await this.countTokens(prefixParts);
      if (tokens < (this.cache.minTokens ?? 0)) {
        this.cacheSkipped = `prefix is ${tokens} tokens, below the ${this.cache.minTokens} floor`;
        return null;
      }
      const res = await fetch(`${API}/cachedContents`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: `models/${this.model}`,
          displayName,
          ttl: `${this.cache.ttlSeconds ?? 3600}s`,
          contents: [{ role: "user", parts: prefixParts }],
        }),
      });
      if (!res.ok) {
        this.cacheSkipped = `create failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
        return null;
      }
      const body = await res.json();
      this.cacheName = body.name;
      this.cacheTokens = body.usageMetadata?.totalTokenCount ?? tokens;
      this.cacheCreatedAt = Date.now();
      return this.cacheName;
    } catch (err) {
      this.cacheSkipped = err.message;
      return null;
    }
  }

  /** Deletes the run's cache unless the config asks to keep it for later runs. */
  /** Seconds the explicit cache has been (or will be) stored, for the storage charge. */
  cacheSeconds() {
    if (!this.cacheCreatedAt) return 0;
    const alive = (this.cacheClosedAt ?? Date.now()) - this.cacheCreatedAt;
    // A kept cache is billed until its TTL expires.
    return this.cache.keep ? Math.max(alive / 1000, this.cache.ttlSeconds ?? 3600) : alive / 1000;
  }

  async close() {
    if (!this.cacheName || this.cache.keep) return;
    this.cacheClosedAt = Date.now();
    await fetch(`${API}/${this.cacheName}`, { method: "DELETE", headers: { "x-goog-api-key": apiKey() } }).catch(() => {});
    this.cacheName = null;
  }

  /**
   * One structured call: parts (text and images) after the cached prefix, a
   * response schema the model must satisfy, and parsed JSON back, plus the model's
   * thoughts when includeThoughts is on. Transient failures are retried with
   * backoff. A response cut off by the output budget (thinking tokens count against
   * it on Gemini 3.x) is retried with a doubled budget up to the ceiling, and a
   * blocked prompt or an empty candidate is reported with its reason.
   */
  async generateJSON({ parts, schema, op = "call", temperature, maxOutputTokens }) {
    let budget = maxOutputTokens ?? this.generation.maxOutputTokens ?? 32_768;
    const tc = thinkingConfig(this.thinking);
    let lastErr;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: temperature ?? this.generation.temperature ?? 0.3,
          maxOutputTokens: budget,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      };
      if (tc) body.generationConfig.thinkingConfig = tc;
      if (this.cacheName) body.cachedContent = this.cacheName;

      const started = Date.now();
      const res = await fetch(`${API}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (RETRY_STATUSES.has(res.status)) {
        lastErr = new Error(`gemini: HTTP ${res.status} on attempt ${attempt + 1}`);
        continue;
      }
      if (!res.ok) throw new Error(`gemini: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
      const out = await res.json();
      const candidate = out.candidates?.[0];
      if (!candidate) throw new Error(`gemini: ${out.promptFeedback?.blockReason ?? "no candidate returned"}`);
      const allParts = candidate.content?.parts ?? [];
      const thoughts = allParts.filter((p) => p.thought).map((p) => p.text ?? "").join("\n");
      const raw = allParts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      const usage = usageOf(out.usageMetadata);
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        await this.record({ op, usage, tc, started, finishReason: candidate.finishReason, budget, ok: false });
        if (candidate.finishReason === "MAX_TOKENS") {
          const next = nextOutputBudget(budget);
          if (next === null) throw new Error(`gemini: output still truncated at the ${budget} token ceiling (${op})`);
          process.stderr.write(`  ${op}: output hit ${budget} tokens, retrying with ${next}\n`);
          budget = next;
          continue;
        }
        lastErr = new Error(`gemini: response was not valid JSON (finishReason ${candidate.finishReason})`);
        continue;
      }
      await this.record({ op, usage, tc, started, finishReason: candidate.finishReason, budget, ok: true });
      return { data, usage, thoughts, finishReason: candidate.finishReason };
    }
    throw lastErr ?? new Error("gemini: request failed");
  }

  /** Records one call in memory and, when a ledger path is set, in the JSON-lines ledger. */
  async record({ op, usage, tc, started, finishReason, budget, ok }) {
    const entry = {
      ts: new Date().toISOString(),
      run: this.runLabel,
      provider: "gemini",
      model: this.model,
      op,
      ...usage,
      costUSD: estimateCost(usage, this.price),
      priceSource: this.price?.source ?? null,
      cached: Boolean(this.cacheName),
      thinking: tc ?? null,
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

  /** Totals for the run: tokens by kind (truncated attempts included), estimated cost, cache status. */
  summary() {
    const totals = { calls: this.calls.length, promptTokens: 0, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, totalTokens: 0 };
    let cost = 0;
    let costKnown = Boolean(this.price);
    for (const c of this.calls) {
      for (const k of ["promptTokens", "cachedTokens", "candidatesTokens", "thoughtsTokens", "totalTokens"]) totals[k] += c[k];
      if (c.costUSD == null) costKnown = false;
      else cost += c.costUSD;
    }
    const storage = cacheStorageCost(this.cacheTokens ?? 0, this.cacheSeconds(), this.price);
    return {
      provider: "gemini",
      model: this.model,
      ...totals,
      estimatedCostUSD: costKnown ? Math.round((cost + storage) * 1e6) / 1e6 : null,
      cacheStorageUSD: costKnown ? storage : null,
      pricingKnown: Boolean(this.price),
      price: this.price ? describePrice(this.price) : null,
      cache: this.cacheName
        ? { used: true, tokens: this.cacheTokens ?? null }
        : { used: false, reason: this.cache.enabled ? (this.cacheSkipped ?? "not needed") : "disabled" },
      thinking: thinkingConfig(this.thinking) ?? null,
    };
  }
}
