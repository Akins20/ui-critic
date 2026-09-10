import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeminiClient, imagePart, text } from "./gemini.mjs";
import { renderCritique } from "./report.mjs";
import { routeSlug } from "./capture.mjs";

export const PREAMBLE = `You are a senior product designer and conversion specialist reviewing a live website from screenshots.

Rules:
- Every finding must cite what you actually see: the screenshot (page and viewport), the element, its text or position. Never invent elements or assume what is off screen.
- Rank by impact on a first-time visitor's ability to understand the offer, trust it and act. Say why each finding matters.
- Recommendations must be specific and testable (sizes, order, wording, placement), never generic advice. Never suggest dark patterns or fake urgency.
- The brief's brand, audience and constraints are decisions already made: work within them.
- Separate genuine UI defects from placeholder content the brief tells you to ignore, and say which is which.
- Scores are 0 to 100 against what a strong competitor in the same market ships today: 50 is average, 80 is excellent.`;

const FINDING = {
  type: "OBJECT",
  properties: {
    page: { type: "STRING", description: "route of the page, e.g. / or /shop" },
    viewport: { type: "STRING", enum: ["desktop", "mobile", "both"] },
    severity: { type: "STRING", enum: ["high", "medium", "low"] },
    category: {
      type: "STRING",
      enum: [
        "hierarchy",
        "typography",
        "color",
        "spacing",
        "imagery",
        "copy",
        "navigation",
        "conversion",
        "trust",
        "accessibility",
        "consistency",
        "motion",
      ],
    },
    observation: { type: "STRING", description: "what is wrong, in one sentence" },
    evidence: { type: "STRING", description: "where exactly you see it: screenshot, element, text, position" },
    recommendation: { type: "STRING", description: "the specific change to make" },
    effort: { type: "STRING", enum: ["small", "medium", "large"] },
    defect_kind: { type: "STRING", enum: ["ui", "placeholder-content", "needs-engineering-judgement"] },
  },
  required: ["page", "viewport", "severity", "category", "observation", "evidence", "recommendation", "effort", "defect_kind"],
};

const PAGE = {
  type: "OBJECT",
  properties: {
    page: { type: "STRING" },
    summary: { type: "STRING", description: "two sentences on how this page performs for its job" },
    score: { type: "INTEGER" },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    findings: { type: "ARRAY", items: FINDING },
  },
  required: ["page", "summary", "score", "strengths", "findings"],
};

const OVERALL = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", description: "three sentences: what works, what does not, what to do" },
    score: { type: "INTEGER" },
    revamp_needed: { type: "BOOLEAN", description: "true only if targeted fixes cannot get this UI to competitive" },
    consistency_findings: { type: "ARRAY", items: FINDING },
    top_priorities: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "the five changes with the highest impact for the least effort, most valuable first",
    },
  },
  required: ["verdict", "score", "revamp_needed", "consistency_findings", "top_priorities"],
};

const PARTIAL_FILE = "critique.partial.json";

function groupByRoute(shots) {
  const map = new Map();
  for (const s of shots) {
    if (!map.has(s.route)) map.set(s.route, []);
    map.get(s.route).push(s);
  }
  return map;
}

export function briefSection(brief) {
  return `## Brief from the product team\n${brief?.trim() || "(no brief supplied; judge against general e-commerce best practice)"}`;
}

/**
 * Loads the per-page results a previous, interrupted run checkpointed for this
 * exact capture (same capturedAt and model), so a rerun pays only for what is
 * missing. Anything else is ignored.
 */
async function loadPartial(dir, manifest, model) {
  try {
    const partial = JSON.parse(await readFile(path.join(dir, PARTIAL_FILE), "utf8"));
    if (partial.capturedAt !== manifest.capturedAt || partial.model !== model) return {};
    return partial.pages ?? {};
  } catch {
    return {};
  }
}

/**
 * Reviews one capture set. The stable prefix (rules, brief, and every page's first
 * screen labelled by page and viewport) goes into an explicit context cache when
 * possible, so each page pass only adds that page's full-page captures and its task,
 * and the site pass adds only its task. Without a cache the same prefix is sent
 * inline, in the same order, so implicit prefix caching still applies.
 *
 * Every finished page is checkpointed to critique.partial.json, and a rerun on the
 * same capture resumes from it. If the site pass fails, the per-page results are
 * still written (critique.json with the failure recorded) before the error is
 * raised, so paid-for work is never lost. Writes critique.json, critique.md and, when
 * thoughts are kept, thoughts.md next to the screenshots.
 */
export async function critique({ dir, config }) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const client = new GeminiClient({
    model: config.model,
    thinking: config.thinking,
    generation: config.generation,
    cache: config.cache,
    pricing: config.pricing,
    ledgerPath: path.join(config.out, config.ledger),
    runLabel: `critique:${manifest.label}`,
  });

  const prefix = [text(PREAMBLE), text(briefSection(config.briefText))];
  for (const s of manifest.shots) {
    prefix.push(text(`Screenshot: ${s.route} at ${s.viewport}, above the fold (${s.title})`), await imagePart(s.fold));
  }
  const cached = await client.ensureCache(prefix, `ui-critic ${manifest.label}`);
  const thoughtLog = [];
  const done = await loadPartial(dir, manifest, config.model);
  const partialPath = path.join(dir, PARTIAL_FILE);
  const checkpoint = () =>
    writeFile(partialPath, JSON.stringify({ capturedAt: manifest.capturedAt, model: config.model, pages: done }, null, 2));

  try {
    const pages = [];
    for (const [route, shots] of groupByRoute(manifest.shots)) {
      if (done[route]) {
        pages.push(done[route]);
        process.stderr.write(`  reused ${route} from checkpoint: score ${done[route].score}, ${done[route].findings.length} findings\n`);
        continue;
      }
      const parts = cached ? [] : [...prefix];
      parts.push(
        text(
          `## Task\nReview the page ${route} ("${shots[0].title}"). You already have its above-the-fold capture per viewport; here is the full-page capture per viewport (the whole scroll). Name the page's real strengths first, then list findings. Set page to "${route}".`,
        ),
      );
      for (const s of shots) parts.push(text(`Screenshot: ${route} at ${s.viewport}, full page`), await imagePart(s.full));
      const { data, thoughts } = await client.generateJSON({ parts, schema: PAGE, op: `page:${route}` });
      const slug = routeSlug(route);
      data.findings = (data.findings ?? []).map((f, i) => ({ id: `${slug}-${i + 1}`, ...f, page: route }));
      const page = { route, ...data };
      pages.push(page);
      done[route] = page;
      await checkpoint();
      if (thoughts) thoughtLog.push(`## ${route}\n\n${thoughts}`);
      process.stderr.write(`  reviewed ${route}: score ${data.score}, ${data.findings.length} findings\n`);
    }

    const seen = pages
      .flatMap((p) => p.findings.map((f) => `[${p.route}] ${f.observation}`))
      .slice(0, 60)
      .join(" | ");
    const parts = cached ? [] : [...prefix];
    parts.push(
      text(
        `## Task\nUsing the first screen of every page at every viewport, judge the whole site: consistency of type scale, spacing rhythm, components and tone across pages; whether a redesign is warranted or targeted fixes suffice (revamp_needed); and the five changes with the highest impact for the least effort across the site. Keep consistency_findings to genuine cross-page patterns (at most six) and do not repeat per-page findings. Per-page findings already recorded: ${seen}`,
      ),
    );

    let overall;
    let siteError = null;
    try {
      const site = await client.generateJSON({ parts, schema: OVERALL, op: "site" });
      overall = site.data;
      overall.consistency_findings = (overall.consistency_findings ?? []).map((f, i) => ({ id: `site-${i + 1}`, ...f }));
      if (site.thoughts) thoughtLog.push(`## site\n\n${site.thoughts}`);
    } catch (err) {
      siteError = err.message;
      overall = {
        verdict: `site pass failed (${err.message}); per-page results below are complete`,
        score: null,
        revamp_needed: null,
        consistency_findings: [],
        top_priorities: [],
      };
    }

    const result = {
      tool: "ui-critic",
      model: config.model,
      label: manifest.label,
      base: manifest.base,
      reviewedAt: new Date().toISOString(),
      overall,
      pages,
      usage: client.summary(),
      ...(siteError ? { error: siteError } : {}),
    };
    const jsonPath = path.join(dir, "critique.json");
    const mdPath = path.join(dir, "critique.md");
    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    await writeFile(mdPath, renderCritique(result));
    if (thoughtLog.length) await writeFile(path.join(dir, "thoughts.md"), thoughtLog.join("\n\n") + "\n");
    if (siteError) throw new Error(`site pass failed: ${siteError} (per-page results were written to ${jsonPath}; rerun to retry the site pass)`);
    return { ...result, jsonPath, mdPath };
  } finally {
    await client.close();
  }
}
