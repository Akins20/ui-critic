import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditScript } from "./audit.mjs";
import { stylesScript } from "./styles.mjs";
import { sweepPage } from "./sweep.mjs";
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

/** URLs whose failures are a dev server's own chatter, not the page's. */
const NOISE = /webpack-hmr|hot-update|__nextjs|sockjs|\/_next\/static\/development|livereload/;

/**
 * Failure reasons that mean the browser or the page cancelled the request itself
 * (an abandoned prefetch, a navigation away, media it decided not to need), which
 * is not a failure of the page. Chromium, Firefox and WebKit each spell it their way.
 */
const ABORTED = /ERR_ABORTED|NS_BINDING_ABORTED|cancel/i;

/**
 * Collects what a screenshot cannot show while a page loads and settles: console
 * errors, uncaught exceptions, failed requests, HTTP errors and cumulative layout
 * shift (measured in-page from the first navigation on). Attach before the first
 * navigation of a page; call reset() before each capture and read() after it.
 */
export function attachRuntimeCollectors(page) {
  const state = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") state.consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => state.pageErrors.push(String(err?.message ?? err).slice(0, 200)));
  page.on("requestfailed", (req) => {
    const url = req.url();
    const reason = req.failure()?.errorText ?? "failed";
    if (NOISE.test(url) || ABORTED.test(reason)) return;
    state.failedRequests.push(`${url.slice(0, 160)} (${reason})`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (res.status() >= 400 && !NOISE.test(url)) state.httpErrors.push(`${res.status()} ${url.slice(0, 160)}`);
  });
  return {
    reset() {
      for (const k of Object.keys(state)) state[k].length = 0;
    },
    async read() {
      let cls = null;
      try {
        cls = await page.evaluate(() => (typeof window.__uiCriticCLS === "number" ? Math.round(window.__uiCriticCLS * 1000) / 1000 : null));
      } catch {
        // page gone or script blocked: no layout shift figure
      }
      return summarizeRuntime(state, cls);
    },
  };
}

/** The compact, deduplicated runtime record stored beside the audit facts. */
export function summarizeRuntime(state, cls) {
  const uniq = (list, cap = 10) => Array.from(new Set(list)).slice(0, cap);
  return {
    consoleErrors: uniq(state.consoleErrors),
    pageErrors: uniq(state.pageErrors),
    failedRequests: uniq(state.failedRequests),
    httpErrors: uniq(state.httpErrors),
    cls,
  };
}

/** Installed once per page: accumulates layout shift from the first paint on. */
const CLS_SCRIPT = `(() => {
  window.__uiCriticCLS = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__uiCriticCLS += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
})();`;

/** Prepares a page for capture: the layout-shift meter and the runtime collectors. */
export async function instrumentPage(page) {
  if (page.__uiCriticRuntime) return page.__uiCriticRuntime;
  await page.addInitScript(CLS_SCRIPT);
  page.__uiCriticRuntime = attachRuntimeCollectors(page);
  return page.__uiCriticRuntime;
}

/** Page titles that bot-protection services show instead of the page. */
const CHALLENGE_TITLE = /^(just a moment|attention required|access denied|security check|are you a robot|pardon our interruption|request blocked|one more step|ddos-guard)/i;
/** Phrases only a challenge page says; a login page that merely uses reCAPTCHA does not. */
const CHALLENGE_TEXT = /(verify(ing)? you are (a )?human|checking your browser before|enable javascript and cookies to continue|performing security verification)/i;

/**
 * Whether the browser was shown a bot check instead of the page, and why. A review
 * of a challenge page is worthless, so such captures are kept but never judged.
 */
export function blockedReason(title, bodyText) {
  if (CHALLENGE_TITLE.test(String(title ?? "").trim())) return `the site served a bot check ("${String(title).trim().slice(0, 60)}")`;
  if (CHALLENGE_TEXT.test(String(bodyText ?? ""))) return "the site served a bot check (a human-verification page)";
  return null;
}

/** Screenshots and audits the page as it is now, under the given slug and label. */
async function shoot({ page, dir, slug, viewportName, route, label, extra = {}, runtime = null, sweep = null }) {
  const fold = path.join(dir, `${slug}.${viewportName}.fold.png`);
  const full = path.join(dir, `${slug}.${viewportName}.full.jpg`);
  const audit = path.join(dir, `${slug}.${viewportName}.audit.json`);
  await page.screenshot({ path: fold, fullPage: false });
  // A full-page shot stretches the viewport, so a bar fixed to the bottom edge
  // would be painted over the footer. Hide those for the full shot only; the
  // first-screen capture shows them where a visitor sees them.
  const hiddenFixed = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.bottom < window.innerHeight - 2 || r.top < 2) continue;
      el.setAttribute("data-ui-critic-hidden", el.style.visibility || "");
      el.style.visibility = "hidden";
      n += 1;
    }
    return n;
  });
  await page.screenshot({ path: full, fullPage: true, type: "jpeg", quality: 80 });
  if (hiddenFixed > 0) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("[data-ui-critic-hidden]")) {
        el.style.visibility = el.getAttribute("data-ui-critic-hidden");
        el.removeAttribute("data-ui-critic-hidden");
      }
    });
  }
  let facts;
  try {
    facts = await page.evaluate(auditScript);
  } catch (err) {
    facts = { error: err.message };
  }
  if (runtime) facts.runtime = await runtime.read();
  // The style inventory for the design-system lint, kept apart from the audit so the
  // critic's copy of the facts stays short.
  let styles = null;
  try {
    const inventory = await page.evaluate(stylesScript);
    styles = path.join(dir, `${slug}.${viewportName}.styles.json`);
    await writeFile(styles, JSON.stringify(inventory));
  } catch {
    styles = null;
  }
  // Hover and keyboard focus, measured last: after the screenshots, the facts and the
  // runtime record, so moving the pointer and the focus cannot change any of them.
  const title = await page.title();
  const blocked = blockedReason(title, await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 3000)).catch(() => ""));
  if (sweep && !blocked) facts.interaction = await sweepPage(page, sweep);
  await writeFile(audit, JSON.stringify(facts, null, 2));
  return { route: label, path: route, url: page.url(), viewport: viewportName, title, fold, full, audit, styles, hiddenFixed, ...(blocked ? { blocked } : {}), ...extra };
}

/**
 * Captures one route in an open browser context: the above-the-fold PNG, the
 * full-page JPEG and the measured audit. Shared by the initial capture and by the
 * follow-up capture of pages the critic asks for.
 */
export async function captureRoute({ page, base, route, viewportName, dir, hideSelectors, auth = false, sweep = null }) {
  const runtime = await instrumentPage(page);
  runtime.reset();
  const url = new URL(route, base).toString();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  }
  await settle(page, hideSelectors);
  return shoot({ page, dir, slug: routeSlug(route), viewportName, route, label: route, extra: { auth }, runtime, sweep });
}

/**
 * The sweep settings for a viewport: hover and keyboard on a viewport with a mouse;
 * none on a touch viewport, which has neither hover nor, usually, a keyboard.
 */
export function sweepFor(sweep, vp) {
  if (!sweep || sweep.enabled === false || vp.isMobile || vp.a11yPreset) return null;
  return { hover: true, maxHover: sweep.maxHover ?? 20, maxTabs: sweep.maxTabs ?? 60 };
}

/**
 * Captures one scenario: opens its route, runs its steps (a click, a hover, a
 * keyboard focus, an invalid submit), waits for the UI to react, then shoots. The
 * result is reviewed as its own page named "route [scenario]". A step that fails
 * (a selector that never appears) is recorded rather than failing the run, so one
 * fragile scenario cannot cost the whole capture.
 */
export async function captureScenario({ page, base, scenario, viewportName, dir, hideSelectors, secrets }) {
  const runtime = await instrumentPage(page);
  runtime.reset();
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
  return shoot({ page, dir, slug, viewportName, route: scenario.route, label, extra: { scenario: scenario.name, steps, stepError: error, auth: Boolean(scenario.auth) }, runtime });
}

/**
 * Opens a browser context for one named viewport, with motion reduced and a light
 * scheme unless the viewport says otherwise. A viewport may also ask for browser
 * zoom (the CSS viewport shrinks and pixels grow, exactly as zooming in does),
 * forced colours (Windows high contrast), and text spacing, whose style overrides
 * must be allowed past the page's Content-Security-Policy.
 */
export async function openContext(browser, vp, extra = {}) {
  const zoom = vp.zoom > 0 ? vp.zoom : 1;
  return browser.newContext({
    viewport: { width: Math.round(vp.width / zoom), height: Math.round(vp.height / zoom) },
    deviceScaleFactor: (vp.deviceScaleFactor ?? 1) * zoom,
    isMobile: Boolean(vp.isMobile),
    hasTouch: Boolean(vp.isMobile),
    colorScheme: vp.colorScheme ?? "light",
    reducedMotion: "reduce",
    ...(vp.forcedColors ? { forcedColors: "active" } : {}),
    ...(vp.textSpacing || vp.injectCss ? { bypassCSP: true } : {}),
    ...extra,
  });
}

/**
 * A script that adds a style element with the given CSS as soon as the document has
 * a head. With keepLast, the element moves back to the end of the head whenever the
 * page adds a stylesheet after it (React hoists stylesheets during hydration), so
 * on a tie the overriding CSS still comes last and wins.
 */
function styleScript(id, css, { keepLast = false } = {}) {
  return `(() => {
  const add = () => {
    let s = document.getElementById(${JSON.stringify(id)});
    if (!s) {
      s = document.createElement("style");
      s.id = ${JSON.stringify(id)};
      s.textContent = ${JSON.stringify(css)};
    }
    const head = document.head || document.documentElement;
    if (head.lastElementChild !== s) head.appendChild(s);
    ${keepLast ? `if (!window.__uicKeepLast) {
      window.__uicKeepLast = new MutationObserver((records) => {
        if (records.some((r) => Array.from(r.addedNodes).some((n) => n !== s && (n.tagName === "STYLE" || n.tagName === "LINK")))) head.appendChild(s);
      });
      window.__uicKeepLast.observe(head, { childList: true });
    }` : ""}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();`;
}

/** WCAG 1.4.12's text spacing: the most a reader may set without content breaking. */
export const TEXT_SPACING_CSS =
  "*:not(svg):not(svg *){line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important}p{margin-bottom:2em !important}";

const TEXT_SPACING_SCRIPT = styleScript("uic-text-spacing", TEXT_SPACING_CSS);

/** The colour-vision simulations Chromium can render. */
export const VISION_TYPES = ["achromatopsia", "deuteranopia", "protanopia", "tritanopia", "blurredVision", "reducedContrast"];

/**
 * Applies a viewport's page-level emulation: text spacing overrides, a try-on's CSS
 * laid over the page, and a colour-vision simulation.
 */
export async function preparePage(page, vp) {
  if (vp.textSpacing) await page.addInitScript(TEXT_SPACING_SCRIPT);
  if (vp.injectCss) await page.addInitScript(styleScript("uic-tryon", vp.injectCss, { keepLast: true }));
  if (vp.vision) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: vp.vision });
  }
  return page;
}

/** A new page in a context, prepared for its viewport. */
async function newPageFor(context, vp) {
  return preparePage(await context.newPage(), vp);
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
export function scenariosAt(scenarios, viewportName, vp = null) {
  // An accessibility variant added by --a11y reviews the routes; a scenario runs there
  // only when it names the variant.
  return scenarios.filter((s) => (s.viewports ? s.viewports.includes(viewportName) : !vp?.a11yPreset));
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
export async function capture({ base, routes, scenarios = [], auth = null, viewports: configured, out, label, hideSelectors = [], sweep = null, injectCss = null }) {
  // A try-on lays its CSS over every page of every viewport.
  const viewports = injectCss ? Object.fromEntries(Object.entries(configured).map(([name, vp]) => [name, { ...vp, injectCss }])) : configured;
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
      const page = await newPageFor(anon, vp);
      for (const entry of entries.filter((e) => !e.auth)) {
        shots.push(await captureRoute({ page, base, route: entry.path, viewportName, dir, hideSelectors, sweep: sweepFor(sweep, vp) }));
        process.stderr.write(`  ${viewportName.padEnd(8)} ${entry.path}\n`);
      }
      await anon.close();
      // Every scenario starts from a clean context, so a saved wishlist, a
      // switched theme or a typed query never leaks into the next capture.
      for (const scenario of scenariosAt(scenarios, viewportName, vp).filter((s) => !s.auth)) {
        const fresh = await openContext(browser, vp);
        const freshPage = await newPageFor(fresh, vp);
        const shot = await captureScenario({ page: freshPage, base, scenario, viewportName, dir, hideSelectors, secrets });
        await fresh.close();
        shots.push(shot);
        process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route}${shot.stepError ? ` (step failed: ${shot.stepError.slice(0, 80)})` : ""}\n`);
      }

      const authEntries = entries.filter((e) => e.auth);
      const authScenarios = scenariosAt(scenarios, viewportName, vp).filter((s) => s.auth);
      if (authEntries.length || authScenarios.length) {
        const { context, reason } = await openAuthContext(browser, vp, auth, base, secrets);
        if (!context) {
          skipped.push(...authEntries.map((e) => `${e.path} (${reason})`), ...authScenarios.map((s) => `${scenarioLabel(s.route, s.name)} (${reason})`));
          process.stderr.write(`  ${viewportName.padEnd(8)} signed-in pages skipped: ${reason}\n`);
        } else {
          const session = await context.storageState();
          const authPage = await newPageFor(context, vp);
          for (const entry of authEntries) {
            shots.push(await captureRoute({ page: authPage, base, route: entry.path, viewportName, dir, hideSelectors, auth: true, sweep: sweepFor(sweep, vp) }));
            process.stderr.write(`  ${viewportName.padEnd(8)} ${entry.path} (signed in)\n`);
          }
          await context.close();
          for (const scenario of authScenarios) {
            const fresh = await openContext(browser, vp, { storageState: session });
            const freshPage = await newPageFor(fresh, vp);
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
  const manifest = { label, base, capturedAt: new Date().toISOString(), viewports: configured, hideSelectors, shots, skipped: Array.from(new Set(skipped)), dir, ...(injectCss ? { injectedCss: injectCss } : {}) };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Whether a capture landed somewhere else than it was sent (a login redirect, say). */
export function redirectedAway(requestedRoute, landedUrl, base) {
  try {
    const wanted = new URL(requestedRoute, base).pathname.replace(/\/+$/, "") || "/";
    const got = new URL(landedUrl).pathname.replace(/\/+$/, "") || "/";
    return wanted !== got;
  } catch {
    return false;
  }
}

/**
 * Captures extra routes into an existing capture set (the critic asked for them),
 * appending to its manifest. Returns the new shots; an unavailable Playwright is
 * reported rather than thrown, since the follow-up is best effort. A requested
 * page that redirects a visitor away (to sign in) is captured again in a signed-in
 * context when auth is configured, so the critic reviews the page it asked for.
 */
export async function captureMore(manifest, routes, { auth = null, secrets = {} } = {}) {
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
      const page = await newPageFor(context, vp);
      let signedIn = null;
      for (const route of routes) {
        let shot = await captureRoute({ page, base: manifest.base, route, viewportName, dir: manifest.dir, hideSelectors: manifest.hideSelectors ?? [] });
        if (auth && redirectedAway(route, shot.url, manifest.base)) {
          if (!signedIn) {
            const opened = await openAuthContext(browser, vp, auth, manifest.base, secrets);
            signedIn = opened.context ? { context: opened.context, page: await newPageFor(opened.context, vp) } : { context: null, reason: opened.reason };
          }
          if (signedIn.context) {
            shot = await captureRoute({ page: signedIn.page, base: manifest.base, route, viewportName, dir: manifest.dir, hideSelectors: manifest.hideSelectors ?? [], auth: true });
            process.stderr.write(`  ${viewportName.padEnd(8)} ${route} (requested by the critic, signed in)\n`);
          } else {
            shot.redirected = true;
            process.stderr.write(`  ${viewportName.padEnd(8)} ${route} (requested by the critic; redirected and ${signedIn.reason})\n`);
          }
        } else {
          process.stderr.write(`  ${viewportName.padEnd(8)} ${route} (requested by the critic)\n`);
        }
        shots.push(shot);
      }
      if (signedIn?.context) await signedIn.context.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  manifest.shots.push(...shots);
  await writeFile(path.join(manifest.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { shots, skipped: null };
}
