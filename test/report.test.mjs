import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCritique, renderCompare, usageLine } from "../src/report.mjs";
import { routeSlug } from "../src/capture.mjs";

const finding = (id, severity) => ({
  id,
  page: "/",
  viewport: "mobile",
  severity,
  category: "hierarchy",
  observation: `obs ${id}`,
  evidence: "top left",
  recommendation: "do the thing",
  effort: "small",
  defect_kind: "ui",
});

test("routeSlug is file safe and stable", () => {
  assert.equal(routeSlug("/"), "home");
  assert.equal(routeSlug("/products/agbada-set#top"), "products-agbada-set");
  assert.equal(routeSlug("/products/agbada-set?x=1#top"), "products-agbada-set-q-x-1");
  assert.equal(routeSlug("shop/"), "shop");
});

test("renderCritique orders findings by severity and includes usage", () => {
  const md = renderCritique({
    label: "before",
    base: "https://x",
    model: "m",
    reviewedAt: "now",
    overall: { score: 61, revamp_needed: false, verdict: "V", top_priorities: ["p1"], consistency_findings: [finding("site-1", "low")] },
    pages: [{ route: "/", score: 70, summary: "S", strengths: ["good"], findings: [finding("home-1", "low"), finding("home-2", "high")] }],
    usage: { calls: 2, totalTokens: 100, cachedTokens: 40, thoughtsTokens: 10, estimatedCostUSD: 0.0123, cache: { used: true, tokens: 40 }, thinking: { thinkingLevel: "high" } },
  });
  assert.match(md, /revamp needed: no/);
  assert.ok(md.indexOf("home-2") < md.indexOf("home-1"), "high severity first");
  assert.match(md, /Usage: 2 calls, 100 tokens \(40 cached, 10 thinking\), about \$0.0123; cache used \(40 tokens\)/);
});

test("usageLine says when cost is unknown", () => {
  assert.match(usageLine({ calls: 1, totalTokens: 5, cachedTokens: 0, thoughtsTokens: 0, estimatedCostUSD: null, cache: { used: false, reason: "disabled" } }), /cost unknown/);
});

test("renderCompare lists improved, regressed and still open", () => {
  const md = renderCompare({
    before: { label: "before", base: "a", capturedAt: "t1" },
    after: { label: "after", base: "b", capturedAt: "t2" },
    model: "m",
    comparedAt: "t3",
    results: [{ route: "/", viewport: "mobile", verdict: "better", improved: ["i1"], regressed: [], still_open: ["o1"], notes: "n" }],
    usage: { calls: 1, totalTokens: 1, cachedTokens: 0, thoughtsTokens: 0, estimatedCostUSD: null, cache: { used: false, reason: "x" } },
  });
  assert.match(md, /## \/ at mobile: better/);
  assert.match(md, /Improved:\n- i1/);
  assert.match(md, /Still open:\n- o1/);
  assert.doesNotMatch(md, /Regressed:/);
});
