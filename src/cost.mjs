import { readFile } from "node:fs/promises";
import { resolvePrice, estimateCost, describePrice } from "./pricing.mjs";

/**
 * Reads a usage ledger (JSON lines, one call per line) and totals it per run with
 * a cost recomputed from the prices known now, so a ledger written before a price
 * was known, or with a config override, still yields a number. Entries whose model
 * has no known price are counted in tokens and flagged.
 */
export async function costReport(ledgerPath, overrides = {}) {
  const raw = await readFile(ledgerPath, "utf8");
  const runs = new Map();
  let unknown = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const key = entry.run || "(no run label)";
    if (!runs.has(key)) {
      runs.set(key, { run: key, model: entry.model, calls: 0, promptTokens: 0, cachedTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, costUSD: 0, priced: 0, first: entry.ts, last: entry.ts });
    }
    const r = runs.get(key);
    r.calls += 1;
    for (const k of ["promptTokens", "cachedTokens", "candidatesTokens", "thoughtsTokens"]) r[k] += entry[k] ?? 0;
    if (entry.ts < r.first) r.first = entry.ts;
    if (entry.ts > r.last) r.last = entry.ts;
    const price = resolvePrice(entry.model, overrides, entry.ts);
    const cost = estimateCost(entry, price);
    if (cost == null) unknown += 1;
    else {
      r.costUSD += cost;
      r.priced += 1;
    }
    if (price && !r.price) r.price = describePrice(price);
  }
  const rows = Array.from(runs.values()).map((r) => ({ ...r, costUSD: Math.round(r.costUSD * 1e6) / 1e6 }));
  const total = Math.round(rows.reduce((sum, r) => sum + r.costUSD, 0) * 1e6) / 1e6;
  return { ledger: ledgerPath, runs: rows, totalUSD: total, unpricedCalls: unknown };
}

/** The cost report as aligned text lines. */
export function renderCostReport(report) {
  const lines = [`Ledger: ${report.ledger}`];
  for (const r of report.runs) {
    const tokens = `${r.promptTokens} prompt (${r.cachedTokens} cached), ${r.candidatesTokens} output, ${r.thoughtsTokens} thinking`;
    const cost = r.priced === r.calls ? `$${r.costUSD.toFixed(4)}` : r.priced === 0 ? "cost unknown" : `$${r.costUSD.toFixed(4)} for ${r.priced} of ${r.calls} calls`;
    lines.push(`  ${r.run.padEnd(28)} ${r.model.padEnd(24)} ${String(r.calls).padStart(3)} calls  ${tokens}  ${cost}`);
    if (r.price) lines.push(`  ${"".padEnd(28)} ${r.price}`);
  }
  lines.push(`Total: $${report.totalUSD.toFixed(4)}${report.unpricedCalls ? ` (${report.unpricedCalls} calls without a known price)` : ""}`);
  return lines.join("\n");
}
