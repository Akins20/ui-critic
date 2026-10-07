import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, realpath } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { esc, relativeSrc, imageFile, shotImages, renderCritiqueHTML, renderCompareHTML, rerender } from "../src/html.mjs";
import { normalizeRegion, imageChoices } from "../src/critique.mjs";
import { renderCritique } from "../src/report.mjs";

const dir = path.resolve("out", "before");
const shot = (route, viewport, extra = {}) => ({
  route,
  viewport,
  title: route,
  fold: path.join(dir, `${route.replace(/\W+/g, "-")}.${viewport}.fold.png`),
  full: path.join(dir, `${route.replace(/\W+/g, "-")}.${viewport}.full.jpg`),
  ...extra,
});

const finding = (id, over = {}) => ({
  id,
  page: "/",
  viewport: "desktop",
  severity: "high",
  category: "typography",
  observation: "The headline is <script>alert(1)</script> too small",
  evidence: "hero, 'Shop now' button",
  recommendation: "Set it to 40px & bold",
  effort: "small",
  defect_kind: "ui",
  conflicts_with_decision: "",
  region: { viewport: "desktop", image: "first", box: [100, 200, 300, 600] },
  ...over,
});

const result = () => ({
  tool: "ui-critic",
  model: "gemini-3.8-flash",
  platform: "web",
  label: "before",
  base: "https://shop.example",
  reviewedAt: "2026-10-07T10:00:00Z",
  overall: { verdict: "Solid", score: 68, revamp_needed: false, top_priorities: ["Fix the hero"], consistency_findings: [finding("site-1", { page: "/", region: { viewport: "mobile", image: "first", box: [0, 0, 100, 1000] } })], requests: [] },
  pages: [
    {
      route: "/",
      summary: "Home works.",
      score: 70,
      strengths: ["Clear offer"],
      findings: [finding("home-1"), finding("home-2", { severity: "low", category: "spacing", region: { viewport: "mobile", image: "full", box: [500, 0, 600, 1000] } }), finding("home-3", { region: { viewport: "desktop", image: "first", box: null } })],
      coverage: [{ discipline: "typography", status: "issue", note: "small" }],
      requests: [],
      withheld: [],
      audits: {},
    },
  ],
  requests: [{ kind: "answer", target: "refunds?", why: "trust" }],
  followed: { routes: [] },
  skipped: [],
  decisions: [],
  usage: { calls: 3, estimatedCostUSD: 0.12, model: "gemini-3.8-flash" },
});

const manifest = { platform: "web", shots: [shot("/", "desktop"), shot("/", "mobile")] };

test("escaping covers every character that could break out of HTML", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc(null), "");
});

test("image paths are relative to the report and use forward slashes", async () => {
  assert.equal(relativeSrc(dir, path.join(dir, "a.png")), "a.png");
  assert.equal(relativeSrc(dir, path.resolve("out", "after", "b.png")), "../after/b.png");
  assert.equal(relativeSrc(dir, null), "");

  // A capture recorded from a Windows short path and a report rendered from the long
  // one name the same folder: the picture beside the report must still be "a.png",
  // not a path climbing out to the drive root.
  const real = await mkdtemp(path.join(await realpath(tmpdir()), "uic-rel-"));
  const shot = path.join(real, "a.png");
  await writeFile(shot, "x");
  const short = process.platform === "win32" ? execSync(`for %I in ("${real}") do @echo %~sI`, { shell: "cmd.exe" }).toString().trim() : real;
  assert.equal(relativeSrc(real, path.join(short, "a.png")), "a.png", "the short form resolves to the same folder");
  assert.equal(relativeSrc(short, shot), "a.png");
});

test("region images map to files: the first screen, the full page and scroll frames", () => {
  const web = shot("/", "desktop");
  assert.equal(imageFile(web, "first"), web.fold);
  assert.equal(imageFile(web, "full"), web.full);
  const app = { fold: "f.png", frames: ["f.png", "g.png", "h.png"] };
  assert.equal(imageFile(app, "frame3"), "h.png");
  assert.equal(imageFile(app, "frame9"), null);
  assert.deepEqual(shotImages(app).map((i) => i.image), ["first", "frame2", "frame3"]);
  assert.deepEqual(imageChoices({ shots: [app, { fold: "x", frames: ["x"] }] }), ["first", "frame2", "frame3"]);
  assert.deepEqual(imageChoices({ shots: [web] }), ["first", "full"]);
});

test("regions are kept only when the box is four ordered numbers from 0 to 1000", () => {
  const vps = ["desktop", "mobile"];
  const imgs = ["first", "full"];
  assert.deepEqual(normalizeRegion({ viewport: "mobile", image: "full", box: [10, 20, 30, 40] }, vps, imgs), { viewport: "mobile", image: "full", box: [10, 20, 30, 40] });
  assert.equal(normalizeRegion({ viewport: "mobile", image: "full", box: [30, 20, 10, 40] }, vps, imgs).box, null, "corners out of order");
  assert.equal(normalizeRegion({ viewport: "mobile", image: "full", box: [0, 0, 1200, 10] }, vps, imgs).box, null, "out of range");
  assert.equal(normalizeRegion({ viewport: "mobile", image: "full", box: [] }, vps, imgs).box, null, "empty means no single place");
  assert.equal(normalizeRegion({ viewport: "tv", image: "poster", box: [1, 2, 3, 4] }, vps, imgs).viewport, "desktop", "an unknown viewport falls back to a real one");
  assert.equal(normalizeRegion(null, vps, imgs), null);
});

test("the critique page draws each boxed finding on its image, numbered, escaped and filterable", () => {
  const html = renderCritiqueHTML(result(), manifest, dir);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<html lang="en" data-theme="light">/, "light first");
  assert.ok(!html.includes("<script>alert(1)</script>"), "model text is escaped");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // home-1: box [100,200,300,600] on the desktop first screen.
  assert.match(html, /<a class="box sev-high" href="#f-home-1" data-f="f-home-1" style="top:10%;left:20%;height:20%;width:40%"/);
  // home-2 is on the mobile full page, which is therefore shown rather than folded away.
  assert.match(html, /src="-\.mobile\.full\.jpg"[^>]*>[^]*?href="#f-home-2"/);
  // home-3 has no box: listed, never drawn.
  assert.ok(html.includes('id="f-home-3"') && !html.includes('href="#f-home-3"'));
  assert.match(html, /data-sev="high" checked/);
  assert.match(html, /<option>typography<\/option>/);
  assert.match(html, /Across pages/);
  assert.match(html, />S1</, "cross-page findings are numbered S1, S2");
  assert.match(html, /\[answer\] refunds\?: trust/);
  assert.ok(!/https?:\/\/(?!shop\.example)/.test(html), "no request to anywhere else");
});

test("an app critique says screens, not pages", () => {
  const r = result();
  r.platform = "android";
  assert.match(renderCritiqueHTML(r, manifest, dir), /Across screens/);
});

test("the comparison page sets before beside after with a slider and tags confirmed regressions", () => {
  const before = { shots: [shot("/", "desktop")] };
  const after = { shots: [{ ...shot("/", "desktop"), fold: path.resolve("out", "after", "home.desktop.fold.png"), full: path.resolve("out", "after", "home.desktop.full.jpg") }] };
  const cmp = {
    model: "m",
    before: { label: "before", base: "b" },
    after: { label: "after", base: "a" },
    comparedAt: "t",
    usage: { calls: 2, estimatedCostUSD: 0.02 },
    results: [{ route: "/", viewport: "desktop", verdict: "mixed", improved: ["Hero larger"], regressed: ["Contrast fell"], regressed_detail: [{ text: "Contrast fell", kind: "measured", reason: "2.9:1" }], unconfirmed_regressions: [{ text: "Spacing tighter", reason: "not visible" }], still_open: ["Footer"], notes: "" }],
  };
  const html = renderCompareHTML(cmp, before, after, path.resolve("out", "after"));
  assert.match(html, /<input type="range" min="0" max="100" value="50" data-slider="after-0"/);
  assert.match(html, /src="\.\.\/before\/-\.desktop\.fold\.png"/);
  assert.match(html, /<span class="tag-measured">\[measured\]<\/span> Contrast fell/);
  assert.match(html, /Reported but not confirmed/);
  assert.match(html, /class="verdict v-mixed"/);
});

test("report renders saved results again without calling the critic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-report-"));
  const capture = path.join(root, "before");
  await mkdir(capture, { recursive: true });
  await writeFile(path.join(capture, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(capture, "critique.json"), JSON.stringify(result()));
  const written = await rerender(capture, { renderCritique });
  assert.deepEqual(written.map((f) => path.basename(f)), ["critique.html", "critique.md"]);
  assert.match(await readFile(path.join(capture, "critique.html"), "utf8"), /UI critique: before/);
  const empty = path.join(root, "empty");
  await mkdir(empty);
  await writeFile(path.join(empty, "manifest.json"), "{}");
  await assert.rejects(() => rerender(empty, { renderCritique }), /no critique\.json or compare\.json/);
  await assert.rejects(() => rerender(path.join(root, "missing"), { renderCritique }), /no manifest\.json/);
});
