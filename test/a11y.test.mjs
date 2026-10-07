import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simulateVision, chroma, deltaE } from "../src/color.mjs";
import { a11yViewports, DEFAULT_VIEWPORTS, DEFAULTS, merge, validate, loadConfig } from "../src/config.mjs";
import { variantNotes } from "../src/critique.mjs";
import { scenariosAt, sweepFor } from "../src/capture.mjs";
import { mergeInventories, lintInventory } from "../src/lint.mjs";
import { auditSummary } from "../src/audit.mjs";

test("colour-vision simulation: red and green collapse for deuteranopia, blue and yellow survive", () => {
  const red = [211, 47, 47];
  const green = [56, 142, 60];
  assert.ok(deltaE(red, green) > 40, "clearly different for most people");
  assert.ok(deltaE(simulateVision(red, "deuteranopia"), simulateVision(green, "deuteranopia")) < 12, "much closer with deuteranopia");
  const blue = [30, 90, 220];
  const yellow = [240, 200, 40];
  assert.ok(deltaE(simulateVision(blue, "deuteranopia"), simulateVision(yellow, "deuteranopia")) > 40);
  assert.deepEqual(simulateVision([10, 20, 30], "unknown"), [10, 20, 30]);
  assert.ok(chroma([128, 128, 128]) < 1 && chroma(red) > 40);
});

test("the colour-vision lint pairs used colours that collapse, and ignores greys", () => {
  const entry = (value, count) => ({ value, count, samples: [`p "${value}"`] });
  const inv = mergeInventories([
    {
      route: "/pay",
      viewport: "desktop",
      styles: {
        tokens: { "--error": "#d32f2f", "--success": "#3f9142", "--ink": "#111111", "--muted": "#777777" },
        colors: [entry("rgb(211, 47, 47)", 5), entry("rgb(63, 145, 66)", 4), entry("rgb(17, 17, 17)", 40), entry("rgb(119, 119, 119)", 9)],
        backgrounds: [],
        borders: [],
      },
    },
  ]);
  const r = lintInventory(inv);
  const cv = r.findings.find((f) => f.rule === "color-vision");
  assert.ok(cv, `a colour-vision finding (${r.findings.map((f) => f.rule)})`);
  assert.equal(cv.values[0].value, "#d32f2f and #3f9142");
  assert.match(cv.values[0].note, /look alike with (deuteranopia|protanopia)/);
  assert.ok(!cv.values.some((v) => v.value.includes("#777777")), "a grey pair is not a hue problem");
});

test("--a11y adds the variants after the configured viewports and never replaces one", async () => {
  const preset = a11yViewports(DEFAULT_VIEWPORTS);
  assert.deepEqual(Object.keys(preset), ["reflow-320", "zoom-200", "text-spacing", "forced-colors", "deuteranopia", "dark"]);
  assert.equal(preset["zoom-200"].width, 1366, "zoom keeps the desktop's size and scales inside it");
  assert.equal(preset["zoom-200"].zoom, 2);
  assert.ok(Object.values(preset).every((v) => v.a11yPreset));
  assert.ok(!("dark" in a11yViewports({ d: { width: 1, height: 1, colorScheme: "dark" } })), "no extra dark pass when one exists");
  const dir = await mkdtemp(path.join(tmpdir(), "uic-a11y-"));
  const file = path.join(dir, "ui-critic.config.json");
  await writeFile(file, JSON.stringify({ viewports: { desktop: DEFAULT_VIEWPORTS.desktop, "reflow-320": { width: 320, height: 700 } } }));
  const cfg = await loadConfig({ config: file, a11y: true }, {});
  assert.deepEqual(Object.keys(cfg.viewports).slice(0, 2), ["desktop", "reflow-320"], "configured first, in their order");
  assert.equal(cfg.viewports["reflow-320"].height, 700, "a configured name is kept as configured");
  assert.ok("deuteranopia" in cfg.viewports);
});

test("variant viewport options are validated", () => {
  const with_ = (vp) => () => validate({ ...merge(DEFAULTS, {}), viewports: { v: { width: 400, height: 800, ...vp } } });
  assert.doesNotThrow(with_({ zoom: 2, vision: "protanopia", forcedColors: true, textSpacing: true, colorScheme: "dark" }));
  assert.throws(with_({ zoom: 9 }), /zoom must be a number from 1 to 4/);
  assert.throws(with_({ vision: "colourblind" }), /vision must be one of/);
  assert.throws(with_({ forcedColors: "yes" }), /forcedColors must be true or false/);
  assert.throws(with_({ colorScheme: "sepia" }), /colorScheme must be light or dark/);
});

test("the critic is told what each variant tests", () => {
  const notes = variantNotes(a11yViewports(DEFAULT_VIEWPORTS));
  for (const must of ["reflow-320: a 320px-wide screen (WCAG 1.4.10", "zoom-200: browser zoom at 200% (WCAG 1.4.4", "text-spacing: text spacing raised to WCAG 1.4.12", "forced-colors: Windows high-contrast", "deuteranopia: a simulation of deuteranopia", "dark: the dark colour scheme"]) {
    assert.ok(notes.includes(must), `notes mention ${must}`);
  }
  assert.equal(variantNotes(DEFAULT_VIEWPORTS), "", "plain viewports need no notes");
  assert.match(variantNotes({ "phone-dark": { night: true, fontScale: 1.3 } }), /phone-dark: the dark theme; the system font at 1.3x/);
});

test("scenarios and the sweep stay off the variants unless a scenario names one", () => {
  const scenarios = [{ name: "a" }, { name: "b", viewports: ["reflow-320"] }];
  assert.deepEqual(scenariosAt(scenarios, "reflow-320", { a11yPreset: true }).map((s) => s.name), ["b"]);
  assert.deepEqual(scenariosAt(scenarios, "desktop", { width: 1 }).map((s) => s.name), ["a"]);
  assert.equal(sweepFor({ enabled: true }, { a11yPreset: true }), null);
  assert.equal(sweepFor({ enabled: true }, { isMobile: true }), null);
  assert.deepEqual(sweepFor({ enabled: true }, { width: 1366 }), { hover: true, maxHover: 20, maxTabs: 60 });
});

test("the summary line reports sideways scrolling, overflow and cut-off text", () => {
  const line = auditSummary({ baseFontSize: "16px", fonts: { body: "Arial" }, interactive: { under24px: [] }, textContrast: { sampled: 1, failingAA: 0 }, images: { missingAlt: 0 }, layout: { horizontalScroll: true, scrollWidth: 632, offEdge: ["div"], clippedText: ["div", "p"] } });
  assert.match(line, /scrolls sideways \(632px wide\), 1 elements run off the edge, 2 texts cut off/);
});
