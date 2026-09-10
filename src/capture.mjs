import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditScript } from "./audit.mjs";
import { runSteps, readEnvFile, normalizeRoute } from "./steps.mjs";

const PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];

/**
 * Loads a Playwright package from the project being reviewed first (so its
 * installed browsers are used), then from the tool's own resolution, accepting any
 * of the packages that export chromium (a CommonJS build exposes it under default).
 * Playwright is optional: critique and compare work on any PNG or JPEG you already
 * have, as long as a manifest.json describes them.
 */
export async function loadPlaywright() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  for (const name of PLAYWRIGHT_PACKAGES) {
    try {
      const mod = await import(pathToFileURL(req.resolve(name)).href);
      const pw = mod.chromium ? mod : mod.default;
      if (pw && pw.chromium) return pw;
    } catch {
      // try the next candidate
    }
  }
  for (const name of PLAYWRIGHT_PACKAGES) {
    try {
      const mod = await import(name);
      const pw = mod.chromium ? mod : mod.default;
      if (pw && pw.chromium) return pw;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "no Playwright found. Run `npm i -D playwright && npx playwright install chromium` in the project, or skip capture and point critique at existing screenshots.",
  );
}

/** A file-safe name for a route: "/" becomes "home", "/products/x" becomes "products-x". */
export function routeSlug(route) {
  const clean = route.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  const query = (route.match(/\?([^#]*)/) ?? [])[1];
  const base = (clean || "home").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return query ? `${base}-q-${query.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : base;
}

/** The name a scenario shot is reviewed under: the route plus the scenario in brackets. */
export function scenarioLabel(route, name) {
  return name ? `${route} [${name}]` : route;
}

/**
 * Hides dev-only chrome, waits for web fonts, scrolls through the page so lazy
 * images load, then returns to the top, so the above-the-fold and full-page
 * captures both show the page as a visitor would see it after a moment.
 */
async function settle(page, hideSelectors) {
  await page.evaluate(async (selectors) => {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) el.style.display = "none";
    }
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const height = document.documentElement.scrollHeight;
    for (let y = 0; y < height; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 100));
    }
    window.scrollTo(0, 0);
  }, hideSelectors);
  await page.waitForTimeout(700);
}

/** Screenshots and audits the page as it is now, under the given slug and label. */
async function shoot({ page, dir, slug, viewportName, route, label, extra = {} }) {
  const fold = path.join(dir, `${slug}.${viewportName}.fold.png`);
  const full = path.join(dir, `${slug}.${viewportName}.full.jpg`);
  const audit = path.join(dir, `${slug}.${viewportName}.audit.json`);
  await page.screenshot({ path: fold, fullPage: false });
  await page.screenshot({ path: full, fullPage: true, type: "jpeg", quality: 80 });
  let facts;
  try {
    facts = await page.evaluate(auditScript);
  } catch (err) {
    facts = { error: err.message };
  }
  await writeFile(audit, JSON.stringify(facts, null, 2));
  return { route: label, path: route, url: page.url(), viewport: viewportName, title: await page.title(), fold, full, audit, ...extra };
}

/**
 * Captures one route in an open browser context: the above-the-fold PNG, the
 * full-page JPEG and the measured audit. Shared by the initial capture and by the
 * follow-up capture of pages the critic asks for.
 */
export async function captureRoute({ page, base, route, viewportName, dir, hideSelectors, auth = false }) {
  const url = new URL(route, base).toString();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  }
  await settle(page, hideSelectors);
  return shoot({ page, dir, slug: routeSlug(route), viewportName, route, label: route, extra: { auth } });
}

/**
 * Captures one scenario: opens its route, runs its steps (a click, a hover, a
 * keyboard focus, an invalid submit), waits for the UI to react, then shoots. The
 * result is reviewed as its own page named "route [scenario]". A step that fails
 * (a selector that never appears) is recorded rather than failing the run, so one
 * fragile scenario cannot cost the whole capture.
 */
export async function captureScenario({ page, base, scenario, viewportName, dir, hideSelectors, secrets }) {
  const url = new URL(scenario.route, base).toString();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  }
  await settle(page, hideSelectors);
  let steps;
  let error = null;
  try {
    steps = await runSteps(page, scenario.steps, { base, secrets });
    await page.waitForTimeout(scenario.settleMs ?? 600);
  } catch (err) {
    error = err.message;
  }
  const slug = `${routeSlug(scenario.route)}.${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const label = scenarioLabel(scenario.route, scenario.name);
  return shoot({ page, dir, slug, viewportName, route: scenario.route, label, extra: { scenario: scenario.name, steps, stepError: error, auth: Boolean(scenario.auth) } });
}

/** Opens a browser context for one named viewport with motion reduced and a light scheme. */
export async function openContext(browser, vp, extra = {}) {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    isMobile: Boolean(vp.isMobile),
    hasTouch: Boolean(vp.isMobile),
    colorScheme: vp.colorScheme ?? "light",
    reducedMotion: "reduce",
    ...extra,
  });
}

/**
 * Builds a signed-in context, or explains why it could not. storageState mode
 * loads a Playwright storage state file the user exported after signing in
 * themselves; form mode runs the configured login steps with credentials read from
 * the environment (or the auth env file) by variable name. Nothing secret is ever
 * logged or written.
 */
async function openAuthContext(browser, vp, auth, base, secrets) {
  if (!auth) return { context: null, reason: "no auth configured" };
  if (auth.mode === "storageState") {
    try {
      const context = await openContext(browser, vp, { storageState: path.resolve(auth.path) });
      return { context, reason: null };
    } catch (err) {
      return { context: null, reason: `storage state ${auth.path} could not be loaded: ${err.message}` };
    }
  }
  const needed = (auth.steps ?? []).map((s) => s.fill?.envVar).filter(Boolean);
  const missing = needed.filter((name) => !(process.env[name] ?? secrets[name]));
  if (missing.length) return { context: null, reason: `auth skipped: ${missing.join(", ")} not set in the environment or the auth env file` };
  const context = await openContext(browser, vp);
  const page = await context.newPage();
  try {
    await page.goto(new URL(auth.login ?? "/login", base).toString(), { waitUntil: "networkidle", timeout: 90_000 });
    await runSteps(page, auth.steps, { base, secrets });
    if (auth.success) await page.waitForURL(auth.success, { timeout: 30_000 });
    await page.close();
    return { context, reason: null };
  } catch (err) {
    await context.close().catch(() => {});
    return { context: null, reason: `auth failed: ${err.message}` };
  }
}

/** Scenarios that apply at a viewport: all of them unless the scenario lists viewports. */
export function scenariosAt(scenarios, viewportName) {
  return scenarios.filter((s) => !s.viewports || s.viewports.includes(viewportName));
}

/**
 * Captures every route and scenario at every viewport: an above-the-fold PNG
 * (what a visitor sees first), a full-page JPEG (layout and rhythm) and a measured
 * audit (fonts, headings, targets, contrast), and writes the manifest.json that
 * critique and compare read. Routes and scenarios marked auth run in a signed-in
 * context when the auth config can sign in; otherwise they are skipped and the
 * reason is recorded. Motion is reduced so carousels and entrance animations do
 * not smear the capture.
 */
export async function capture({ base, routes, scenarios = [], auth = null, viewports, out, label, hideSelectors = [] }) {
  const playwright = await loadPlaywright();
  const dir = path.join(out, label);
  await mkdir(dir, { recursive: true });
  const secrets = await readEnvFile(auth?.envFile);
  const browser = await playwright.chromium.launch();
  const shots = [];
  const skipped = [];
  const entries = routes.map(normalizeRoute);
  try {
    for (const [viewportName, vp] of Object.entries(viewports)) {
      const anon = await openContext(browser, vp);
      const page = await anon.newPage();
      for (const entry of entries.filter((e) => !e.auth)) {
        shots.push(await captureRoute({ page, base, route: entry.path, viewportName, dir, hideSelectors }));
        process.stderr.write(`  ${viewportName.padEnd(8)} ${entry.path}\n`);
      }
      await anon.close();
      // Every scenario starts from a clean context, so a saved wishlist, a
      // switched theme or a typed query never leaks into the next capture.
      for (const scenario of scenariosAt(scenarios, viewportName).filter((s) => !s.auth)) {
        const fresh = await openContext(browser, vp);
        const freshPage = await fresh.newPage();
        const shot = await captureScenario({ page: freshPage, base, scenario, viewportName, dir, hideSelectors, secrets });
        await fresh.close();
        shots.push(shot);
        process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route}${shot.stepError ? ` (step failed: ${shot.stepError.slice(0, 80)})` : ""}\n`);
      }

      const authEntries = entries.filter((e) => e.auth);
      const authScenarios = scenariosAt(scenarios, viewportName).filter((s) => s.auth);
      if (authEntries.length || authScenarios.length) {
        const { context, reason } = await openAuthContext(browser, vp, auth, base, secrets);
        if (!context) {
          skipped.push(...authEntries.map((e) => `${e.path} (${reason})`), ...authScenarios.map((s) => `${scenarioLabel(s.route, s.name)} (${reason})`));
          process.stderr.write(`  ${viewportName.padEnd(8)} signed-in pages skipped: ${reason}\n`);
        } else {
          const session = await context.storageState();
          const authPage = await context.newPage();
          for (const entry of authEntries) {
            shots.push(await captureRoute({ page: authPage, base, route: entry.path, viewportName, dir, hideSelectors, auth: true }));
            process.stderr.write(`  ${viewportName.padEnd(8)} ${entry.path} (signed in)\n`);
          }
          await context.close();
          for (const scenario of authScenarios) {
            const fresh = await openContext(browser, vp, { storageState: session });
            const freshPage = await fresh.newPage();
            const shot = await captureScenario({ page: freshPage, base, scenario, viewportName, dir, hideSelectors, secrets });
            await fresh.close();
            shots.push(shot);
            process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route} (signed in)${shot.stepError ? ` (step failed: ${shot.stepError.slice(0, 80)})` : ""}\n`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  const manifest = { label, base, capturedAt: new Date().toISOString(), viewports, hideSelectors, shots, skipped: Array.from(new Set(skipped)), dir };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Captures extra routes into an existing capture set (the critic asked for them),
 * appending to its manifest. Returns the new shots; an unavailable Playwright is
 * reported rather than thrown, since the follow-up is best effort.
 */
export async function captureMore(manifest, routes) {
  let playwright;
  try {
    playwright = await loadPlaywright();
  } catch (err) {
    return { shots: [], skipped: err.message };
  }
  const browser = await playwright.chromium.launch();
  const shots = [];
  try {
    for (const [viewportName, vp] of Object.entries(manifest.viewports)) {
      const context = await openContext(browser, vp);
      const page = await context.newPage();
      for (const route of routes) {
        shots.push(await captureRoute({ page, base: manifest.base, route, viewportName, dir: manifest.dir, hideSelectors: manifest.hideSelectors ?? [] }));
        process.stderr.write(`  ${viewportName.padEnd(8)} ${route} (requested by the critic)\n`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  manifest.shots.push(...shots);
  await writeFile(path.join(manifest.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { shots, skipped: null };
}
