import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];

/**
 * Loads a Playwright package from the project being reviewed first (so its
 * installed browsers are used), then from the tool's own resolution, accepting any
 * of the packages that export chromium. Playwright is optional: critique and compare
 * work on any PNG or JPEG you already have, as long as a manifest.json describes them.
 */
async function loadPlaywright() {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  for (const name of PLAYWRIGHT_PACKAGES) {
    try {
      const mod = await import(pathToFileURL(req.resolve(name)).href);
      if (mod.chromium) return mod;
    } catch {
      // try the next candidate
    }
  }
  for (const name of PLAYWRIGHT_PACKAGES) {
    try {
      const mod = await import(name);
      if (mod.chromium) return mod;
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
 * Captures every route at every viewport: an above-the-fold PNG (what a visitor
 * sees first) and a full-page JPEG (layout and rhythm), and writes the manifest.json
 * that critique and compare read. Motion is reduced so carousels and entrance
 * animations do not smear the capture.
 */
export async function capture({ base, routes, viewports, out, label, hideSelectors = [] }) {
  const playwright = await loadPlaywright();
  const dir = path.join(out, label);
  await mkdir(dir, { recursive: true });
  const browser = await playwright.chromium.launch();
  const shots = [];
  try {
    for (const [viewportName, vp] of Object.entries(viewports)) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor ?? 1,
        isMobile: Boolean(vp.isMobile),
        hasTouch: Boolean(vp.isMobile),
        colorScheme: vp.colorScheme ?? "light",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      for (const route of routes) {
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
        await page.screenshot({ path: fold, fullPage: false });
        await page.screenshot({ path: full, fullPage: true, type: "jpeg", quality: 80 });
        shots.push({ route, url, viewport: viewportName, title: await page.title(), fold, full });
        process.stderr.write(`  ${viewportName.padEnd(8)} ${route}\n`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const manifest = { label, base, capturedAt: new Date().toISOString(), viewports, shots, dir };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
