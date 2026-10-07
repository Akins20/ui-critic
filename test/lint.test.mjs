import { test } from "node:test";
import assert from "node:assert/strict";
import { parseColor, toHex, deltaE } from "../src/color.mjs";
import { mergeInventories, lintInventory, classifyTokens, flattenTokens, fitTypeScale, colorKey, clusterColors, renderLint, lintForPrompt, lintScheme, lintCapture } from "../src/lint.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("the lint judges the design as authored: variants are left out and a dark theme is linted on its own", async () => {
  assert.equal(lintScheme({}), "light");
  assert.equal(lintScheme({ colorScheme: "dark" }), "dark");
  for (const vp of [{ forcedColors: true }, { textSpacing: true }, { vision: "deuteranopia" }, { zoom: 2 }]) assert.equal(lintScheme(vp), null);
  const dir = await mkdtemp(path.join(tmpdir(), "uic-lint-themes-"));
  const inventory = (tokens, color) => ({ tokens, colors: [{ value: color, count: 3, samples: ["p"] }], backgrounds: [], borders: [] });
  await writeFile(path.join(dir, "light.json"), JSON.stringify(inventory({ "--ink": "#111111" }, "rgb(17, 17, 17)")));
  await writeFile(path.join(dir, "dark.json"), JSON.stringify(inventory({ "--ink": "#eeeeee" }, "rgb(238, 238, 238)")));
  await writeFile(path.join(dir, "forced.json"), JSON.stringify(inventory({ "--ink": "#111111" }, "rgb(0, 0, 255)")));
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      label: "t",
      base: "x",
      viewports: { desktop: { width: 1, height: 1 }, dark: { width: 1, height: 1, colorScheme: "dark" }, "forced-colors": { width: 1, height: 1, forcedColors: true } },
      shots: [
        { route: "/", viewport: "desktop", styles: path.join(dir, "light.json") },
        { route: "/", viewport: "dark", styles: path.join(dir, "dark.json") },
        { route: "/", viewport: "forced-colors", styles: path.join(dir, "forced.json") },
      ],
    }),
  );
  const r = await lintCapture(dir);
  assert.equal(r.metrics.tokenCoverage, 1, "light text is its light token");
  assert.equal(r.metrics.darkTokenCoverage, 1, "dark text is its dark token, not drift from the light one");
  assert.ok(!r.findings.some((f) => JSON.stringify(f).includes("#0000ff")), "forced colours are system colours, not design");
});

test("colours parse from hex, rgb and rgba, as browsers compute them", () => {
  assert.deepEqual(parseColor("#5A3EC8"), { rgb: [90, 62, 200], a: 1 });
  assert.deepEqual(parseColor("#abc"), { rgb: [170, 187, 204], a: 1 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0.2)"), { rgb: [0, 0, 0], a: 0.2 });
  assert.deepEqual(parseColor("rgb(28 27 31 / 50%)"), { rgb: [28, 27, 31], a: 0.5 });
  assert.equal(parseColor("oklch(0.6 0.2 280)"), null);
  assert.equal(toHex([90, 62, 200]), "#5a3ec8");
  assert.equal(colorKey("rgba(0, 0, 0, 0.25)"), "#000000 at 25%");
});

test("CIEDE2000 matches the published reference pairs", () => {
  // Sharma, Wu and Dalal's test data, converted to sRGB pairs that land close to it:
  // identical colours differ by 0; black and white by 100; a one-step blue shift is tiny.
  assert.equal(deltaE([90, 62, 200], [90, 62, 200]), 0);
  assert.ok(Math.abs(deltaE([0, 0, 0], [255, 255, 255]) - 100) < 0.01);
  assert.ok(deltaE([90, 62, 200], [91, 62, 201]) < 1, "a one-digit typo is invisible drift");
  assert.ok(deltaE([90, 62, 200], [224, 30, 30]) > 30, "red is nowhere near the brand purple");
});

test("tokens: flat maps and W3C design tokens flatten; colours and lengths are told apart", () => {
  assert.deepEqual(flattenTokens({ color: { brand: { $value: "#5a3ec8" }, ink: { $value: "#111" } }, space: { 2: "8px" } }), { "color.brand": "#5a3ec8", "color.ink": "#111", "space.2": "8px" });
  const { colors, lengths } = classifyTokens({ "--brand": "#5a3ec8", "--space-2": "8px", "--text-lg": "1.5rem", "--shadow": "0 1px 2px #000", "--glass": "rgba(255,255,255,.5)" });
  assert.deepEqual(colors.map((c) => c.name), ["--brand"], "a translucent token is not a palette colour");
  assert.deepEqual(lengths, [{ name: "--space-2", px: 8 }, { name: "--text-lg", px: 24 }]);
});

test("the type scale that fits the sizes in use is found, with each size mapped to a step", () => {
  const scale = fitTypeScale([{ value: "16px", count: 50 }, { value: "20px", count: 10 }, { value: "25px", count: 5 }, { value: "12.8px", count: 4 }]);
  assert.equal(scale.ratio, 1.25);
  assert.equal(scale.base, "16px");
  assert.ok(scale.steps.includes("20px") && scale.steps.includes("25px"));
  assert.equal(fitTypeScale([]), null);
});

test("near-identical colours cluster together, distinct ones do not", () => {
  const clusters = clusterColors([{ value: "#333333", count: 10 }, { value: "#343434", count: 2 }, { value: "#5a3ec8", count: 5 }], 3);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].members.map((m) => m.value), ["#333333", "#343434"]);
});

const page = (route, styles) => ({ route, viewport: "desktop", styles });
const entry = (value, count, sample = "p") => ({ value, count, samples: [sample] });

test("the rules find drift, off-palette colours, off-grid spacing and sprawl, and leave clean values alone", () => {
  const inv = mergeInventories([
    page("/", {
      elements: 40,
      tokens: { "--brand": "#5a3ec8", "--ink": "#1c1b1f", "--surface": "#ffffff", "--space-4": "16px", "--radius": "8px", "--text-md": "16px", "--text-lg": "24px" },
      colors: [entry("rgb(28, 27, 31)", 30), entry("rgb(91, 62, 201)", 3, "p.near"), entry("rgb(224, 30, 30)", 2, "p.stray")],
      backgrounds: [entry("rgb(255, 255, 255)", 5)],
      borders: [],
      families: [entry("Arial", 30), entry("Georgia", 2), entry("Courier New", 1)],
      sizes: [entry("16px", 30), entry("24px", 2), entry("15px", 1), entry("13px", 1)],
      weights: [],
      lineHeights: [],
      letterSpacing: [],
      radii: [entry("8px", 3), entry("7px", 1, "p.near")],
      shadows: [entry("rgba(0, 0, 0, 0.2) 0px 1px 2px 0px", 1)],
      spacing: [entry("16px", 20), entry("13px", 2, "p.near"), entry("1px", 4), entry("18px", 1, "p.stray")],
      tightBodyText: [entry("15px at 1.05", 1, "p.cramped")],
      longLines: [{ sample: "p.wide", charsPerLine: 150, widthPx: 1200, fontSize: "16px" }],
    }),
  ]);
  const r = lintInventory(inv);
  const by = Object.fromEntries(r.findings.map((f) => [f.rule, f]));
  assert.equal(by["color-near-token"].severity, "high");
  assert.match(by["color-near-token"].values[0].note, /almost --brand \(#5a3ec8\)/);
  assert.equal(by["color-off-palette"].values[0].value, "#e01e1e");
  assert.deepEqual(by["spacing-off-grid"].values.map((v) => v.value), ["13px", "18px"], "1px hairlines are allowed, 16px is on the grid");
  assert.match(by["spacing-off-grid"].values[0].note, /nearest on the grid: 12px/);
  assert.deepEqual(by["type-off-scale"].values.map((v) => v.value), ["15px", "13px"]);
  assert.equal(by["type-families"].values.length, 3);
  assert.ok(by["type-line-height"]);
  assert.ok(by["type-line-length"]);
  assert.deepEqual(by["radius-drift"].values.map((v) => v.value), ["7px"]);
  assert.ok(!by["shadow-drift"], "one shadow is fine");
  assert.equal(r.findings[0].severity, "high", "most severe first");
  assert.equal(r.metrics.tokenCoverage, Math.round((35 / 40) * 100) / 100);
  assert.ok(r.proposal.spacing.includes("12px") && r.proposal.spacing.includes("16px"));
  const md = renderLint({ ...r, label: "before", base: "x", pages: ["/"] });
  assert.match(md, /## \[high\] 1 colour is almost a token but not quite/);
  assert.match(lintForPrompt({ ...r }), /almost --brand/);
});

test("a site without colour tokens is told so, and look-alike colours are paired", () => {
  const colors = Array.from({ length: 14 }, (_, i) => entry(`rgb(${i * 17}, ${255 - i * 17}, 100)`, 2));
  colors.push(entry("rgb(51, 51, 51)", 9), entry("rgb(52, 52, 52)", 1));
  const r = lintInventory(mergeInventories([page("/", { colors, backgrounds: [], borders: [], sizes: [], families: [], spacing: [], radii: [], shadows: [], tightBodyText: [] })]));
  const rules = r.findings.map((f) => f.rule);
  assert.ok(rules.includes("color-no-tokens"));
  assert.ok(rules.includes("color-near-duplicates"));
  assert.match(r.findings.find((f) => f.rule === "color-near-duplicates").values.map((v) => v.value).join("|"), /#333333 vs #343434/);
});

test("inventories from several pages merge by value, summing counts and listing pages", () => {
  const inv = mergeInventories([
    page("/", { colors: [entry("rgb(1, 2, 3)", 2)], sizes: [entry("16px", 3)] }),
    page("/shop", { colors: [entry("rgb(1, 2, 3)", 5)], sizes: [entry("16px", 1)] }),
  ]);
  const c = inv.colors.get("#010203");
  assert.equal(c.count, 7);
  assert.deepEqual(c.pages, ["/", "/shop"]);
  assert.equal(inv.sizes.get("16px").count, 4);
});
