import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Score trends: one line per critique in <out>/trend.jsonl, so a team can see
 * whether the work is making the product better over weeks rather than arguing
 * about one run's number. Scores are the critic's judgement and drift between runs
 * even on an unchanged page, so the trend is read as a direction, not a measurement;
 * the counts of high findings and of lint problems beside it are the steadier
 * numbers, and are shown with it.
 */

export const TREND_FILE = "trend.jsonl";

const severityCounts = (findings = []) => {
  const out = { high: 0, medium: 0, low: 0 };
  for (const f of findings) if (out[f.severity] !== undefined) out[f.severity] += 1;
  return out;
};

/** One run's row, from a critique result. */
export function trendRow(result) {
  const findings = [...(result.pages ?? []).flatMap((p) => p.findings ?? []), ...(result.overall?.consistency_findings ?? [])];
  return {
    at: result.reviewedAt,
    label: result.label,
    base: result.base ?? null,
    platform: result.platform ?? "web",
    model: result.model ?? null,
    score: result.overall?.score ?? null,
    findings: severityCounts(findings),
    lint: result.lint ? severityCounts(result.lint.findings ?? []) : null,
    pages: (result.pages ?? []).filter((p) => p.score !== null && p.score !== undefined).map((p) => ({ route: p.route, score: p.score })),
  };
}

/** Appends a run to the trend file. A trend that cannot be written never fails a run. */
export async function recordTrend(outDir, result) {
  const row = trendRow(result);
  if (row.score === null) return null;
  const file = path.join(outDir, TREND_FILE);
  try {
    await appendFile(file, `${JSON.stringify(row)}\n`);
  } catch {
    return null;
  }
  return { file, row };
}

/** Every recorded run, oldest first; a damaged line is skipped rather than fatal. */
export async function readTrend(outDir) {
  let text;
  try {
    text = await readFile(path.join(outDir, TREND_FILE), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a half-written line from an interrupted run
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const bar = (score, width = 24) => "#".repeat(Math.max(0, Math.round((score / 100) * width))).padEnd(width, ".");

const delta = (now, before) => {
  if (before === null || before === undefined) return "";
  const d = now - before;
  return d === 0 ? "  same" : `  ${d > 0 ? "+" : ""}${d}`;
};

/**
 * The trend as text: a line per run with its score, how it moved, and the counts
 * that do not drift. With `route`, the same for one page.
 */
export function renderTrend(rows, { route = null } = {}) {
  if (!rows.length) return "no runs recorded yet: the trend is written by critique, one line per run";
  const series = route
    ? rows.map((r) => ({ ...r, score: r.pages.find((p) => p.route === route)?.score ?? null })).filter((r) => r.score !== null)
    : rows;
  if (!series.length) return `no run has a score for ${route}`;
  const lines = [route ? `Score for ${route}, ${series.length} runs` : `Overall score, ${series.length} runs`, ""];
  let previous = null;
  for (const r of series) {
    const when = String(r.at).slice(0, 16).replace("T", " ");
    const counts = [`${r.findings.high} high`, r.lint ? `${r.lint.high} lint` : null].filter(Boolean).join(", ");
    lines.push(`${when}  ${String(r.label).padEnd(10).slice(0, 10)}  ${String(r.score).padStart(3)} ${bar(r.score)}${delta(r.score, previous).padEnd(7)}  ${counts}`);
    previous = r.score;
  }
  const first = series[0].score;
  const last = series[series.length - 1].score;
  lines.push("", `From ${first} to ${last} over ${series.length} runs${first === last ? "" : `, ${last > first ? "up" : "down"} ${Math.abs(last - first)}`}.`);
  if (!route && series.length > 1) {
    const routes = [...new Set(series.flatMap((r) => r.pages.map((p) => p.route)))];
    const moved = routes
      .map((rt) => {
        const scores = series.map((r) => r.pages.find((p) => p.route === rt)?.score).filter((s) => s !== undefined);
        return scores.length > 1 ? { route: rt, from: scores[0], to: scores[scores.length - 1] } : null;
      })
      .filter(Boolean)
      .filter((p) => p.to !== p.from)
      .sort((a, b) => a.to - a.from - (b.to - b.from));
    if (moved.length) {
      lines.push("", "Per page, first run to last:");
      for (const p of moved) lines.push(`  ${p.route.padEnd(28).slice(0, 28)} ${p.from} to ${p.to}  ${p.to > p.from ? "+" : ""}${p.to - p.from}`);
    }
  }
  lines.push("", "Scores are judgement and drift a little between runs; read the direction, not the number.");
  return lines.join("\n");
}
