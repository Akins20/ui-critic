import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareSummary, critiqueSummary, annotations, MARKER } from "../src/summary.mjs";
import { upsertComment, pullRequestNumber } from "../src/github.mjs";

const comparison = {
  before: { label: "before" },
  after: { label: "after" },
  usage: { calls: 4, estimatedCostUSD: 0.0912 },
  results: [
    { route: "/", viewport: "desktop", verdict: "better", improved: ["a"], regressed: [], regressed_detail: [] },
    {
      route: "/shop|sale",
      viewport: "mobile",
      verdict: "mixed",
      improved: [],
      regressed: ["Contrast fell", "Spacing"],
      regressed_detail: [
        { text: "Contrast fell", kind: "measured", reason: "4.6:1 became 2.9:1" },
        { text: "Spacing", kind: "judged", reason: "tighter" },
      ],
    },
  ],
};

test("a comparison summary has the marker, a row per pair, the gate and the regressions", () => {
  const md = compareSummary(comparison, { failOn: "measured", artifact: "ui-critic-report" });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /\| \/shop\\\|sale \| mobile \| mixed \| 0 \| 2 \(1 measured\) \|/, "a pipe in a route cannot break the table");
  assert.match(md, /\*\*Gate `--fail-on measured`: tripped on 1 page\(s\)\.\*\*/);
  assert.match(md, /- \[measured\] \/shop\\\|sale at mobile: Contrast fell/);
  assert.match(md, /from the `ui-critic-report` artifact/);
  assert.match(md, /Cost: \$0\.0912 over 4 calls/);
  assert.match(compareSummary({ ...comparison, results: [comparison.results[0]] }, { failOn: "measured" }), /Gate `--fail-on measured`: passed\./);
});

test("a critique summary has the score, priorities and findings by severity", () => {
  const md = critiqueSummary({
    label: "before",
    overall: { score: 64, revamp_needed: false, top_priorities: ["Bigger targets", "Fix contrast"] },
    pages: [{ route: "launch", score: 72, findings: [{ severity: "high", observation: "Heart is 28dp" }, { severity: "low", observation: "x" }] }],
    usage: null,
  });
  assert.match(md, /### UI critic: before scored 64\/100/);
  assert.match(md, /1\. Bigger targets/);
  assert.match(md, /\| launch \| 72 \| 1 \| 0 \| 1 \|/);
  assert.match(md, /- launch: Heart is 28dp/);
  assert.doesNotMatch(md, /\n\n\n/, "no runs of blank lines");
});

test("annotations: an error for a measured regression, a warning for a judged one, escaped for the runner", () => {
  const lines = annotations({
    results: [
      { route: "/a,b", viewport: "mobile", regressed_detail: [{ text: "Line one\nline two 100%", kind: "measured", reason: "ratio: 2.9" }, { text: "Looser", kind: "judged", reason: "looks it" }] },
    ],
  });
  assert.equal(lines[0], "::error title=ui-critic%3A /a%2Cb at mobile::Line one%0Aline two 100%25 (measured: ratio: 2.9)");
  assert.match(lines[1], /^::warning title=/);
});

test("the comment is created once and updated in place afterwards", async () => {
  const comments = [{ id: 1, body: "unrelated" }];
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
    assert.equal(opts.headers.authorization, "Bearer t0ken");
    if (!opts.method) return { ok: true, json: async () => comments };
    if (opts.method === "POST") {
      const created = { id: 2, body: JSON.parse(opts.body).body };
      comments.push(created);
      return { ok: true, json: async () => created };
    }
    if (opts.method === "PATCH") return { ok: true, json: async () => ({}) };
    return { ok: false, status: 500 };
  };
  const body = `${MARKER}\nreport`;
  assert.deepEqual(await upsertComment({ token: "t0ken", repository: "o/r", issue: 7, body, fetchImpl }), { action: "created", id: 2 });
  assert.deepEqual(await upsertComment({ token: "t0ken", repository: "o/r", issue: 7, body, fetchImpl }), { action: "updated", id: 2 });
  assert.deepEqual(calls, ["GET /repos/o/r/issues/7/comments?per_page=100&page=1", "POST /repos/o/r/issues/7/comments", "GET /repos/o/r/issues/7/comments?per_page=100&page=1", "PATCH /repos/o/r/issues/comments/2"]);
  await assert.rejects(() => upsertComment({ repository: "o/r", issue: 7, body, fetchImpl }), /no GitHub token/);
  await assert.rejects(() => upsertComment({ token: "t", repository: "o/r", issue: null, body, fetchImpl }), /no pull request/);
  await assert.rejects(() => upsertComment({ token: "t", repository: "o/r", issue: 1, body, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
});

test("the pull request number comes from the event payload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uic-event-"));
  const event = path.join(dir, "event.json");
  await writeFile(event, JSON.stringify({ pull_request: { number: 42 } }));
  assert.equal(await pullRequestNumber(event), 42);
  assert.equal(await pullRequestNumber(path.join(dir, "missing.json")), null);
  assert.equal(await pullRequestNumber(undefined), null);
});
