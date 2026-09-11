/**
 * Built-in Gemini API prices, so a run reports a real estimated cost without any
 * configuration. USD per one million tokens on the standard (non-batch, non-priority)
 * tier for text, image and video input, which is what this tool sends. Output prices
 * include thinking tokens, as the API bills them. `storagePerHour` is the explicit
 * context-cache storage price per million tokens per hour. `longThreshold` and
 * `long` give the higher rates a model charges for the whole call when the prompt
 * exceeds the threshold. `tiers` lists price periods for models with an announced
 * change; the tier whose `from` date is the latest one at or before the call applies.
 *
 * Sources: the official Gemini and OpenAI pricing pages, read on the date below. Prices change; the
 * `pricing` block of the config overrides any model here, and `ui-critic models`
 * shows what will be used.
 */
export const PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing and https://developers.openai.com/api/docs/pricing";
export const PRICING_AS_OF = "2026-09-11";

const flash38 = {
  tiers: [
    { from: "2000-01-01", input: 0.75, output: 3.75, cached: 0.075, storagePerHour: 0.5 },
    { from: "2027-01-01", input: 1.5, output: 7.5, cached: 0.15, storagePerHour: 1.0 },
  ],
};

export const BUILT_IN_PRICING = {
  // Current generation
  "gemini-3.8-flash": flash38,
  "gemini-3.7-flash": flash38,
  "gemini-3.6-flash": flash38,
  "gemini-3.5-flash": { input: 1.5, output: 9.0, cached: 0.15, storagePerHour: 1.0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03, storagePerHour: 1.0 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025, storagePerHour: 1.0 },
  "gemini-3.1-pro-preview": {
    input: 2.0,
    output: 12.0,
    cached: 0.2,
    storagePerHour: 4.5,
    longThreshold: 200_000,
    long: { input: 4.0, output: 18.0, cached: 0.4 },
  },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0, cached: 0.05, storagePerHour: 1.0 },
  // Image-capable generation models, text output only (image output is priced per image)
  "gemini-3.1-flash-image": { input: 0.5, output: 3.0 },
  "gemini-3.1-flash-lite-image": { input: 0.25, output: 1.5 },
  "gemini-3-pro-image": { input: 2.0, output: 12.0 },
  // Omni
  "gemini-omni-1.1-flash": { input: 1.5, output: 9.0 },
  "gemini-omni-flash-preview": { input: 1.5, output: 9.0 },
  // Previous generation
  "gemini-2.5-pro": {
    input: 1.25,
    output: 10.0,
    cached: 0.125,
    storagePerHour: 4.5,
    longThreshold: 200_000,
    long: { input: 2.5, output: 15.0, cached: 0.25 },
  },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03, storagePerHour: 1.0 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cached: 0.01, storagePerHour: 1.0 },
  "gemini-2.5-computer-use-preview": {
    input: 1.25,
    output: 10.0,
    longThreshold: 200_000,
    long: { input: 2.5, output: 15.0 },
  },
  // Robotics (generateContent-capable)
  "gemini-robotics-er-2-preview": {
    tiers: [
      { from: "2000-01-01", input: 1.0, output: 5.0, cached: 0.1, storagePerHour: 0.5 },
      { from: "2027-01-01", input: 2.0, output: 10.0, cached: 0.2, storagePerHour: 1.0 },
    ],
  },
  "gemini-robotics-er-1.6-preview": { input: 1.0, output: 5.0 },

  // OpenAI (standard tier; cached input is the cached rate; reasoning tokens bill as output)
  "gpt-6-astra": { input: 10.0, output: 50.0, cached: 1.0 },
  "gpt-5.6-sol": { input: 4.0, output: 20.0, cached: 0.4 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0, cached: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cached: 0.02 },
  "gpt-5.5": { input: 5.0, output: 30.0, cached: 0.5 },
  "gpt-5.5-pro": { input: 30.0, output: 180.0 },
  "gpt-5.4": { input: 2.5, output: 15.0, cached: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cached: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cached: 0.02 },
  "gpt-5.4-pro": { input: 30.0, output: 180.0 },
  "gpt-5.2": { input: 1.75, output: 14.0, cached: 0.175 },
  "gpt-5.1": { input: 1.25, output: 10.0, cached: 0.125 },
  "gpt-5": { input: 1.25, output: 10.0, cached: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2.0, cached: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cached: 0.005 },
  o1: { input: 15.0, output: 60.0, cached: 7.5 },
  "o1-pro": { input: 150.0, output: 600.0 },
  "o3-pro": { input: 20.0, output: 80.0 },
  o3: { input: 2.0, output: 8.0, cached: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cached: 0.275 },
  "o3-mini": { input: 1.1, output: 4.4, cached: 0.55 },
  "gpt-4.1": { input: 2.0, output: 8.0, cached: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cached: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cached: 0.025 },
  "gpt-4o": { input: 2.5, output: 10.0, cached: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
};

/** The model id without the API's `models/` prefix. */
function bareId(model) {
  return String(model ?? "").replace(/^models\//, "").trim();
}

/** Whether `key` names `id` exactly or is a dash-delimited prefix of it. */
function keyMatches(key, id) {
  return id === key || id.startsWith(`${key}-`);
}

/** The longest key in `table` that names the model; null when none does. */
export function matchKey(table, model) {
  const id = bareId(model);
  let best = null;
  for (const key of Object.keys(table ?? {})) {
    if (keyMatches(key, id) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/** A usable price entry: one with numeric input and output prices. */
function usable(entry) {
  return Boolean(entry) && typeof entry.input === "number" && typeof entry.output === "number";
}

/** The tier of an entry that applies on a date (the latest `from` at or before it). */
function tierFor(entry, date) {
  if (!entry?.tiers) return entry;
  const day = (date instanceof Date ? date : new Date(date ?? Date.now())).toISOString().slice(0, 10);
  let chosen = null;
  for (const tier of entry.tiers) {
    if (tier.from <= day && (!chosen || tier.from >= chosen.from)) chosen = tier;
  }
  return chosen ?? entry.tiers[0];
}

/**
 * Resolves the price for a model: the config's `pricing` first (exact id or a
 * dash-delimited prefix, ignored when its input or output is null), then the
 * built-in table, with the price period that applies on `date`. Returns null when
 * nothing matches, so a cost is never invented.
 */
export function resolvePrice(model, overrides = {}, date = new Date()) {
  const fromConfig = matchKey(overrides, model);
  if (fromConfig) {
    const tier = tierFor(overrides[fromConfig], date);
    if (usable(tier)) return { ...tier, key: fromConfig, source: "config" };
  }
  const key = matchKey(BUILT_IN_PRICING, model);
  if (!key) return null;
  const tier = tierFor(BUILT_IN_PRICING[key], date);
  const base = BUILT_IN_PRICING[key];
  return usable(tier)
    ? { ...tier, longThreshold: tier.longThreshold ?? base.longThreshold, long: tier.long ?? base.long, key, source: "built-in", asOf: PRICING_AS_OF }
    : null;
}

/**
 * Estimates the USD cost of one call from its token counts and a resolved price.
 * Cached prompt tokens are billed at the cached rate, the rest of the prompt at the
 * input rate, and candidates plus thinking at the output rate. A prompt over the
 * model's long-context threshold pays the long rates for the whole call. Returns
 * null when there is no price.
 */
export function estimateCost(usage, price) {
  if (!usable(price)) return null;
  const rates =
    price.longThreshold && price.long && usage.promptTokens > price.longThreshold
      ? { input: price.long.input ?? price.input, output: price.long.output ?? price.output, cached: price.long.cached ?? price.cached ?? price.long.input ?? price.input }
      : { input: price.input, output: price.output, cached: price.cached ?? price.input };
  const cachedTokens = usage.cachedTokens ?? 0;
  const uncached = Math.max(0, (usage.promptTokens ?? 0) - cachedTokens);
  const cost =
    (uncached / 1e6) * rates.input +
    (cachedTokens / 1e6) * rates.cached +
    (((usage.candidatesTokens ?? 0) + (usage.thoughtsTokens ?? 0)) / 1e6) * rates.output;
  return Math.round(cost * 1e6) / 1e6;
}

/** The storage cost of an explicit cache of `tokens` tokens kept for `seconds`. */
export function cacheStorageCost(tokens, seconds, price) {
  if (!price || typeof price.storagePerHour !== "number" || !tokens || !seconds) return 0;
  return Math.round((tokens / 1e6) * price.storagePerHour * (seconds / 3600) * 1e6) / 1e6;
}

/** A short human description of a price for reports: "$0.75/M in, $3.75/M out, $0.075/M cached". */
export function describePrice(price) {
  if (!usable(price)) return "no price";
  const parts = [`$${price.input}/M in`, `$${price.output}/M out`];
  if (typeof price.cached === "number") parts.push(`$${price.cached}/M cached`);
  const origin = price.source === "config" ? "from config" : `built-in, as of ${price.asOf ?? PRICING_AS_OF}`;
  return `${parts.join(", ")} (${origin})`;
}
