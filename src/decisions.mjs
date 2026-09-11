import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Settled decisions: things the product team has decided and does not want
 * reviewed again (the real contact address, a deliberate flat layout, a rejected
 * pattern). They are listed in a Markdown file, one bullet each, ideally with the
 * reason after a colon. The critic is told they are closed; every finding carries
 * the decision it would reopen (or nothing), and those findings are withheld from
 * the report but counted, so the filter stays auditable.
 */

/** Parses a decisions file: bullet or numbered lines become decisions; the rest is ignored. */
export function parseDecisions(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Reads the configured decisions file; a missing file means no decisions. */
export async function loadDecisions(config) {
  const file = config?.context?.decisions;
  if (!file) return [];
  try {
    return parseDecisions(await readFile(path.resolve(file), "utf8"));
  } catch {
    return [];
  }
}

/** The prompt section that closes the settled decisions to further review. */
export function decisionsSection(decisions) {
  if (!decisions?.length) return "";
  const list = decisions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  return `## Settled decisions (closed)
The product team has decided these and they are not up for review, however strongly you disagree. Do not raise findings, requests or still-open items whose only substance is one of them. For every finding, set conflicts_with_decision to the decision it would reopen, quoted from this list, or to an empty string when it reopens none; findings that name a decision are withheld from the report.
${list}`;
}

/**
 * Splits findings into the ones to report and the ones that reopen a settled
 * decision (conflicts_with_decision names one). Empty, "none" and "null" count as
 * no conflict, so a model that answers in words does not lose a real finding.
 */
export function withholdSettled(findings) {
  const kept = [];
  const withheld = [];
  for (const f of findings ?? []) {
    const flag = String(f.conflicts_with_decision ?? "").trim();
    if (flag && !/^(none|null|n\/a|no)$/i.test(flag)) withheld.push(f);
    else kept.push(f);
  }
  return { kept, withheld };
}
