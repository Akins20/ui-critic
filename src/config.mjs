import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stepProblems, normalizeRoute } from "./steps.mjs";
import { nativeStepProblems, nativeRouteProblems } from "./native/steps.mjs";

/** The colour-vision simulations Chromium renders (kept here so config has no browser code). */
const VISION_TYPES = ["achromatopsia", "deuteranopia", "protanopia", "tritanopia", "blurredVision", "reducedContrast"];

/** What a capture can be of: a website, an Android app, an iOS app. */
export const PLATFORMS = ["web", "android", "ios"];

/**
 * Android capture knobs. package is the application id; serial picks the device
 * when more than one is connected (the tool refuses to guess); adb is found in the
 * SDK when not given. coldStart force-stops the app before each screen so every
 * capture starts clean (app data is never cleared, so a signed-in session stays);
 * cleanStatusBar freezes the clock and icons, disableAnimations turns the system
 * animation scales off, and both are restored afterwards. scrollFrames is how many
 * overlapping frames to take of a screen that scrolls, the first screen included.
 */
export const ANDROID_DEFAULTS = {
  package: undefined,
  activity: undefined,
  serial: undefined,
  adb: undefined,
  envFile: undefined,
  coldStart: true,
  cleanStatusBar: true,
  disableAnimations: true,
  scrollFrames: 3,
  settleTimeoutMs: 8000,
  waitForTimeoutMs: 30_000,
};

/** iOS Simulator capture knobs (experimental): the app's bundle id and the simulator's udid. */
export const IOS_DEFAULTS = {
  bundleId: undefined,
  udid: undefined,
  cleanStatusBar: true,
  settleMs: 1500,
};

/**
 * The accessibility variants --a11y adds beside the configured viewports, built
 * from them: 320px reflow (WCAG 1.4.10), 200% zoom (1.4.4), raised text spacing
 * (1.4.12) and a colour-vision simulation on the phone, forced colours (Windows
 * high contrast) on the desktop, and the dark scheme when no viewport has it.
 * Scenarios and the interaction sweep skip them unless a scenario names one.
 */
export function a11yViewports(viewports) {
  const all = Object.values(viewports ?? {});
  const desk = all.find((v) => !v.isMobile) ?? DEFAULT_VIEWPORTS.desktop;
  const phone = all.find((v) => v.isMobile) ?? DEFAULT_VIEWPORTS.mobile;
  const base = (vp) => ({ width: vp.width, height: vp.height, deviceScaleFactor: vp.deviceScaleFactor ?? 1, isMobile: Boolean(vp.isMobile), a11yPreset: true });
  const out = {
    "reflow-320": { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, a11yPreset: true },
    "zoom-200": { ...base(desk), zoom: 2 },
    "text-spacing": { ...base(phone), textSpacing: true },
    "forced-colors": { ...base(desk), forcedColors: true },
    deuteranopia: { ...base(phone), vision: "deuteranopia" },
  };
  if (!all.some((v) => v.colorScheme === "dark")) out.dark = { ...base(desk), colorScheme: "dark" };
  return out;
}

/** A native capture's viewports are variants of the one device; the default is the device as it is. */
export const NATIVE_VIEWPORTS = { phone: {} };

/** The disciplines for an app: the web list with platform conventions in place of breakpoints. */
export const NATIVE_DISCIPLINES = [
  "layout and grid: alignment, margins and keylines, balance, use of the screen",
  "spacing and rhythm: padding consistency, grouping by proximity, list density",
  "typography: type scale, hierarchy, weights, line length, truncation, scaling with the system font size",
  "colour and contrast: palette use, emphasis, contrast ratios, light and dark theme parity",
  "surfaces, dividers and elevation: cards, sheets, dividers, shadows, radii, when a container earns its place",
  "imagery and iconography: crop, aspect, quality, icon style and meaning, platform icon conventions",
  "components and states: buttons, fields, chips, switches, lists; pressed, focused, disabled, loading, empty, error",
  "navigation and wayfinding: app bar, back behaviour, tabs, bottom navigation, where am I and how do I go back",
  "content and microcopy: clarity, tone, labels, numbers and money formatting",
  "conversion and primary actions: primary action clarity, friction, order of information",
  "trust and credibility: authenticity, payment security, permissions asked in context, policies",
  "motion and feedback: transitions, loading feedback, reduced motion",
  "accessibility: screen reader labels, touch targets of at least 48dp, contrast, text scaling, focus order",
  "platform conventions and ergonomics: Material or Human Interface patterns, system bars and insets, gestures, thumb reach, keyboard handling",
  "consistency across screens: the same thing looks and behaves the same everywhere",
];

const IOS_CONTENT_SIZES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
];

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
  platform: "web",
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
  android: ANDROID_DEFAULTS,
  ios: IOS_DEFAULTS,
  // The design-system lint (free, measured): the spacing grid, how many sizes,
  // families, radii and shadows are too many, how close a colour must be to a token
  // to count as drift (CIEDE2000), and an optional tokens file (a flat map or W3C
  // design tokens) beside the custom properties the pages declare.
  lint: { spacingBase: 4, maxFamilies: 2, maxSizes: 8, maxRadii: 4, maxShadows: 3, nearDelta: 3, tokens: undefined },
  // The interaction sweep on viewports with a mouse: hover up to maxHover controls,
  // and walk the page with up to maxTabs presses of Tab. Nothing is clicked.
  sweep: { enabled: true, maxHover: 20, maxTabs: 60 },
  // Add the accessibility variants (reflow, zoom, text spacing, forced colours, a
  // colour-vision simulation, dark) beside the configured viewports; --a11y.
  a11y: false,
  // Competitors to review beside the product, each mapping our routes to theirs:
  // [{ "name": "Jumia", "base": "https://www.jumia.com.ng", "routes": { "/": "/" } }]
  benchmarks: [],
  // The design to check the build against: a Figma file key or share link, an
  // optional map from route (or "route@viewport") to frame id when the frame names
  // do not say which screen they are, and the scale the frames are rendered at.
  // The token comes from FIGMA_TOKEN, never from this file.
  figma: { file: undefined, frames: {}, scale: 2 },
  // Review the components instead of the pages: the stories of a running Storybook
  // become the routes. Without `include`, one story per component is taken; `all`
  // takes every one. `include` and `exclude` are plain text matched against
  // "Title/Name" and the story id.
  storybook: { url: undefined, include: [], exclude: [], all: false, limit: 40 },
  fromImages: undefined,
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

/**
 * Undoes Git Bash's path conversion. Under Git Bash (MSYS) an argument that starts
 * with "/" is rewritten into the Windows path of its install folder, so --routes
 * /shop arrives as C:/Program Files/Git/shop and the capture opens nothing. When
 * MSYSTEM says the shell is MSYS, such a route is turned back into the path it was.
 */
export function unmangleRoute(route, env = process.env) {
  if (!env.MSYSTEM) return route;
  const m = /^[A-Za-z]:[\\/](?:.*?[\\/])?(?:Git|msys64|msys2|mingw64)(?:[\\/](.*))?$/i.exec(route);
  if (!m) return route;
  return `/${(m[1] ?? "").replace(/\\/g, "/")}`;
}

/** Overrides taken from command line flags (parsed by the CLI). */
export function flagOverrides(flags, env = process.env) {
  const o = {};
  if (flags.base) o.base = flags.base;
  if (flags.label) o.label = flags.label;
  if (flags.routes) {
    o.routes = flags.routes
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const fixed = unmangleRoute(r, env);
        if (fixed !== r) process.stderr.write(`ui-critic: Git Bash rewrote the route ${fixed} as ${r}; using ${fixed}\n`);
        return fixed;
      });
  }
  if (flags.storybook) o.storybook = { url: flags.storybook };
  if (flags.stories) o.storybook = { ...(o.storybook ?? {}), include: flags.stories.split(",").map((s) => s.trim()).filter(Boolean) };
  if (flags["all-stories"]) o.storybook = { ...(o.storybook ?? {}), all: true };
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
  if (flags.platform) o.platform = flags.platform;
  if (flags.package || flags.serial) o.android = { ...(flags.package ? { package: flags.package } : {}), ...(flags.serial ? { serial: flags.serial } : {}) };
  if (flags["bundle-id"] || flags.udid) o.ios = { ...(flags["bundle-id"] ? { bundleId: flags["bundle-id"] } : {}), ...(flags.udid ? { udid: flags.udid } : {}) };
  if (flags["from-images"]) o.fromImages = flags["from-images"];
  if (flags["no-sweep"]) o.sweep = { enabled: false };
  if (flags.a11y) o.a11y = true;
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
  if (!PLATFORMS.includes(cfg.platform)) throw new Error(`platform must be one of ${PLATFORMS.join(", ")} (got ${cfg.platform})`);
  const native = cfg.platform !== "web";
  if (!Array.isArray(cfg.routes) || cfg.routes.length === 0) throw new Error("routes must be a non-empty list");
  for (const entry of cfg.routes) {
    const r = normalizeRoute(entry);
    if (typeof r.path !== "string" || !r.path) throw new Error("every route needs a path");
    if (native) {
      const problems = nativeRouteProblems(r.path);
      if (problems.length) throw new Error(problems.join("; "));
    } else if (/^[A-Za-z]:[\\/]/.test(r.path)) {
      throw new Error(
        `route ${r.path} is a Windows path, not a page: a shell such as Git Bash rewrote "/..." into a folder. Put the routes in ui-critic.config.json, or set MSYS_NO_PATHCONV=1 for the command`,
      );
    }
  }
  if (!Array.isArray(cfg.scenarios)) throw new Error("scenarios must be a list");
  cfg.scenarios.forEach((s, i) => {
    if (!s || typeof s.name !== "string" || !s.name) throw new Error(`scenarios[${i}] needs a name`);
    if (native) {
      const routeProblems = nativeRouteProblems(s.route ?? "launch", `scenario ${s.name} route`);
      if (routeProblems.length) throw new Error(routeProblems.join("; "));
    } else if (typeof s.route !== "string" || !s.route) throw new Error(`scenario ${s.name} needs a route`);
    const problems = native ? nativeStepProblems(s.steps, `scenario ${s.name} steps`, cfg.platform) : stepProblems(s.steps, `scenario ${s.name} steps`);
    if (problems.length) throw new Error(problems.join("; "));
    if (s.viewports !== undefined) {
      if (!Array.isArray(s.viewports) || s.viewports.length === 0) throw new Error(`scenario ${s.name} viewports must be a non-empty list`);
      for (const name of s.viewports) if (!cfg.viewports[name]) throw new Error(`scenario ${s.name} names an unknown viewport ${name}`);
    }
  });
  if (cfg.platform === "android") {
    const a = cfg.android ?? {};
    if (a.package !== undefined && !/^[a-zA-Z][\w]*(\.[a-zA-Z_][\w]*)+$/.test(a.package)) throw new Error(`android.package ${a.package} is not an application id such as com.example.app`);
    if (!(Number.isInteger(a.scrollFrames) && a.scrollFrames >= 1 && a.scrollFrames <= 8)) throw new Error("android.scrollFrames must be an integer from 1 to 8");
  }
  if (!native && cfg.auth) {
    if (!["form", "storageState"].includes(cfg.auth.mode)) throw new Error("auth.mode must be form or storageState");
    if (cfg.auth.mode === "storageState" && typeof cfg.auth.path !== "string") throw new Error("auth.path is required for storageState");
    if (cfg.auth.mode === "form") {
      const problems = stepProblems(cfg.auth.steps, "auth.steps");
      if (problems.length) throw new Error(problems.join("; "));
      const literalSecret = (cfg.auth.steps ?? []).some((s) => s.fill && /pass|secret|token/i.test(s.fill.selector) && s.fill.value !== undefined);
      if (literalSecret) throw new Error("auth.steps must not contain a literal password: use fill.envVar and set the variable in the environment or auth.envFile");
    }
  }
  if (!cfg.viewports || typeof cfg.viewports !== "object" || Object.keys(cfg.viewports).length === 0) {
    throw new Error("viewports must name at least one viewport");
  }
  for (const [name, vp] of Object.entries(cfg.viewports)) {
    if (cfg.platform === "android") {
      if (vp.night !== undefined && typeof vp.night !== "boolean") throw new Error(`viewport ${name}: night must be true or false`);
      if (vp.fontScale !== undefined && !(typeof vp.fontScale === "number" && vp.fontScale >= 0.5 && vp.fontScale <= 3)) {
        throw new Error(`viewport ${name}: fontScale must be a number from 0.5 to 3`);
      }
    } else if (cfg.platform === "ios") {
      if (vp.appearance !== undefined && !["light", "dark"].includes(vp.appearance)) throw new Error(`viewport ${name}: appearance must be light or dark`);
      if (vp.contentSize !== undefined && !IOS_CONTENT_SIZES.includes(vp.contentSize)) {
        throw new Error(`viewport ${name}: contentSize must be one of ${IOS_CONTENT_SIZES.join(", ")}`);
      }
    } else {
      if (!(vp.width > 0 && vp.height > 0)) throw new Error(`viewport ${name} needs a positive width and height`);
      if (vp.zoom !== undefined && !(typeof vp.zoom === "number" && vp.zoom >= 1 && vp.zoom <= 4)) throw new Error(`viewport ${name}: zoom must be a number from 1 to 4`);
      if (vp.vision !== undefined && !VISION_TYPES.includes(vp.vision)) throw new Error(`viewport ${name}: vision must be one of ${VISION_TYPES.join(", ")}`);
      if (vp.colorScheme !== undefined && !["light", "dark", "no-preference"].includes(vp.colorScheme)) throw new Error(`viewport ${name}: colorScheme must be light or dark`);
      for (const flag of ["forcedColors", "textSpacing"]) {
        if (vp[flag] !== undefined && typeof vp[flag] !== "boolean") throw new Error(`viewport ${name}: ${flag} must be true or false`);
      }
    }
  }
  if (!(Number.isInteger(cfg.followRequests.maxPages) && cfg.followRequests.maxPages >= 0)) {
    throw new Error("followRequests.maxPages must be a non-negative integer");
  }
  if (cfg.benchmarks !== undefined) {
    if (!Array.isArray(cfg.benchmarks)) throw new Error("benchmarks must be a list");
    cfg.benchmarks.forEach((b, i) => {
      if (!b || typeof b.name !== "string" || !b.name.trim()) throw new Error(`benchmarks[${i}] needs a name`);
      if (typeof b.base !== "string" || !/^https?:\/\//i.test(b.base)) throw new Error(`benchmarks[${i}].base must be an http(s) URL`);
      if (!b.routes || typeof b.routes !== "object" || Array.isArray(b.routes) || !Object.keys(b.routes).length) {
        throw new Error(`benchmarks[${i}].routes must map your routes to theirs, such as { "/": "/" }`);
      }
    });
  }
  if (cfg.figma) {
    if (cfg.figma.file !== undefined && (typeof cfg.figma.file !== "string" || !cfg.figma.file.trim())) throw new Error("figma.file must be a Figma file key or share link");
    if (cfg.figma.frames !== undefined && (typeof cfg.figma.frames !== "object" || Array.isArray(cfg.figma.frames))) {
      throw new Error('figma.frames must map a route to a frame id, such as { "/": "12:34" }');
    }
    if (cfg.figma.scale !== undefined && !(cfg.figma.scale >= 0.5 && cfg.figma.scale <= 4)) throw new Error("figma.scale must be between 0.5 and 4");
    if (/^figd_|^figu_/.test(String(cfg.figma.file ?? ""))) throw new Error("figma.file looks like a token: the token belongs in FIGMA_TOKEN, never in the config");
  }
  if (cfg.storybook?.url !== undefined) {
    if (typeof cfg.storybook.url !== "string" || !/^https?:\/\//i.test(cfg.storybook.url)) throw new Error("storybook.url must be an http(s) URL of a running Storybook");
    for (const key of ["include", "exclude"]) {
      if (cfg.storybook[key] !== undefined && !Array.isArray(cfg.storybook[key])) throw new Error(`storybook.${key} must be a list of text to match`);
    }
    if (cfg.storybook.limit !== undefined && !(Number.isInteger(cfg.storybook.limit) && cfg.storybook.limit > 0)) throw new Error("storybook.limit must be a positive whole number of stories");
  }
  if (cfg.lint) {
    if (!(Number.isInteger(cfg.lint.spacingBase) && cfg.lint.spacingBase > 0)) throw new Error("lint.spacingBase must be a positive integer of pixels");
    if (!(cfg.lint.nearDelta > 0 && cfg.lint.nearDelta <= 20)) throw new Error("lint.nearDelta must be a colour difference from 0 to 20");
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
  const merged = merge(merge(merge(DEFAULTS, file), envOverrides(env)), flagOverrides(flags));
  // A config that names its viewports means exactly those. The deep merge would
  // otherwise keep the built-in desktop and mobile entries beside them, so a
  // phone-only review still captured a desktop pass.
  if (file.viewports && typeof file.viewports === "object") merged.viewports = file.viewports;
  // An app is captured on one device, its first screen is its launch screen, and
  // its disciplines speak of platform conventions rather than breakpoints.
  if (merged.platform !== "web") {
    if (!file.viewports) merged.viewports = NATIVE_VIEWPORTS;
    if (!file.disciplines) merged.disciplines = NATIVE_DISCIPLINES;
    if (!file.routes && !flags.routes) merged.routes = ["launch"];
  } else if (merged.a11y) {
    // Added after the configured viewports; a configured name is never replaced.
    const extra = Object.entries(a11yViewports(merged.viewports)).filter(([name]) => !(name in merged.viewports));
    merged.viewports = { ...merged.viewports, ...Object.fromEntries(extra) };
  }
  const cfg = validate(merged);
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
export async function init({ base, platform = "web", pkg, cwd = process.cwd() }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`platform must be one of ${PLATFORMS.join(", ")}`);
  const configPath = path.join(cwd, CONFIG_FILE);
  const briefPath = path.join(cwd, "ui-critic", "brief.md");
  const written = [];
  const exists = async (p) => access(p).then(() => true, () => false);
  if (!(await exists(configPath))) {
    const starter = merge(DEFAULTS, { platform, pricing: {} });
    if (platform === "web") {
      starter.base = base ?? "http://localhost:3000";
      starter.routes = ["/"];
      starter.hideSelectors = ["nextjs-portal"];
    } else {
      // Set, not merged: a merge would keep the web viewports beside the device.
      starter.routes = ["launch"];
      starter.viewports = { phone: {}, "phone-dark": platform === "android" ? { night: true } : { appearance: "dark" } };
      starter.disciplines = NATIVE_DISCIPLINES;
      if (platform === "android") starter.android = { ...ANDROID_DEFAULTS, package: pkg ?? "com.example.app" };
      if (platform === "ios") starter.ios = { ...IOS_DEFAULTS, bundleId: pkg ?? "com.example.app" };
      for (const k of ["base", "hideSelectors", "auth", "followRequests"]) delete starter[k];
    }
    if (platform !== "android") delete starter.android;
    if (platform !== "ios") delete starter.ios;
    delete starter.label;
    delete starter.json;
    delete starter.failOn;
    delete starter.fromImages;
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
