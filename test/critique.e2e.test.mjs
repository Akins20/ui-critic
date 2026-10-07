import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { critique } from "../src/critique.mjs";
import { compare } from "../src/compare.mjs";
import { DEFAULTS, merge } from "../src/config.mjs";
import { encodePNG } from "../src/png.mjs";

/**
 * critique() and compare() end to end against a simulated Gemini API: fetch is
 * replaced by a function that answers each call by the schema it was sent, so the
 * whole orchestration (prompt, schemas, checkpoints, reports) runs without a network.
 */

const BRIEF = `# Brief

## Product
A layaway fashion store where a shopper pays monthly at zero interest and receives the item after the final payment.

## Audience
Nigerian shoppers on Android phones over variable data, wary of scams and hidden charges.
`;

function fakeGemini() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url: String(url), body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
    if (String(url).includes(":countTokens")) return ok({ totalTokens: 10 });
    if (String(url).includes(":generateContent")) {
      const schema = body.generationConfig.responseSchema;
      const props = schema.properties ?? {};
      let data;
      if (props.findings) {
        const vp = props.findings.items.properties.viewport.enum[0];
        data = {
          page: "x",
          summary: "Works.",
          score: 70,
          strengths: ["Clear"],
          findings: [{ page: "x", viewport: vp, severity: "high", category: "typography", observation: "Small text", evidence: "hero", recommendation: "16px", effort: "small", defect_kind: "ui", conflicts_with_decision: "", region: { viewport: vp, image: "first", box: [10, 20, 30, 40] } }],
          coverage: [{ discipline: "typography", status: "issue", note: "small" }],
          requests: [],
        };
      } else if (props.consistency_findings) {
        const routes = props.consistency_findings.items.properties.page.enum ?? ["/"];
        data = { verdict: "Fine.", score: 72, revamp_needed: false, consistency_findings: [{ page: routes[0], viewport: "desktop", severity: "low", category: "consistency", observation: "o", evidence: "e", recommendation: "r", effort: "small", defect_kind: "ui", conflicts_with_decision: "", region: { viewport: "desktop", image: "first", box: [] } }], top_priorities: ["One"], requests: [] };
      } else if (props.verdict && props.improved) {
        data = { verdict: "better", improved: ["Hero larger"], regressed: [], still_open: [], notes: "" };
      } else {
        data = {};
      }
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
    }
    return { ok: false, status: 404, text: async () => "unexpected", json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

async function captureDir(root, label, shots) {
  const dir = path.join(root, label);
  await mkdir(dir, { recursive: true });
  const png = encodePNG({ width: 4, height: 4, data: new Uint8Array(64).fill(200) });
  const out = [];
  for (const s of shots) {
    const fold = path.join(dir, `${s.slug}.${s.viewport}.fold.png`);
    const full = path.join(dir, `${s.slug}.${s.viewport}.full.png`);
    await writeFile(fold, png);
    await writeFile(full, png);
    out.push({ route: s.route, path: s.route, viewport: s.viewport, title: s.route, fold, full, ...(s.blocked ? { blocked: s.blocked } : {}) });
  }
  const manifest = { label, base: "https://shop.example", capturedAt: `2026-10-07T00:00:0${label.length}Z`, viewports: { desktop: { width: 1366, height: 900 } }, shots: out, skipped: [], dir };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  return dir;
}

async function withFakeApi(fn) {
  const { calls, fetchImpl } = fakeGemini();
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  globalThis.fetch = fetchImpl;
  process.env.GEMINI_API_KEY = "test-key-not-real";
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  }
}

test("critique runs end to end: blocked pages are listed not reviewed, schemas carry the capture's names, reports are written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-e2e-"));
  const dir = await captureDir(root, "before", [
    { route: "/", slug: "home", viewport: "desktop" },
    { route: "/rival", slug: "rival", viewport: "desktop", blocked: 'the site served a bot check ("Just a moment...")' },
  ]);
  const config = { ...merge(DEFAULTS, { out: root, cache: { enabled: true, minTokens: 2048 } }), briefText: BRIEF, brief: "brief.md" };
  const result = await withFakeApi(async (calls) => {
    const r = await critique({ dir, config });
    const prompts = calls.filter((c) => c.url.includes(":generateContent")).map((c) => JSON.stringify(c.body.contents));
    assert.ok(prompts.every((p) => !p.includes("Screenshot: /rival")), "the blocked page never reaches the critic");
    const pageCall = calls.find((c) => c.body.generationConfig?.responseSchema?.properties?.findings);
    assert.deepEqual(pageCall.body.generationConfig.responseSchema.properties.findings.items.properties.viewport.enum, ["desktop"]);
    const siteCall = calls.find((c) => c.body.generationConfig?.responseSchema?.properties?.consistency_findings);
    assert.deepEqual(siteCall.body.generationConfig.responseSchema.properties.consistency_findings.items.properties.page.enum, ["/"]);
    return r;
  });
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.pages[0].findings[0].region, { viewport: "desktop", image: "first", box: [10, 20, 30, 40] });
  assert.equal(result.overall.consistency_findings[0].region.box, null, "an empty box means no single place");
  assert.ok(result.skipped.some((s) => s.startsWith("/rival at desktop (the site served a bot check")));
  for (const f of ["critique.json", "critique.md", "critique.html"]) await access(path.join(dir, f));
  assert.match(await readFile(path.join(dir, "critique.md"), "utf8"), /### Not captured\n- \/rival at desktop/);
  assert.equal(result.usage.calls, 2, "one page call and one site call");
});

test("compare skips a pair where either side met a bot check and lists it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-e2e-cmp-"));
  const before = await captureDir(root, "before", [
    { route: "/", slug: "home", viewport: "desktop" },
    { route: "/x", slug: "x", viewport: "desktop" },
  ]);
  const after = await captureDir(root, "after-run", [
    { route: "/", slug: "home", viewport: "desktop" },
    { route: "/x", slug: "x", viewport: "desktop", blocked: "the site served a bot check" },
  ]);
  const config = { ...merge(DEFAULTS, { out: root, compare: { confirmRegressions: false } }), briefText: BRIEF, brief: "brief.md" };
  const result = await withFakeApi(() => compare({ before, after, config }));
  assert.deepEqual(result.results.map((r) => `${r.route}:${r.verdict}`), ["/:better"]);
  assert.deepEqual(result.skipped, [{ route: "/x", viewport: "desktop", reason: "the site served a bot check" }]);
  await access(path.join(after, "compare.html"));
});
