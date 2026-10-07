import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture, loadPlaywright } from "../src/capture.mjs";

/**
 * The web capture end to end, in a real browser, against a fixture site with
 * deliberate defects: low-contrast text, a tiny target, an image without alt, a
 * console error, an uncaught exception, a missing image and a late layout shift.
 * Skipped when Playwright is not installed (CI installs it for this job).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, "fixtures", "site");
let playwright = null;
try {
  playwright = await loadPlaywright();
} catch {
  playwright = null;
}
const skip = playwright ? false : "Playwright is not installed";

let server;
let base;
before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const name = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    try {
      const body = await readFile(path.join(site, path.basename(name)));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test("a real browser capture measures every planted defect", { skip, timeout: 180_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-capture-"));
  const manifest = await capture({
    base,
    routes: ["/", "/about.html"],
    scenarios: [{ name: "menu-open", route: "/", steps: [{ click: "text=Menu" }, { wait: 100 }] }],
    viewports: { desktop: { width: 1024, height: 700, deviceScaleFactor: 1 }, mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } },
    out,
    label: "t",
  });
  assert.equal(manifest.shots.length, 6, "two routes and one scenario at two viewports");
  for (const s of manifest.shots) {
    await access(s.fold);
    await access(s.full);
  }
  const home = manifest.shots.find((s) => s.route === "/" && s.viewport === "desktop");
  const facts = JSON.parse(await readFile(home.audit, "utf8"));
  assert.equal(facts.title, "Fixture shop");
  assert.ok(facts.textContrast.lowest.some((p) => p.text === "Low contrast text" && !p.passesAA && p.ratio < 3), "the #999 text fails AA");
  assert.ok(facts.interactive.under24px.some((t) => t.w === 16 && t.h === 16), "the 16px link is a small target");
  assert.ok(facts.images.missingAlt >= 1, "the image without alt is counted");
  assert.match(facts.landmarks, /header=1 nav=1 main=1 footer=1/);
  assert.ok(facts.headings.some((h) => h.startsWith("H1: Fixture shop")));
  assert.ok(facts.runtime.consoleErrors.some((e) => e.includes("fixture console error")));
  assert.ok(facts.runtime.pageErrors.some((e) => e.includes("fixture boom")));
  assert.ok(facts.runtime.httpErrors.some((e) => e.startsWith("404") && e.includes("missing.png")));
  assert.ok(facts.runtime.cls > 0.1, `the late banner shifts the layout (cls ${facts.runtime.cls})`);
  const about = JSON.parse(await readFile(manifest.shots.find((s) => s.route === "/about.html").audit, "utf8"));
  assert.deepEqual(about.runtime.consoleErrors, [], "a clean page reports no errors: the collectors reset per page");
  const menu = manifest.shots.find((s) => s.scenario === "menu-open");
  assert.equal(menu.stepError, null);
  assert.deepEqual(menu.steps, ["click text=Menu", "wait 100ms"]);
  assert.equal(menu.route, "/ [menu-open]");
});
