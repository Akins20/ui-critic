import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imagePart, text } from "./parts.mjs";
import { createClient } from "./provider.mjs";
import { preamble, briefSection } from "./critique.mjs";
import { renderCompare } from "./report.mjs";
import { auditForPrompt } from "./audit.mjs";
import { requireBrief, contextSections } from "./brief.mjs";
import { loadDecisions, decisionsSection } from "./decisions.mjs";
import { runPool, serialWriter } from "./pool.mjs";

const COMPARISON = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["better", "same", "worse", "mixed"] },
    improved: { type: "ARRAY", items: { type: "STRING" }, description: "specific things that got better, with evidence" },
    regressed: { type: "ARRAY", items: { type: "STRING" }, description: "specific things that got worse, with evidence" },
    still_open: { type: "ARRAY", items: { type: "STRING" }, description: "important issues visible in both" },
    notes: { type: "STRING" },
  },
  required: ["verdict", "improved", "regressed", "still_open", "notes"],
};

/** The second look at a pair's reported regressions: each is confirmed or not. */
const ADJUDICATION = {
  type: "OBJECT",
  properties: {
    verdicts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          item: { type: "INTEGER", description: "the one-based number of the regression being judged" },
          confirmed: { type: "BOOLEAN", description: "true only if AFTER really shows it and BEFORE really did not" },
          kind: { type: "STRING", enum: ["measured", "judged"], description: "measured when a measured fact (contrast, target size, landmark or heading count, layout shift, errors) proves it; judged when it rests on visual judgement" },
          reason: { type: "STRING", description: "one sentence citing the capture or the fact" },
        },
        required: ["item", "confirmed", "kind", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

/**
 * Folds the second look into a pair's first result: confirmed regressions stay
 * (tagged measured or judged), the rest move to unconfirmed with their reason, and
 * a verdict that rested only on unconfirmed regressions is recomputed from what
 * remains. Pure, so the rule is testable.
 */
export function mergeAdjudication(result, adjudication) {
  const verdicts = adjudication?.verdicts ?? [];
  const byItem = new Map(verdicts.map((v) => [Number(v.item), v]));
  const regressed = [];
  const detail = [];
  const unconfirmed = [];
  (result.regressed ?? []).forEach((textItem, i) => {
    const v = byItem.get(i + 1);
    if (v && v.confirmed) {
      regressed.push(textItem);
      detail.push({ text: textItem, kind: v.kind === "measured" ? "measured" : "judged", reason: v.reason });
    } else {
      unconfirmed.push({ text: textItem, reason: v?.reason ?? "not judged on the second look" });
    }
  });
  let verdict = result.verdict;
  let notes = result.notes ?? "";
  if (unconfirmed.length && regressed.length === 0 && (verdict === "mixed" || verdict === "worse")) {
    verdict = (result.improved ?? []).length ? "better" : "same";
    notes = `${notes}${notes ? " " : ""}Verdict revised after a second look: ${unconfirmed.length} reported regression(s) could not be confirmed.`;
  }
  return { ...result, verdict, notes, regressed, regressed_detail: detail, unconfirmed_regressions: unconfirmed };
}

/**
 * The pages a --fail-on mode trips on. "measured" fails only on a confirmed
 * regression backed by a measured fact, "regressed" on any confirmed regression,
 * "worse" on a worse verdict. Pure, so a CI gate is predictable.
 */
export function gateHits(results, mode) {
  if (!mode) return [];
  return (results ?? []).filter((r) => {
    if (mode === "worse") return r.verdict === "worse";
    if (mode === "measured") return (r.regressed_detail ?? []).some((d) => d.kind === "measured");
    return (r.regressed ?? []).length > 0;
  });
}

/**
 * The pairs still to compare: after shots that have a before counterpart and are
 * not in the checkpoint yet. Pure, so a resumed run is predictable and testable.
 */
export function pendingPairs(afterShots, beforeShots, doneResults = []) {
  const key = (s) => `${s.route}::${s.viewport}`;
  const beforeByKey = new Map(beforeShots.map((s) => [key(s), s]));
  const done = new Set(doneResults.map(key));
  const pairs = [];
  for (const a of afterShots) {
    const b = beforeByKey.get(key(a));
    if (b && !done.has(key(a))) pairs.push({ a, b });
  }
  return pairs;
}

async function readManifest(dir) {
  const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  m.dir = m.dir ?? dir;
  return m;
}

async function readAudit(shot) {
  if (!shot?.audit) return null;
  try {
    return JSON.parse(await readFile(shot.audit, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Compares two capture sets page by page and viewport by viewport (before and
 * after), asking for what improved, what regressed and what is still open, so a
 * round of changes is verified visually rather than assumed. Measured facts for
 * both sides travel with the screenshots when they exist. The rules, brief and
 * extra context are the cached prefix. Writes compare.json and compare.md into the
 * after directory.
 */
export async function compare({ before, after, config }) {
  requireBrief(config);
  const [mb, ma] = await Promise.all([readManifest(before), readManifest(after)]);
  const client = createClient(config, {
    ledgerPath: path.join(config.out, config.ledger),
    runLabel: `compare:${mb.label}->${ma.label}`,
  });
  const extra = await contextSections(config);
  const decisions = await loadDecisions(config);
  const prefix = [text(preamble(config.disciplines, config.principles)), text(briefSection(config.briefText))];
  if (decisions.length) prefix.push(text(decisionsSection(decisions) + "\nDo not list a settled decision as regressed or still open."));
  if (extra) prefix.push(text(extra));
  const confirm = config.compare?.confirmRegressions !== false;
  const cached = await client.ensureCache(prefix, `ui-critic compare ${ma.label}`);
  // Every finished pair is checkpointed, so a run cut short (a timeout, a lost
  // connection) resumes where it stopped instead of paying for the same pairs
  // again. The checkpoint belongs to one capture: a recapture invalidates it.
  const partialPath = path.join(after, "compare.partial.json");
  let done = [];
  try {
    const partial = JSON.parse(await readFile(partialPath, "utf8"));
    if (partial.afterCapturedAt === ma.capturedAt) done = partial.results ?? [];
  } catch {
    // no checkpoint
  }
  const pending = pendingPairs(ma.shots, mb.shots, done);
  if (done.length) process.stderr.write(`  resuming: ${done.length} pairs already compared, ${pending.length} to go
`);
  const results = [...done];
  const checkpoint = serialWriter(() => writeFile(partialPath, JSON.stringify({ afterCapturedAt: ma.capturedAt, results }, null, 2)));
  try {
    const compared = await runPool(pending, config.concurrency ?? 1, async ({ a, b }) => {
      const pairParts = [
        text("BEFORE, above the fold"),
        await imagePart(b.fold),
        text("BEFORE, full page"),
        await imagePart(b.full),
        text("AFTER, above the fold"),
        await imagePart(a.fold),
        text("AFTER, full page"),
        await imagePart(a.full),
      ];
      const [auditBefore, auditAfter] = await Promise.all([readAudit(b), readAudit(a)]);
      if (auditBefore) pairParts.push(text(`Measured facts BEFORE (JSON): ${auditForPrompt(auditBefore, 2500)}`));
      if (auditAfter) pairParts.push(text(`Measured facts AFTER (JSON): ${auditForPrompt(auditAfter, 2500)}`));

      const parts = cached ? [] : [...prefix];
      parts.push(
        text(
          `## Task\nCompare the page ${a.route} at ${a.viewport} before and after a round of changes. Only report differences you can actually see or measure; identical captures are "same". Cite the element for every point.`,
        ),
        ...pairParts,
      );
      const { data } = await client.generateJSON({ parts, schema: COMPARISON, op: `compare:${a.route}@${a.viewport}` });
      let entry = { route: a.route, viewport: a.viewport, ...data, regressed_detail: [], unconfirmed_regressions: [] };

      // A regression is a strong claim, and a single reading of a busy page is not
      // reproducible: every reported regression gets a second, stricter look at the
      // same captures, and only the confirmed ones count.
      if (confirm && (data.regressed ?? []).length) {
        const listed = data.regressed.map((r, i) => `${i + 1}. ${r}`).join("\n");
        const again = cached ? [] : [...prefix];
        again.push(
          text(
            `## Task\nA first review of ${a.route} at ${a.viewport} reported these regressions between BEFORE and AFTER:\n${listed}\n\nLook again at the same captures and measured facts. For each numbered item say whether it is really present in AFTER and really absent or better in BEFORE (confirmed), whether a measured fact proves it (measured) or it rests on visual judgement (judged), and why, citing the capture or the fact. Be strict: a difference you cannot point to is not confirmed.`,
          ),
          ...pairParts,
        );
        const second = await client.generateJSON({ parts: again, schema: ADJUDICATION, op: `confirm:${a.route}@${a.viewport}` });
        entry = mergeAdjudication(entry, second.data);
      }
      results.push(entry);
      const note = entry.unconfirmed_regressions.length ? ` (${entry.unconfirmed_regressions.length} regression(s) not confirmed on a second look)` : "";
      process.stderr.write(`  compared ${a.route} at ${a.viewport}: ${entry.verdict}${note}\n`);
      await checkpoint();
      return entry;
    });
    // Keep the report in the after manifest's order rather than completion order.
    const order = new Map(ma.shots.map((s, i) => [`${s.route}::${s.viewport}`, i]));
    results.splice(0, results.length, ...[...done, ...compared].sort((x, y) => (order.get(`${x.route}::${x.viewport}`) ?? 0) - (order.get(`${y.route}::${y.viewport}`) ?? 0)));
  } finally {
    await client.close();
  }
  const result = {
    tool: "ui-critic",
    model: config.model,
    before: { label: mb.label, base: mb.base, capturedAt: mb.capturedAt },
    after: { label: ma.label, base: ma.base, capturedAt: ma.capturedAt },
    comparedAt: new Date().toISOString(),
    results,
    usage: client.summary(),
  };
  const jsonPath = path.join(after, "compare.json");
  const mdPath = path.join(after, "compare.md");
  await writeFile(jsonPath, JSON.stringify(result, null, 2));
  await writeFile(mdPath, renderCompare(result));
  return { ...result, jsonPath, mdPath };
}
