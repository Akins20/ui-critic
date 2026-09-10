import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditScript } from "./audit.mjs";

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
  return (clean || "home").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
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

/**
 * Captures one route in an open browser context: the above-the-fold PNG, the
 * full-page JPEG and the measured audit. Shared by the initial capture and by the
 * follow-up capture of pages the critic asks for.
 */
export async function captureRoute({ page, base, route, viewportName, dir, hideSelectors }) {
  const url = new URL(route, base).toString();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  } catch {
    await page.goto(url, { waitUntil: "load", timeout: 90_000 });
  }
  await settle(page, hideSelectors);
  const slug = routeSlug(route);
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
  return { route, url, viewport: viewportName, title: await page.title(), fold, full, audit };
}

/** Opens a browser context for one named viewport with motion reduced and a light scheme. */
export async function openContext(browser, vp) {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    isMobile: Boolean(vp.isMobile),
    hasTouch: Boolean(vp.isMobile),
    colorScheme: vp.colorScheme ?? "light",
    reducedMotion: "reduce",
  });
}

/**
 * Captures every route at every viewport: an above-the-fold PNG (what a visitor
 * sees first), a full-page JPEG (layout and rhythm) and a measured audit (fonts,
 * headings, targets, contrast), and writes the manifest.json that critique and
 * compare read. Motion is reduced so carousels and entrance animations do not
 * smear the capture.
 */
export async function capture({ base, routes, viewports, out, label, hideSelectors = [] }) {
  const playwright = await loadPlaywright();
  const dir = path.join(out, label);
  await mkdir(dir, { recursive: true });
  const browser = await playwright.chromium.launch();
  const shots = [];
  try {
    for (const [viewportName, vp] of Object.entries(viewports)) {
      const context = await openContext(browser, vp);
      const page = await context.newPage();
      for (const route of routes) {
        shots.push(await captureRoute({ page, base, route, viewportName, dir, hideSelectors }));
        process.stderr.write(`  ${viewportName.padEnd(8)} ${route}\n`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const manifest = { label, base, capturedAt: new Date().toISOString(), viewports, hideSelectors, shots, dir };
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
