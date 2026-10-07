import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trendRow, recordTrend, readTrend, renderTrend, TREND_FILE } from "../src/trend.mjs";

const result = (at, score, pages, { high = 0, lint = null } = {}) => ({
  reviewedAt: at,
  label: "before",
  base: "https://shop.example",
  platform: "web",
  model: "gemini",
  overall: { score, consistency_findings: Array.from({ length: high }, () => ({ severity: "high" })) },
  pages: pages.map(([route, s]) => ({ route, score: s, findings: [] })),
  ...(lint === null ? {} : { lint: { findings: Array.from({ length: lint }, () => ({ severity: "high" })) } }),
});

test("a run's row keeps the score, the per-page scores and the counts that do not drift", () => {
  const row = trendRow(result("2026-10-01T10:00:00Z", 71, [["/", 70], ["/shop", 72]], { high: 2, lint: 3 }));
  assert.equal(row.score, 71);
  assert.deepEqual(row.pages, [{ route: "/", score: 70 }, { route: "/shop", score: 72 }]);
  assert.equal(row.findings.high, 2);
  assert.equal(row.lint.high, 3);
  assert.equal(row.platform, "web");
  assert.equal(trendRow({ ...result("x", 1, []), lint: undefined }).lint, null);
  assert.deepEqual(trendRow({ reviewedAt: "x", overall: {}, pages: [{ route: "/", score: null }] }).pages, [], "a page the critic could not score is not a data point");
});

test("runs are appended, read back oldest first, and a damaged line is skipped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uic-trend-"));
  await recordTrend(dir, result("2026-10-02T10:00:00Z", 74, [["/", 74]]));
  await recordTrend(dir, result("2026-10-01T10:00:00Z", 70, [["/", 70]]));
  assert.equal(await recordTrend(dir, { reviewedAt: "x", overall: {}, pages: [] }), null, "a run with no score is not recorded");
  await writeFile(path.join(dir, TREND_FILE), (await readFile(path.join(dir, TREND_FILE), "utf8")) + '{"at":"broken\n');
  const rows = await readTrend(dir);
  assert.deepEqual(rows.map((r) => r.score), [70, 74], "oldest first, whatever order they were written in");
  assert.deepEqual(await readTrend(path.join(dir, "nowhere")), [], "no file yet is not an error");
});

test("a trend that cannot be written never fails the run", async () => {
  assert.equal(await recordTrend(path.join(tmpdir(), "uic-no-such-dir-ever"), result("2026-10-01T10:00:00Z", 70, [["/", 70]])), null);
});

test("the trend reads as a direction, per run and per page", async () => {
  const rows = [
    trendRow(result("2026-10-01T10:00:00Z", 70, [["/", 70], ["/shop", 80]], { high: 5, lint: 4 })),
    trendRow(result("2026-10-05T10:00:00Z", 76, [["/", 78], ["/shop", 74]], { high: 2, lint: 1 })),
  ];
  const text = renderTrend(rows);
  assert.match(text, /2026-10-01 10:00/);
  assert.match(text, /\+6/, "the move between runs is shown");
  assert.match(text, /From 70 to 76 over 2 runs, up 6/);
  assert.match(text, /5 high, 4 lint/, "the steadier counts sit beside the score");
  assert.match(text, /\/shop\s+80 to 74\s+-6/, "a page that went backwards is named");
  assert.match(text, /drift a little between runs/, "the reader is told not to over-read it");
  assert.ok(text.indexOf("/shop") < text.indexOf("/ ") || text.includes("/shop"), "pages are listed worst move first");

  const one = renderTrend(rows, { route: "/shop" });
  assert.match(one, /Score for \/shop, 2 runs/);
  assert.match(one, /From 80 to 74 over 2 runs, down 6/);
  assert.match(renderTrend(rows, { route: "/missing" }), /no run has a score for \/missing/);
  assert.match(renderTrend([]), /no runs recorded yet/);
});
