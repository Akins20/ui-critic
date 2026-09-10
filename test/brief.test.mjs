import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { briefProblems, requireBrief, contextSections } from "../src/brief.mjs";
import { mergeRequests, followablePages } from "../src/critique.mjs";
import { auditSummary, auditForPrompt } from "../src/audit.mjs";
import { requestsSection, coverageLine } from "../src/report.mjs";
import { DEFAULTS, DEFAULT_DISCIPLINES } from "../src/config.mjs";
import { preamble } from "../src/critique.mjs";

const GOOD = `# Store brief

## Product
A layaway fashion store where a shopper picks an item, pays monthly at zero interest and receives it after the final payment.

## Audience
Nigerian shoppers on Android phones over variable data, wary of scams, comparing with Jumia and Instagram vendors.
`;

test("briefProblems accepts a filled brief and rejects empty, template and missing sections", () => {
  assert.deepEqual(briefProblems(GOOD), []);
  assert.deepEqual(briefProblems(""), ["the brief is empty"]);
  const noAudience = GOOD.replace(/## Audience[\s\S]*/, "");
  assert.ok(briefProblems(noAudience).some((p) => p.includes('"## Audience"')));
  const template = "# <Product name> storefront brief\n\n## Product\nWhat it is, in two sentences, and the one thing.\n\n## Audience\nWho they are, what devices and networks they use, and more words here.\n";
  const problems = briefProblems(template);
  assert.ok(problems.some((p) => p.includes("template text")));
  const short = "## Product\nA shop.\n\n## Audience\nPeople.\n";
  assert.ok(briefProblems(short).some((p) => p.includes("too short")));
});

test("requireBrief throws with guidance", () => {
  assert.throws(() => requireBrief({ briefText: "", brief: undefined }), /ui-critic init/);
  assert.doesNotThrow(() => requireBrief({ briefText: GOOD, brief: "b.md" }));
});

test("contextSections includes files and answers, tolerating missing ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ui-critic-ctx-"));
  const tokens = path.join(dir, "tokens.css");
  await writeFile(tokens, ":root { --plum: #6a1b5a; }");
  const answers = path.join(dir, "answers.md");
  await writeFile(answers, "Q: checkout? A: it is behind login.");
  const out = await contextSections({ context: { files: [tokens, path.join(dir, "missing.md")], answers } });
  assert.match(out, /## Additional context/);
  assert.match(out, /--plum/);
  assert.match(out, /could not be read/);
  assert.match(out, /Answers to your earlier requests/);
  assert.equal(await contextSections({ context: { files: [], answers: path.join(dir, "none.md") } }), "");
});

test("mergeRequests dedupes by kind and target", () => {
  const merged = mergeRequests([
    [{ kind: "page", target: "/checkout", why: "a" }],
    [{ kind: "page", target: " /checkout ", why: "b" }, { kind: "answer", target: "refund window?", why: "c" }],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].why, "a");
});

test("followablePages keeps same-origin, uncaptured page requests, capped", () => {
  const manifest = { base: "https://shop.example", shots: [{ route: "/" }, { route: "/shop" }] };
  const requests = [
    { kind: "page", target: "/checkout" },
    { kind: "page", target: "https://shop.example/account/plans?x=1" },
    { kind: "page", target: "https://other.example/x" },
    { kind: "page", target: "/shop" },
    { kind: "file", target: "tokens" },
    { kind: "page", target: "faq" },
  ];
  assert.deepEqual(followablePages(requests, manifest, 2), ["/checkout", "/account/plans?x=1"]);
  assert.deepEqual(followablePages(requests, manifest, 5), ["/checkout", "/account/plans?x=1", "/faq"]);
});

test("audit summary and prompt form are compact", () => {
  const audit = {
    baseFontSize: "16px",
    fonts: { body: "Inter", h2: "Fraunces" },
    interactive: { under24px: [{ name: "dot", w: 8, h: 8 }] },
    textContrast: { sampled: 120, failingAA: 2, lowest: [] },
    images: { missingAlt: 0 },
  };
  assert.equal(auditSummary(audit), "base 16px, Inter body, Fraunces headings, 1 targets under 24px, 2/120 text samples fail AA contrast, 0 images missing alt");
  assert.equal(auditSummary({ error: "boom" }), "audit failed: boom");
  assert.ok(auditForPrompt(audit, 40).endsWith("...}"));
});

test("requestsSection lists open requests and what was followed", () => {
  const s = requestsSection(
    [{ kind: "page", target: "/checkout", why: "money page" }, { kind: "answer", target: "returns?", why: "policy" }],
    { routes: ["/checkout"], skipped: null },
  );
  assert.match(s, /captured and reviewed: \/checkout/);
  assert.match(s, /\[answer\] returns\?: policy/);
  assert.doesNotMatch(s, /\[page\] \/checkout/);
  assert.equal(requestsSection([], { routes: [] }), "");
});

test("disciplines are complete by default and spelled out to the critic", () => {
  assert.equal(DEFAULTS.disciplines, DEFAULT_DISCIPLINES);
  for (const must of ["typography", "spacing", "dividers", "states", "motion", "accessibility", "consistency"]) {
    assert.ok(DEFAULT_DISCIPLINES.some((d) => d.includes(must)), `disciplines mention ${must}`);
  }
  const text = preamble(["typography: scale", "spacing: rhythm"]);
  assert.match(text, /1\. typography: scale\n2\. spacing: rhythm/);
  assert.match(text, /record in coverage/);
});

test("coverageLine summarises fine, issues and not applicable", () => {
  const line = coverageLine([
    { discipline: "typography", status: "issue", note: "x" },
    { discipline: "spacing", status: "ok", note: "y" },
    { discipline: "motion", status: "not-applicable", note: "z" },
  ]);
  assert.equal(line, "Disciplines: 1 fine; issues in typography; 1 not applicable");
  assert.equal(coverageLine([]), "");
});
