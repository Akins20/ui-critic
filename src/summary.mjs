import { gateHits } from "./compare.mjs";

/**
 * Short Markdown for places with little room: a pull request comment and a CI job
 * summary. The full reports stay in the capture folder (and the uploaded
 * artifact); this says what a reviewer needs at a glance and where to look next.
 */

/** Marks the tool's own pull request comment, so a later run updates it instead of adding another. */
export const MARKER = "<!-- ui-critic -->";

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const cost = (usage) => (usage?.estimatedCostUSD != null ? `$${usage.estimatedCostUSD.toFixed(4)} over ${usage.calls} calls` : usage ? `${usage.calls} calls, cost unknown` : "");

const where = (artifact, file) => (artifact ? `Open \`${file}\` from the \`${artifact}\` artifact for the screenshots.` : `Open \`${file}\` in the capture folder for the screenshots.`);

/** A comparison in a few lines: verdict per page, the gate, the confirmed regressions. */
export function compareSummary(result, { failOn, artifact } = {}) {
  const lines = [MARKER, `### UI critic: ${cell(result.before.label)} vs ${cell(result.after.label)}`, ""];
  lines.push("| Page | Viewport | Verdict | Improved | Regressed |", "| --- | --- | --- | --- | --- |");
  for (const r of result.results) {
    const measured = (r.regressed_detail ?? []).filter((d) => d.kind === "measured").length;
    const regressed = r.regressed?.length ? `${r.regressed.length}${measured ? ` (${measured} measured)` : ""}` : "0";
    lines.push(`| ${cell(r.route)} | ${cell(r.viewport)} | ${cell(r.verdict)} | ${r.improved?.length ?? 0} | ${regressed} |`);
  }
  lines.push("");
  if (failOn) {
    const hits = gateHits(result.results, failOn);
    lines.push(hits.length ? `**Gate \`--fail-on ${failOn}\`: tripped on ${hits.length} page(s).**` : `Gate \`--fail-on ${failOn}\`: passed.`, "");
  }
  const confirmed = result.results.flatMap((r) => (r.regressed_detail ?? []).map((d) => `- [${d.kind}] ${cell(r.route)} at ${cell(r.viewport)}: ${cell(d.text)}`));
  if (confirmed.length) lines.push("<details><summary>Confirmed regressions</summary>", "", ...confirmed, "", "</details>", "");
  lines.push(`${where(artifact, `${result.after.label}/compare.html`)}${result.usage ? ` Cost: ${cost(result.usage)}.` : ""}`);
  return lines.join("\n") + "\n";
}

/** A critique in a few lines: the score, the priorities, the findings per page by severity. */
export function critiqueSummary(result, { artifact } = {}) {
  const score = result.overall.score == null ? "n/a" : `${result.overall.score}/100`;
  const lines = [MARKER, `### UI critic: ${cell(result.label)} scored ${score}${result.overall.revamp_needed ? ", revamp recommended" : ""}`, ""];
  if (result.overall.top_priorities?.length) {
    lines.push("Top priorities:", ...result.overall.top_priorities.map((p, i) => `${i + 1}. ${cell(p)}`), "");
  }
  lines.push("| Page | Score | High | Medium | Low |", "| --- | --- | --- | --- | --- |");
  for (const p of result.pages) {
    const count = (s) => p.findings.filter((f) => f.severity === s).length;
    lines.push(`| ${cell(p.route)} | ${p.score ?? "n/a"} | ${count("high")} | ${count("medium")} | ${count("low")} |`);
  }
  lines.push("");
  const high = result.pages.flatMap((p) => p.findings.filter((f) => f.severity === "high").map((f) => `- ${cell(p.route)}: ${cell(f.observation)}`));
  if (high.length) lines.push("<details><summary>High-severity findings</summary>", "", ...high.slice(0, 15), high.length > 15 ? `- and ${high.length - 15} more in the report` : "", "", "</details>", "");
  lines.push(`${where(artifact, `${result.label}/critique.html`)}${result.usage ? ` Cost: ${cost(result.usage)}.` : ""}`);
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n") + "\n";
}

/** Escapes a value for a GitHub Actions workflow command. */
const command = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const property = (value) => command(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * Workflow-command annotations for a comparison: an error for every confirmed
 * regression backed by a measured fact, a warning for every judged one, so they show
 * on the run summary without opening any file.
 */
export function annotations(result) {
  const out = [];
  for (const r of result.results ?? []) {
    for (const d of r.regressed_detail ?? []) {
      const level = d.kind === "measured" ? "error" : "warning";
      out.push(`::${level} title=${property(`ui-critic: ${r.route} at ${r.viewport}`)}::${command(`${d.text} (${d.kind}: ${d.reason})`)}`);
    }
  }
  return out;
}
