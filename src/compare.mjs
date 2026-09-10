import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeminiClient, imagePart, text } from "./gemini.mjs";
import { preamble, briefSection } from "./critique.mjs";
import { renderCompare } from "./report.mjs";
import { auditForPrompt } from "./audit.mjs";
import { requireBrief, contextSections } from "./brief.mjs";

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
  const client = new GeminiClient({
    model: config.model,
    thinking: config.thinking,
    generation: config.generation,
    cache: config.cache,
    pricing: config.pricing,
    ledgerPath: path.join(config.out, config.ledger),
    runLabel: `compare:${mb.label}->${ma.label}`,
  });
  const extra = await contextSections(config);
  const prefix = [text(preamble(config.disciplines)), text(briefSection(config.briefText))];
  if (extra) prefix.push(text(extra));
  const cached = await client.ensureCache(prefix, `ui-critic compare ${ma.label}`);
  const key = (s) => `${s.route}::${s.viewport}`;
  const beforeByKey = new Map(mb.shots.map((s) => [key(s), s]));
  const results = [];
  try {
    for (const a of ma.shots) {
      const b = beforeByKey.get(key(a));
      if (!b) continue;
      const parts = cached ? [] : [...prefix];
      parts.push(
        text(
          `## Task\nCompare the page ${a.route} at ${a.viewport} before and after a round of changes. Only report differences you can actually see or measure; identical captures are "same". Cite the element for every point.`,
        ),
        text("BEFORE, above the fold"),
        await imagePart(b.fold),
        text("BEFORE, full page"),
        await imagePart(b.full),
        text("AFTER, above the fold"),
        await imagePart(a.fold),
        text("AFTER, full page"),
        await imagePart(a.full),
      );
      const [auditBefore, auditAfter] = await Promise.all([readAudit(b), readAudit(a)]);
      if (auditBefore) parts.push(text(`Measured facts BEFORE (JSON): ${auditForPrompt(auditBefore, 2500)}`));
      if (auditAfter) parts.push(text(`Measured facts AFTER (JSON): ${auditForPrompt(auditAfter, 2500)}`));
      const { data } = await client.generateJSON({ parts, schema: COMPARISON, op: `compare:${a.route}@${a.viewport}` });
      results.push({ route: a.route, viewport: a.viewport, ...data });
      process.stderr.write(`  compared ${a.route} at ${a.viewport}: ${data.verdict}\n`);
    }
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
