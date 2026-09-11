import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stepProblems, normalizeRoute } from "./steps.mjs";

/** Built-in viewports: a common laptop and a common phone (2x for crisp text). */
export const DEFAULT_VIEWPORTS = {
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
};

/**
 * The design disciplines the critic must sweep on every page and account for, one
 * by one, so a review never silently skips typography or spacing because a bigger
 * conversion issue caught its eye. Replace the list in the config to suit a product.
 */
export const DEFAULT_DISCIPLINES = [
  "layout and grid: alignment, columns, gutters, balance, use of width",
  "spacing and rhythm: vertical rhythm, padding consistency, grouping by proximity",
  "typography: type scale, hierarchy, weights, line height, line length, font pairing, letter spacing",
  "colour and contrast: palette use, emphasis, contrast ratios, theme consistency",
  "surfaces, dividers, borders and elevation: cards, rules, shadows, radii, when a container earns its place",
  "imagery and iconography: crop, aspect, quality, icon style and meaning",
  "components and states: buttons, inputs, chips, links; hover, focus, active, disabled, loading, empty, error",
  "navigation and wayfinding: where am I, where can I go, back paths, breadcrumbs, tabs",
  "content and microcopy: clarity, tone, labels, numbers and money formatting",
  "conversion flow and calls to action: primary action clarity, friction, order of information",
  "trust and credibility: authenticity, payment security, policies, contact, social proof",
  "motion and feedback: transitions, loading feedback, reduced motion",
  "accessibility: semantics, headings, landmarks, contrast, target size, focus order, alt text",
  "responsiveness and density: breakpoints, thumb reach, sticky elements, viewport collisions",
  "consistency across pages: same thing looks and behaves the same everywhere",
];

/**
 * Interaction principles every screen must satisfy, product-agnostic, enforced on
 * top of the disciplines. Rewrite the list in the config; the first one is the rule
 * most often broken and most often missed by a screenshot review, so the critic
 * is told to look for it deliberately.
 */
export const DEFAULT_PRINCIPLES = [
  "Every action a user takes gets immediate, visible feedback: pressed and hover states, a loading state while waiting, a clear success or error state after, and nothing that silently does nothing.",
  "One unmistakable primary action per screen; secondary actions look secondary.",
  "The user always knows where they are, what will happen next, and how to go back.",
  "Never lose what the user typed or chose; errors are prevented where possible and recoverable where not, explained in plain words next to the field.",
  "Show real state, never fabricated content: honest empty states, no fake counts, no fake urgency.",
  "Recognition over recall: options, prices and consequences are visible where the decision is made.",
  "Respect the person and the device: reduced motion honoured, thumb reach on phones, targets at least 24px, contrast at least AA.",
  "Consistency: the same element looks and behaves the same everywhere, and a change in one place is a change everywhere.",
];

/**
 * Every knob has a default here, so the tool runs with no config file at all and a
 * coding agent can override exactly the knobs it needs (file, env or flag).
 *
 * brief: the product brief (purpose, audience, brand, constraints). Required for
 * critique and compare: the critic judges against it, never against a generic
 * site. init writes the template at ui-critic/brief.md.
 * context.files: extra text files handed to the critic (design tokens, copy
 * decks, policies). context.answers: where the critic's earlier requests are
 * answered by the team; included when present.
 * followRequests: let the tool capture and review same-origin pages the critic
 * asks for, up to maxPages, in the same run.
 * thinking.level: "low" | "medium" | "high" (Gemini 3.x thinkingLevel) or "off";
 * thinking.budget: a token budget for models that use thinkingBudget instead;
 * thinking.includeThoughts: keep the model's reasoning in thoughts.md for audit.
 * cache: explicit context caching of the stable prefix (rules, brief, context,
 * shared screenshots); minTokens is the floor below which caching is skipped.
 * Prompts are also ordered stable-prefix-first so implicit prefix caching applies
 * even when explicit caching is off.
 * pricing: USD per one million tokens per model, overriding the built-in table in
 * src/pricing.mjs (which covers every current Gemini generation model); a model
 * known to neither reports tokens only.
 */
export const DEFAULTS = {
  base: undefined,
  label: undefined,
  routes: ["/"],
  scenarios: [],
  auth: null,
  viewports: DEFAULT_VIEWPORTS,
  out: "ui-critic-out",
  model: "gemini-3.8-flash",
  brief: "ui-critic/brief.md",
  context: { files: [], answers: "ui-critic/answers.md", decisions: "ui-critic/decisions.md" },
  followRequests: { enabled: false, maxPages: 3 },
  concurrency: 3,
  compare: { confirmRegressions: true },
  provider: undefined,
  disciplines: DEFAULT_DISCIPLINES,
  principles: DEFAULT_PRINCIPLES,
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
  if (env.UI_CRITIC_BRIEF) o.brief = env.UI_CRITIC_BRIEF;
  if (env.UI_CRITIC_CONCURRENCY) o.concurrency = Number(env.UI_CRITIC_CONCURRENCY);
  if (env.UI_CRITIC_PROVIDER) o.provider = env.UI_CRITIC_PROVIDER;
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
  if (flags.context) o.context = { files: flags.context.split(",").map((f) => f.trim()).filter(Boolean) };
  if (flags.answers) o.context = { ...(o.context ?? {}), answers: flags.answers };
  if (flags.decisions) o.context = { ...(o.context ?? {}), decisions: flags.decisions };
  if (flags.concurrency) o.concurrency = Number(flags.concurrency);
  if (flags.provider) o.provider = flags.provider;
  if (flags["no-confirm"]) o.compare = { confirmRegressions: false };
  if (flags["follow-requests"]) o.followRequests = { enabled: true };
  if (flags["max-pages"]) o.followRequests = { ...(o.followRequests ?? {}), maxPages: Number(flags["max-pages"]) };
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
  if (!(Number.isInteger(cfg.concurrency) && cfg.concurrency >= 1 && cfg.concurrency <= 8)) {
    throw new Error("concurrency must be an integer from 1 to 8");
  }
  if (cfg.provider !== undefined && !["gemini", "openai"].includes(cfg.provider)) {
    throw new Error("provider must be gemini or openai");
  }
  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) throw new Error("routes must be a non-empty list");
  for (const entry of cfg.routes) {
    const r = normalizeRoute(entry);
    if (typeof r.path !== "string" || !r.path) throw new Error("every route needs a path");
  }
  if (!Array.isArray(cfg.scenarios)) throw new Error("scenarios must be a list");
  cfg.scenarios.forEach((s, i) => {
    if (!s || typeof s.name !== "string" || !s.name) throw new Error(`scenarios[${i}] needs a name`);
    if (typeof s.route !== "string" || !s.route) throw new Error(`scenario ${s.name} needs a route`);
    const problems = stepProblems(s.steps, `scenario ${s.name} steps`);
    if (problems.length) throw new Error(problems.join("; "));
    if (s.viewports !== undefined) {
      if (!Array.isArray(s.viewports) || s.viewports.length === 0) throw new Error(`scenario ${s.name} viewports must be a non-empty list`);
      for (const name of s.viewports) if (!cfg.viewports[name]) throw new Error(`scenario ${s.name} names an unknown viewport ${name}`);
    }
  });
  if (cfg.auth) {
    if (!["form", "storageState"].includes(cfg.auth.mode)) throw new Error("auth.mode must be form or storageState");
    if (cfg.auth.mode === "storageState" && typeof cfg.auth.path !== "string") throw new Error("auth.path is required for storageState");
    if (cfg.auth.mode === "form") {
      const problems = stepProblems(cfg.auth.steps, "auth.steps");
      if (problems.length) throw new Error(problems.join("; "));
      const literalSecret = (cfg.auth.steps ?? []).some((s) => s.fill && /pass|secret|token/i.test(s.fill.selector) && s.fill.value !== undefined);
      if (literalSecret) throw new Error("auth.steps must not contain a literal password: use fill.envVar and set the variable in the environment or auth.envFile");
    }
  }
  for (const [name, vp] of Object.entries(cfg.viewports)) {
    if (!(vp.width > 0 && vp.height > 0)) throw new Error(`viewport ${name} needs a positive width and height`);
  }
  if (!(Number.isInteger(cfg.followRequests.maxPages) && cfg.followRequests.maxPages >= 0)) {
    throw new Error("followRequests.maxPages must be a non-negative integer");
  }
  if (!Array.isArray(cfg.disciplines) || cfg.disciplines.length === 0) throw new Error("disciplines must be a non-empty list");
  if (!Array.isArray(cfg.principles)) throw new Error("principles must be a list");
  return cfg;
}

/**
 * Whether a route entry (string or object) needs the signed-in context. */
export { normalizeRoute };

/**
 * Resolution order, lowest to highest: DEFAULTS, ui-critic.config.json (in the
 * working directory or --config), environment, flags. The brief file is read here
 * when it exists; whether it is good enough is checked by the commands that need
 * it, with an actionable message.
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
  cfg.briefText = "";
  if (cfg.brief) {
    try {
      cfg.briefText = await readFile(path.resolve(cfg.brief), "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw new Error(`could not read the brief ${cfg.brief}: ${err.message}`);
    }
  }
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
      hideSelectors: ["nextjs-portal"],
      pricing: {},
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
  const decisionsPath = path.join(cwd, "ui-critic", "decisions.md");
  if (!(await exists(decisionsPath))) {
    const template = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "decisions.example.md");
    await mkdir(path.dirname(decisionsPath), { recursive: true });
    await writeFile(decisionsPath, await readFile(template, "utf8"));
    written.push(decisionsPath);
  }
  return written;
}
