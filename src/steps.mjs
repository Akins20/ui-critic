import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The interaction vocabulary for scenarios and login flows. Each step is an object
 * with exactly one of these keys:
 *   { goto: "/path" }                       navigate within the same base
 *   { click: "selector" }                   click (Playwright selector syntax)
 *   { hover: "selector" }                   hover, for hover states
 *   { focus: "selector" }                   keyboard focus, for focus rings
 *   { fill: { selector, value } }           type a literal value
 *   { fill: { selector, envVar } }          type a secret read from the environment
 *   { press: "Tab" }                        press a key on the focused element
 *   { wait: 300 }                           wait milliseconds
 *   { waitFor: "selector" }                 wait until a selector is visible
 *   { waitForURL: "glob" }                  wait for a URL glob, e.g. two stars, slash, account, two stars
 *   { scroll: 600 }                         scroll the window vertically
 * Secrets never appear in config or logs: a fill with envVar names the variable,
 * and the value comes from the process environment or the auth env file.
 */
export const STEP_KEYS = ["goto", "click", "hover", "focus", "fill", "press", "wait", "waitFor", "waitForURL", "scroll"];

/** Validates a list of steps, returning a list of problems (empty when valid). */
export function stepProblems(steps, where = "steps") {
  const problems = [];
  if (!Array.isArray(steps)) return [`${where} must be a list`];
  steps.forEach((step, i) => {
    const keys = Object.keys(step ?? {}).filter((k) => STEP_KEYS.includes(k));
    if (keys.length !== 1) {
      problems.push(`${where}[${i}] must have exactly one of ${STEP_KEYS.join(", ")}`);
      return;
    }
    const key = keys[0];
    const value = step[key];
    if (key === "fill") {
      if (!value || typeof value.selector !== "string") problems.push(`${where}[${i}].fill needs a selector`);
      if (!(typeof value?.value === "string" || typeof value?.envVar === "string")) problems.push(`${where}[${i}].fill needs value or envVar`);
    } else if (key === "wait" || key === "scroll") {
      if (!(Number.isFinite(value) && value >= 0)) problems.push(`${where}[${i}].${key} must be a non-negative number`);
    } else if (typeof value !== "string" || !value) {
      problems.push(`${where}[${i}].${key} must be a non-empty string`);
    }
  });
  return problems;
}

/**
 * Reads KEY=VALUE lines from an env file into a plain map (quotes stripped, blank
 * lines and comments ignored). Nothing is placed in process.env and nothing is
 * logged; the map only feeds fills that name an envVar.
 */
export async function readEnvFile(file) {
  const map = {};
  if (!file) return map;
  let raw;
  try {
    raw = await readFile(path.resolve(file), "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    map[m[1]] = value;
  }
  return map;
}

/** A secret by variable name, from the process environment first, then the env file map. */
export function secretFrom(name, fileEnv = {}) {
  return process.env[name] ?? fileEnv[name] ?? null;
}

/**
 * The first visible match for a selector, falling back to the first match. A
 * responsive page often renders the same control twice (a desktop and a mobile
 * header, say) with one hidden, and a click on the hidden one only times out.
 */
export async function visibleFirst(page, selector) {
  const all = page.locator(selector);
  const count = await all.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = all.nth(i);
    if (await candidate.isVisible()) return candidate;
  }
  return all.first();
}

/**
 * Runs steps on a page. Secrets come from `secrets` (a map of env var name to
 * value); a fill whose envVar is missing throws a clear error naming the variable,
 * never its value. Returns a short human log of what was done, without values.
 */
export async function runSteps(page, steps, { base, secrets = {} } = {}) {
  const log = [];
  for (const step of steps ?? []) {
    if (step.goto) {
      await page.goto(new URL(step.goto, base).toString(), { waitUntil: "networkidle", timeout: 60_000 }).catch(() => page.goto(new URL(step.goto, base).toString(), { waitUntil: "load" }));
      log.push(`goto ${step.goto}`);
    } else if (step.click) {
      await (await visibleFirst(page, step.click)).click({ timeout: 15_000 });
      log.push(`click ${step.click}`);
    } else if (step.hover) {
      await (await visibleFirst(page, step.hover)).hover({ timeout: 15_000 });
      log.push(`hover ${step.hover}`);
    } else if (step.focus) {
      await (await visibleFirst(page, step.focus)).focus({ timeout: 15_000 });
      log.push(`focus ${step.focus}`);
    } else if (step.fill) {
      const { selector, value, envVar } = step.fill;
      const text = envVar ? secretFrom(envVar, secrets) : value;
      if (envVar && text == null) throw new Error(`fill needs the environment variable ${envVar}, which is not set`);
      await (await visibleFirst(page, selector)).fill(text, { timeout: 15_000 });
      log.push(envVar ? `fill ${selector} from ${envVar}` : `fill ${selector}`);
    } else if (step.press) {
      await page.keyboard.press(step.press);
      log.push(`press ${step.press}`);
    } else if (step.wait !== undefined) {
      await page.waitForTimeout(step.wait);
      log.push(`wait ${step.wait}ms`);
    } else if (step.waitFor) {
      await (await visibleFirst(page, step.waitFor)).waitFor({ state: "visible", timeout: 30_000 });
      log.push(`waitFor ${step.waitFor}`);
    } else if (step.waitForURL) {
      await page.waitForURL(step.waitForURL, { timeout: 30_000 });
      log.push(`waitForURL ${step.waitForURL}`);
    } else if (step.scroll !== undefined) {
      await page.evaluate((y) => window.scrollTo(0, y), step.scroll);
      log.push(`scroll ${step.scroll}`);
    }
  }
  return log;
}

/** Normalises a route entry ("/path" or { path, auth, label }) to an object. */
export function normalizeRoute(entry) {
  if (typeof entry === "string") return { path: entry, auth: false };
  return { path: entry.path, auth: Boolean(entry.auth), label: entry.label };
}
