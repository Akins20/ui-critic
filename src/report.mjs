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
  const cost = u.estimatedCostUSD == null ? "cost unknown (no pricing configured for this model)" : `about $${u.estimatedCostUSD.toFixed(4)}`;
  const cache = u.cache?.used ? `cache used (${u.cache.tokens ?? "?"} tokens)` : `no cache (${u.cache?.reason ?? "off"})`;
  const thinking = u.thinking ? JSON.stringify(u.thinking) : "default";
  return `Usage: ${u.calls} calls, ${u.totalTokens} tokens (${u.cachedTokens} cached, ${u.thoughtsTokens} thinking), ${cost}; ${cache}; thinking ${thinking}`;
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
  for (const page of result.pages) {
    lines.push("");
    lines.push(`## ${page.route}: ${page.score}/100`);
    lines.push(page.summary);
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
      lines.push("Regressed:");
      for (const s of r.regressed) lines.push(`- ${s}`);
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
