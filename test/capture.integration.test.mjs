import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture, loadPlaywright } from "../src/capture.mjs";
import { lintCapture } from "../src/lint.mjs";
import { tryon } from "../src/tryon.mjs";
import { benchmark } from "../src/benchmark.mjs";
import { DEFAULTS } from "../src/config.mjs";

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

test("the interaction sweep finds missing hover and focus feedback, invisible stops and a bad focus order", { skip, timeout: 180_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-sweep-"));
  const manifest = await capture({
    base,
    routes: ["/interactions.html", "/order.html"],
    viewports: { desktop: { width: 1024, height: 700, deviceScaleFactor: 1 }, mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } },
    out,
    label: "t",
    sweep: { enabled: true, maxHover: 20, maxTabs: 30 },
  });
  const facts = async (route, viewport) => JSON.parse(await readFile(manifest.shots.find((s) => s.route === route && s.viewport === viewport).audit, "utf8"));
  const desk = (await facts("/interactions.html", "desktop")).interaction;
  assert.equal(desk.hover.unchanged, 2, `silent button and flat link give no hover feedback (${JSON.stringify(desk.hover)})`);
  assert.deepEqual(desk.hover.examples.sort(), ['a "Flat link"', 'button "Silent button"']);
  assert.equal(desk.focus.notVisible, 2, `outline: none with nothing in its place (${JSON.stringify(desk.focus)})`);
  assert.deepEqual(desk.focus.notVisibleExamples.sort(), ['a "Flat link"', 'button "Silent button"']);
  assert.deepEqual(desk.focus.hiddenStops, ['span "Invisible stop"'], "focus lands on a 1px element");
  assert.equal(desk.focus.skipLink, true);
  assert.equal(desk.focus.backwardJumps, 0);
  assert.equal(desk.focus.trap, false);
  assert.ok(desk.focus.reached >= 6);
  const order = (await facts("/order.html", "desktop")).interaction;
  assert.equal(order.focus.skipLink, false);
  assert.ok(order.focus.backwardJumps >= 1, `CSS order moves the first button to the bottom, so focus jumps back up (${JSON.stringify(order.focus)})`);
  assert.deepEqual(order.focus.positiveTabindex, ['a "Footer link with a positive tabi"']);
  assert.equal((await facts("/interactions.html", "mobile")).interaction, undefined, "a touch viewport is not swept");
  const shot = manifest.shots.find((s) => s.route === "/interactions.html" && s.viewport === "desktop");
  const html = await readFile(path.join(site, "interactions.html"), "utf8");
  assert.ok(!html.includes("data-uic-i"), "the fixture itself is untouched");
  assert.ok(shot.fold.endsWith(".fold.png"));
});

test("accessibility variants render as asked and their layout failures are measured", { skip, timeout: 240_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-a11y-"));
  const mobile = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };
  const desktop = { width: 1024, height: 700, deviceScaleFactor: 1 };
  const manifest = await capture({
    base,
    routes: ["/a11y.html"],
    viewports: {
      desktop,
      mobile,
      "reflow-320": { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, a11yPreset: true },
      "zoom-200": { ...desktop, zoom: 2, a11yPreset: true },
      "text-spacing": { ...mobile, textSpacing: true, a11yPreset: true },
      "forced-colors": { ...desktop, forcedColors: true, a11yPreset: true },
      deuteranopia: { ...mobile, vision: "deuteranopia", a11yPreset: true },
      dark: { ...desktop, colorScheme: "dark", a11yPreset: true },
    },
    out,
    label: "t",
    sweep: { enabled: false },
  });
  const shot = (vp) => manifest.shots.find((s) => s.viewport === vp);
  const facts = async (vp) => JSON.parse(await readFile(shot(vp).audit, "utf8"));
  const reflow = (await facts("reflow-320")).layout;
  assert.equal(reflow.horizontalScroll, true);
  assert.ok(reflow.offEdge.some((e) => e.startsWith("div.wide-table")), `the 600px table runs off a 320px screen (${reflow.offEdge})`);
  assert.ok(!reflow.offEdge.some((e) => e.includes("Card")), "carousel cards are in a scroller and do not count");
  assert.ok((await facts("mobile")).layout.clippedText.every((e) => !e.startsWith("div.tight")), "the label fits at normal spacing");
  assert.ok((await facts("text-spacing")).layout.clippedText.some((e) => e.startsWith("div.tight")), "and is cut off at WCAG text spacing");
  assert.ok((await facts("desktop")).layout.clippedText.some((e) => e.startsWith("div.ellipsis")));
  assert.equal((await facts("zoom-200")).viewport.width, 512, "200% zoom halves the CSS viewport");
  const png = async (vp) => readFile(shot(vp).fold);
  assert.ok(!(await png("deuteranopia")).equals(await png("mobile")), "the colour-vision simulation changes the render");
  assert.ok(!(await png("forced-colors")).equals(await png("desktop")), "forced colours change the render");
  const darkStyles = JSON.parse(await readFile(shot("dark").styles, "utf8"));
  assert.ok(JSON.stringify(darkStyles.backgrounds).includes("rgb(18, 18, 18)"), "the dark scheme applied the page's dark background");
});

test("a try-on lays CSS over the live page, re-captures it beside the original and leaves the original alone", { skip, timeout: 180_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-tryon-"));
  const desktop = { width: 1024, height: 700, deviceScaleFactor: 1 };
  const original = await capture({ base, routes: ["/styles.html"], viewports: { desktop }, out, label: "before", sweep: { enabled: false } });
  const css = ":root { --brand: #ff0000; }\n@import url(https://evil.example/x.css);\nbody { background-image: url(https://evil.example/t.png); }";
  const result = await tryon({ dir: original.dir, config: { ...DEFAULTS, out }, css, judge: false });
  assert.equal(result.directions.length, 1);
  const d = result.directions[0];
  assert.ok(!d.css.includes("evil.example"), "the CSS was sanitised before use");
  const tried = JSON.parse(await readFile(path.join(d.dir, "manifest.json"), "utf8"));
  assert.equal(path.dirname(tried.dir), path.dirname(original.dir), "captured beside the original");
  const styles = JSON.parse(await readFile(tried.shots[0].styles, "utf8"));
  assert.ok(JSON.stringify(styles.colors).includes("rgb(255, 0, 0)"), "the heading now renders in the overridden brand colour");
  const before = JSON.parse(await readFile(original.shots[0].styles, "utf8"));
  assert.ok(!JSON.stringify(before.colors).includes("rgb(255, 0, 0)"), "the original capture is untouched");
  assert.ok(!(await readFile(tried.shots[0].fold)).equals(await readFile(original.shots[0].fold)), "the render changed");
  const gallery = await readFile(result.htmlPath, "utf8");
  assert.match(gallery, /tryon-proposal\/styles-html\.desktop\.fold\.png/);
});

test("a benchmark captures the competitor's mapped pages beside ours and writes the report", { skip, timeout: 180_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-bench-"));
  const desktop = { width: 1024, height: 700, deviceScaleFactor: 1 };
  const ours = await capture({ base, routes: ["/"], viewports: { desktop }, out, label: "before", sweep: { enabled: false } });
  const config = { ...DEFAULTS, out, benchmarks: [{ name: "Rival", base, routes: { "/": "/about.html", "/missing": "/x" } }] };
  const result = await benchmark({ dir: ours.dir, config, judge: false });
  const b = result.benchmarks[0];
  assert.equal(b.pages.length, 1, "only routes we captured are compared");
  assert.equal(b.pages[0].theirRoute, "/about.html");
  const theirs = JSON.parse(await readFile(path.join(b.dir, "manifest.json"), "utf8"));
  assert.equal(path.basename(theirs.dir), "benchmark-rival");
  assert.equal(theirs.shots[0].title, "About the fixture");
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /benchmark-rival\/about-html\.desktop\.fold\.png/);
  await assert.rejects(() => benchmark({ dir: ours.dir, config: { ...config, benchmarks: [] }, judge: false }), /no benchmarks in the config/);
});

test("the design-system lint reads the real computed styles and finds the planted drift", { skip, timeout: 120_000 }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-lint-"));
  const manifest = await capture({
    base,
    routes: ["/styles.html"],
    viewports: { desktop: { width: 1440, height: 900, deviceScaleFactor: 1 } },
    out,
    label: "t",
  });
  const lint = await lintCapture(manifest.dir);
  const by = Object.fromEntries(lint.findings.map((f) => [f.rule, f]));
  // The tokens came from the page's own :root custom properties.
  assert.ok(lint.tokens.colors >= 4, `colour tokens read from :root (${lint.tokens.colors})`);
  assert.match(by["color-near-token"].values.map((v) => `${v.value} ${v.note}`).join("|"), /#5b3ec9 almost --brand \(#5a3ec8\)/);
  assert.ok(by["color-off-palette"].values.some((v) => v.value === "#e01e1e"));
  assert.ok(!JSON.stringify(lint).includes("#00ff00"), "a hidden element's colour is not counted");
  const offGrid = by["spacing-off-grid"].values.map((v) => v.value);
  for (const v of ["13px", "6px", "10px"]) assert.ok(offGrid.includes(v), `${v} is off the 4px grid`);
  assert.ok(lint.metrics.offGridSpacing >= 6, `every off-grid value is counted (${lint.metrics.offGridSpacing})`);
  assert.ok(!offGrid.includes("16px") && !offGrid.includes("20px") && !offGrid.includes("3px"), "on-grid and hidden values are not flagged");
  assert.ok(!offGrid.some((v) => /^16\.0\dpx$/.test(v)), "em rounding just off the grid is not drift");
  assert.ok(by["type-families"].values.length >= 4, "Arial, Georgia, Courier New and Verdana");
  assert.ok(by["type-line-height"], "the 1.05 paragraph is cramped");
  assert.ok(by["type-line-length"].values[0].value.match(/^\d+ characters per line$/));
  assert.ok(by["radius-drift"].values.some((v) => v.value === "7px"), "7px is not the 8px radius token");
  assert.ok(by["type-sprawl"] || by["type-off-scale"], "13, 15, 17, 19, 21 and 29px sprawl off the 14/16/24 scale");
});
