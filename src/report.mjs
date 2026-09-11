import { auditSummary } from "./audit.mjs";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function findingLine(f) {
  return [
    `- **${f.id}** [${f.severity}, ${f.category}, ${f.viewport}, effort ${f.effort}, ${f.defect_kind}]`,
    `  ${f.observation}`,
    `  Evidence: ${f.evidence}`,
    `  Do: ${f.recommendation}`,
  ].join("\n");
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

/** One line of token and cost accounting for a run. */
export function usageLine(u) {
  if (!u) return "";
  const cost =
    u.estimatedCostUSD == null
      ? "cost unknown (no price known for this model; add it under pricing in the config)"
      : `about $${u.estimatedCostUSD.toFixed(4)}${u.cacheStorageUSD ? ` incl. $${u.cacheStorageUSD.toFixed(4)} cache storage` : ""} at ${u.price ?? "the configured price"}`;
  const cache = u.cache?.used ? `cache used (${u.cache.tokens ?? "?"} tokens)` : `no cache (${u.cache?.reason ?? "off"})`;
  const thinking = u.thinking ? JSON.stringify(u.thinking) : "default";
  return `Usage: ${u.calls} calls, ${u.totalTokens} tokens (${u.cachedTokens} cached, ${u.thoughtsTokens} thinking), ${cost}; ${cache}; thinking ${thinking}`;
}

/** The critic's outstanding requests, grouped by what the reader has to do. */
export function requestsSection(requests, followed) {
  const lines = [];
  if (followed?.routes?.length) {
    lines.push(`Pages the critic asked for and the tool captured and reviewed: ${followed.routes.join(", ")}${followed.skipped ? ` (skipped: ${followed.skipped})` : ""}`);
  }
  const open = (requests ?? []).filter((r) => !(r.kind === "page" && followed?.routes?.includes(r.target)));
  if (!open.length) {
    if (!lines.length) return "";
    return ["### Critic's requests", ...lines, ""].join("\n");
  }
  lines.push("Answer these in the answers file (ui-critic/answers.md by default) or add the page to routes, then rerun:");
  for (const r of open) lines.push(`- [${r.kind}] ${r.target}: ${r.why}`);
  return ["### Critic's requests", ...lines, ""].join("\n");
}

/** A compact account of which disciplines the critic found fine and which raised issues. */
export function coverageLine(coverage) {
  if (!coverage || !coverage.length) return "";
  const ok = coverage.filter((c) => c.status === "ok").length;
  const issues = coverage.filter((c) => c.status === "issue").map((c) => c.discipline);
  const na = coverage.filter((c) => c.status === "not-applicable").length;
  const parts = [`${ok} fine`, issues.length ? `issues in ${issues.join(", ")}` : "no discipline flagged"];
  if (na) parts.push(`${na} not applicable`);
  return `Disciplines: ${parts.join("; ")}`;
}

/** Renders a critique result as a readable Markdown report. */
export function renderCritique(result) {
  const lines = [];
  lines.push(`# UI critique: ${result.label} (${result.base})`);
  lines.push(`Model ${result.model}, reviewed ${result.reviewedAt}`);
  lines.push(usageLine(result.usage));
  lines.push("");
  const score = result.overall.score == null ? "n/a" : `${result.overall.score}/100`;
  const revamp = result.overall.revamp_needed == null ? "n/a" : result.overall.revamp_needed ? "yes" : "no";
  lines.push(`## Overall: ${score}, revamp needed: ${revamp}`);
  lines.push(result.overall.verdict);
  lines.push("");
  lines.push("### Top priorities");
  result.overall.top_priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  if (result.overall.consistency_findings.length) {
    lines.push("");
    lines.push("### Cross-page findings");
    for (const f of sortFindings(result.overall.consistency_findings)) lines.push(findingLine(f));
  }
  if (result.skipped?.length) {
    lines.push("");
    lines.push("### Not captured");
    for (const s of result.skipped) lines.push(`- ${s}`);
  }
  const withheldSite = result.overall.withheld ?? [];
  const withheldPages = (result.pages ?? []).flatMap((p) => p.withheld ?? []);
  if (result.decisions?.length) {
    lines.push("");
    lines.push(`### Settled decisions applied: ${result.decisions.length}; findings withheld: ${withheldSite.length + withheldPages.length}`);
    for (const f of [...withheldSite, ...withheldPages].slice(0, 20)) {
      lines.push(`- [${f.page ?? "site"}] ${f.observation} (reopens: ${f.conflicts_with_decision})`);
    }
  }
  const reqs = requestsSection(result.requests, result.followed);
  if (reqs) {
    lines.push("");
    lines.push(reqs.trimEnd());
  }
  for (const page of result.pages) {
    lines.push("");
    lines.push(`## ${page.route}: ${page.score}/100`);
    lines.push(page.summary);
    const measured = Object.entries(page.audits ?? {})
      .map(([vp, a]) => `${vp}: ${auditSummary(a)}`)
      .filter((s) => !s.endsWith(": "));
    if (measured.length) lines.push(`Measured: ${measured.join("; ")}`);
    const cov = coverageLine(page.coverage);
    if (cov) lines.push(cov);
    if (page.strengths.length) {
      lines.push("");
      lines.push("Strengths:");
      for (const s of page.strengths) lines.push(`- ${s}`);
    }
    lines.push("");
    lines.push(`Findings (${page.findings.length}):`);
    for (const f of sortFindings(page.findings)) lines.push(findingLine(f));
  }
  lines.push("");
  return lines.join("\n");
}

/** Renders a before/after comparison as Markdown. */
export function renderCompare(result) {
  const lines = [];
  lines.push(`# UI comparison: ${result.before.label} vs ${result.after.label}`);
  lines.push(`Model ${result.model}, compared ${result.comparedAt}`);
  lines.push(`Before: ${result.before.base} (${result.before.capturedAt})`);
  lines.push(`After: ${result.after.base} (${result.after.capturedAt})`);
  lines.push(usageLine(result.usage));
  for (const r of result.results) {
    lines.push("");
    lines.push(`## ${r.route} at ${r.viewport}: ${r.verdict}`);
    if (r.improved.length) {
      lines.push("Improved:");
      for (const s of r.improved) lines.push(`- ${s}`);
    }
    if (r.regressed.length) {
      const kinds = new Map((r.regressed_detail ?? []).map((d) => [d.text, d.kind]));
      lines.push(r.regressed_detail?.length ? "Regressed (confirmed on a second look):" : "Regressed:");
      for (const s of r.regressed) lines.push(`- ${kinds.has(s) ? `[${kinds.get(s)}] ` : ""}${s}`);
    }
    if (r.unconfirmed_regressions?.length) {
      lines.push("Reported but not confirmed on a second look:");
      for (const u of r.unconfirmed_regressions) lines.push(`- ${u.text} (${u.reason})`);
    }
    if (r.still_open.length) {
      lines.push("Still open:");
      for (const s of r.still_open) lines.push(`- ${s}`);
    }
    if (r.notes) lines.push(`Notes: ${r.notes}`);
  }
  lines.push("");
  return lines.join("\n");
}
