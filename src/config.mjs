import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Built-in viewports: a common laptop and a common phone (2x for crisp text). */
export const DEFAULT_VIEWPORTS = {
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
};

/**
 * Every knob has a default here, so the tool runs with no config file at all and a
 * coding agent can override exactly the knobs it needs (file, env or flag).
 *
 * thinking.level: "low" | "medium" | "high" (Gemini 3.x thinkingLevel) or "off";
 * thinking.budget: a token budget for models that use thinkingBudget instead;
 * thinking.includeThoughts: keep the model's reasoning in thoughts.md for audit.
 * cache: explicit context caching of the stable prefix (rules, brief, shared
 * screenshots); minTokens is the floor below which caching is skipped, since the
 * API refuses tiny caches. Prompts are also ordered stable-prefix-first so implicit
 * prefix caching applies even when explicit caching is off.
 * pricing: USD per one million tokens per model; unknown models report tokens only.
 */
export const DEFAULTS = {
  base: undefined,
  label: undefined,
  routes: ["/"],
  viewports: DEFAULT_VIEWPORTS,
  out: "ui-critic-out",
  model: "gemini-3.8-flash",
  brief: undefined,
  hideSelectors: [],
  thinking: { level: "high", budget: undefined, includeThoughts: false },
  cache: { enabled: true, ttlSeconds: 3600, minTokens: 2048, keep: false },
  generation: { temperature: 0.3, maxOutputTokens: 32768 },
  pricing: {},
  ledger: "usage.jsonl",
  json: false,
  failOn: undefined,
};

const CONFIG_FILE = "ui-critic.config.json";

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for plain config objects; arrays and scalars are replaced, not merged. */
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** Overrides taken from the environment, all optional. */
export function envOverrides(env = process.env) {
  const o = {};
  if (env.GEMINI_MODEL) o.model = env.GEMINI_MODEL;
  if (env.UI_CRITIC_THINKING) o.thinking = { level: env.UI_CRITIC_THINKING };
  if (env.UI_CRITIC_CACHE === "0" || env.UI_CRITIC_CACHE === "false") o.cache = { enabled: false };
  if (env.UI_CRITIC_OUT) o.out = env.UI_CRITIC_OUT;
  return o;
}

/** Overrides taken from command line flags (parsed by the CLI). */
export function flagOverrides(flags) {
  const o = {};
  if (flags.base) o.base = flags.base;
  if (flags.label) o.label = flags.label;
  if (flags.routes) o.routes = flags.routes.split(",").map((r) => r.trim()).filter(Boolean);
  if (flags.out) o.out = flags.out;
  if (flags.model) o.model = flags.model;
  if (flags.brief) o.brief = flags.brief;
  if (flags["thinking-level"] || flags["include-thoughts"] !== undefined) {
    o.thinking = {};
    if (flags["thinking-level"]) o.thinking.level = flags["thinking-level"];
    if (flags["include-thoughts"] !== undefined) o.thinking.includeThoughts = flags["include-thoughts"];
  }
  if (flags["no-cache"]) o.cache = { enabled: false };
  if (flags.ttl) o.cache = { ...(o.cache ?? {}), ttlSeconds: Number(flags.ttl) };
  if (flags.temperature !== undefined) o.generation = { temperature: Number(flags.temperature) };
  if (flags.json) o.json = true;
  if (flags["fail-on"]) o.failOn = flags["fail-on"];
  return o;
}

const THINKING_LEVELS = new Set(["off", "low", "medium", "high"]);

/** Rejects a config that would fail later in a confusing way. */
export function validate(cfg) {
  if (!THINKING_LEVELS.has(cfg.thinking.level)) {
    throw new Error(`thinking.level must be one of off, low, medium, high (got ${cfg.thinking.level})`);
  }
  if (cfg.thinking.budget !== undefined && !(Number.isInteger(cfg.thinking.budget) && cfg.thinking.budget >= 0)) {
    throw new Error("thinking.budget must be a non-negative integer");
  }
  if (!(cfg.generation.temperature >= 0 && cfg.generation.temperature <= 2)) {
    throw new Error("generation.temperature must be between 0 and 2");
  }
  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) throw new Error("routes must be a non-empty list");
  for (const [name, vp] of Object.entries(cfg.viewports)) {
    if (!(vp.width > 0 && vp.height > 0)) throw new Error(`viewport ${name} needs a positive width and height`);
  }
  return cfg;
}

/**
 * Resolution order, lowest to highest: DEFAULTS, ui-critic.config.json (in the
 * working directory or --config), environment, flags. The brief file is read here so
 * every command receives its text.
 */
export async function loadConfig(flags = {}, env = process.env) {
  const configPath = flags.config ?? path.join(process.cwd(), CONFIG_FILE);
  let file = {};
  try {
    file = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (flags.config || err.code !== "ENOENT") throw new Error(`could not read ${configPath}: ${err.message}`);
  }
  const cfg = validate(merge(merge(merge(DEFAULTS, file), envOverrides(env)), flagOverrides(flags)));
  cfg.configPath = configPath;
  cfg.briefText = cfg.brief ? await readFile(path.resolve(cfg.brief), "utf8") : "";
  return cfg;
}

/**
 * Writes a starter ui-critic.config.json (every default spelled out so it can be
 * edited) and a brief from the template, refusing to overwrite either.
 */
export async function init({ base, cwd = process.cwd() }) {
  const configPath = path.join(cwd, CONFIG_FILE);
  const briefPath = path.join(cwd, "ui-critic", "brief.md");
  const written = [];
  const exists = async (p) => access(p).then(() => true, () => false);
  if (!(await exists(configPath))) {
    const starter = merge(DEFAULTS, {
      base: base ?? "http://localhost:3000",
      routes: ["/"],
      brief: "ui-critic/brief.md",
      hideSelectors: ["nextjs-portal"],
      pricing: { [DEFAULTS.model]: { input: null, output: null, cached: null } },
    });
    delete starter.label;
    delete starter.json;
    delete starter.failOn;
    await writeFile(configPath, JSON.stringify(starter, null, 2) + "\n");
    written.push(configPath);
  }
  if (!(await exists(briefPath))) {
    const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "brief.example.md");
    await mkdir(path.dirname(briefPath), { recursive: true });
    await writeFile(briefPath, await readFile(template, "utf8"));
    written.push(briefPath);
  }
  return written;
}
