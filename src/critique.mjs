import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeminiClient, imagePart, text } from "./gemini.mjs";
import { renderCritique } from "./report.mjs";
import { routeSlug, captureMore } from "./capture.mjs";
import { auditForPrompt } from "./audit.mjs";
import { requireBrief, contextSections } from "./brief.mjs";

/**
 * The critic's standing instructions. The disciplines list is spelled out so the
 * review sweeps every craft (type, spacing, dividers, states, motion and the rest)
 * and accounts for each in coverage, instead of fixating on the loudest problem.
 */
export function preamble(disciplines, principles = []) {
  const list = disciplines.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const rules = principles.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return `${PREAMBLE}

Design disciplines to sweep on every page, one by one. For each, either raise a finding or record in coverage that you checked it and it is fine (or not applicable), with a one-line note:
${list}${rules ? `

Interaction principles every screen must satisfy. A violation is a finding; name the principle in the observation. Where a screenshot cannot show it (a pressed state, a loading state, an error state), say so and ask for the measurement or the page state in requests rather than assuming it is fine:
${rules}` : ""}`;
}

export const PREAMBLE = `You are a senior product designer and conversion specialist reviewing a live website from screenshots and measured facts. You are fluent in every craft of interface design: layout, spacing, typography, colour, surfaces and dividers, iconography, component states, motion, copy, accessibility and conversion.

Rules:
- Every finding must cite what you actually see: the screenshot (page and viewport), the element, its text or position. Never invent elements or assume what is off screen.
- Measured facts (fonts, sizes, target sizes, contrast ratios) are ground truth: use them instead of estimating, and do not contradict them.
- Rank by impact on a first-time visitor's ability to understand the offer, trust it and act. Say why each finding matters.
- Recommendations must be specific and testable (sizes, order, wording, placement), never generic advice. Never suggest dark patterns or fake urgency.
- The brief's product purpose, audience, brand and constraints are decisions already made: judge against them, not against a generic store.
- Separate genuine UI defects from placeholder content the brief tells you to ignore, and say which is which.
- If you cannot judge something well from what you were given, ask for it in requests (a page path, a file, a question for the team, a measurement) rather than guessing.
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
    evidence: { type: "STRING", description: "where exactly you see it: screenshot, element, text, position, or the measured fact" },
    recommendation: { type: "STRING", description: "the specific change to make" },
    effort: { type: "STRING", enum: ["small", "medium", "large"] },
    defect_kind: { type: "STRING", enum: ["ui", "placeholder-content", "needs-engineering-judgement"] },
  },
  required: ["page", "viewport", "severity", "category", "observation", "evidence", "recommendation", "effort", "defect_kind"],
};

const COVERAGE = {
  type: "OBJECT",
  properties: {
    discipline: { type: "STRING", description: "the discipline, by its short name from the list" },
    status: { type: "STRING", enum: ["ok", "issue", "not-applicable"] },
    note: { type: "STRING", description: "one line: what you checked and what you saw" },
  },
  required: ["discipline", "status", "note"],
};

const REQUEST = {
  type: "OBJECT",
  properties: {
    kind: { type: "STRING", enum: ["page", "file", "answer", "measurement"] },
    target: { type: "STRING", description: "a page path like /checkout, a file such as the design tokens, a question for the team, or what to measure" },
    why: { type: "STRING", description: "what judgement this would unblock" },
  },
  required: ["kind", "target", "why"],
};

const PAGE = {
  type: "OBJECT",
  properties: {
    page: { type: "STRING" },
    summary: { type: "STRING", description: "two sentences on how this page performs for its job" },
    score: { type: "INTEGER" },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    findings: { type: "ARRAY", items: FINDING },
    coverage: { type: "ARRAY", items: COVERAGE, description: "one entry per design discipline in the list, in order" },
    requests: { type: "ARRAY", items: REQUEST, description: "what else you need to judge this page better; empty if nothing" },
  },
  required: ["page", "summary", "score", "strengths", "findings", "coverage", "requests"],
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
    requests: { type: "ARRAY", items: REQUEST, description: "what else you need to judge the site better; empty if nothing" },
  },
  required: ["verdict", "score", "revamp_needed", "consistency_findings", "top_priorities", "requests"],
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
  return `## Brief from the product team\n${brief.trim()}`;
}

/** Deduplicates requests across pages by kind and target, keeping the first reason. */
export function mergeRequests(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const r of list ?? []) {
      const key = `${r.kind}:${(r.target ?? "").trim().toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, { ...r, target: (r.target ?? "").trim() });
    }
  }
  return Array.from(seen.values());
}

/**
 * The page requests the tool can fulfil on its own: same-origin paths not already
 * captured, capped. Anything else (files, answers, measurements, other origins)
 * is left for the human or agent.
 */
export function followablePages(requests, manifest, maxPages) {
  const have = new Set(manifest.shots.map((s) => s.path ?? s.route));
  const out = [];
  for (const r of requests) {
    if (r.kind !== "page") continue;
    let route = r.target;
    try {
      if (/^https?:\/\//i.test(route)) {
        const u = new URL(route);
        if (u.origin !== new URL(manifest.base).origin) continue;
        route = u.pathname + u.search;
      }
    } catch {
      continue;
    }
    if (!route.startsWith("/")) route = "/" + route;
    if (have.has(route) || out.includes(route)) continue;
    out.push(route);
    if (out.length >= maxPages) break;
  }
  return out;
}

async function readAudit(shot) {
  if (!shot.audit) return null;
  try {
    return JSON.parse(await readFile(shot.audit, "utf8"));
  } catch {
    return null;
  }
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
 * Reviews one capture set. The brief is mandatory: the critic judges against the
 * product's purpose and audience, never against a generic store. The stable prefix
 * (rules, brief, extra context, and every page's first screen labelled by page and
 * viewport) goes into an explicit context cache when possible, so each page pass
 * only adds that page's full-page captures, its measured facts and its task, and
 * the site pass adds only its task. Without a cache the same prefix is sent inline,
 * in the same order, so implicit prefix caching still applies.
 *
 * The critic may ask for more (pages, files, answers, measurements). Page requests
 * for the same origin are fulfilled automatically when followRequests is on:
 * captured, reviewed and added to the report, within maxPages. The rest are listed
 * in the report for the human or agent to answer in the answers file before a
 * rerun.
 *
 * Every finished page is checkpointed to critique.partial.json, and a rerun on the
 * same capture resumes from it. If the site pass fails, the per-page results are
 * still written before the error is raised, so paid-for work is never lost.
 */
export async function critique({ dir, config }) {
  requireBrief(config);
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  manifest.dir = manifest.dir ?? dir;
  const client = new GeminiClient({
    model: config.model,
    thinking: config.thinking,
    generation: config.generation,
    cache: config.cache,
    pricing: config.pricing,
    ledgerPath: path.join(config.out, config.ledger),
    runLabel: `critique:${manifest.label}`,
  });

  const extra = await contextSections(config);
  const prefix = [text(preamble(config.disciplines, config.principles)), text(briefSection(config.briefText))];
  if (extra) prefix.push(text(extra));
  for (const s of manifest.shots) {
    prefix.push(text(`Screenshot: ${s.route} at ${s.viewport}, above the fold (${s.title})`), await imagePart(s.fold));
  }
  const cached = await client.ensureCache(prefix, `ui-critic ${manifest.label}`);
  const thoughtLog = [];
  const done = await loadPartial(dir, manifest, config.model);
  const partialPath = path.join(dir, PARTIAL_FILE);
  const checkpoint = () =>
    writeFile(partialPath, JSON.stringify({ capturedAt: manifest.capturedAt, model: config.model, pages: done }, null, 2));

  const reviewPage = async (route, shots, inPrefix) => {
    const parts = inPrefix ? [] : [...prefix];
    if (!inPrefix) {
      for (const s of shots) parts.push(text(`Screenshot: ${route} at ${s.viewport}, above the fold (${s.title})`), await imagePart(s.fold));
    }
    parts.push(
      text(
        `## Task\nReview ${shots[0].scenario ? `the state "${shots[0].scenario}" of the page ${shots[0].path}` : `the page ${route}`} ("${shots[0].title}")${shots[0].scenario ? `, captured after these steps: ${(shots[0].steps ?? []).join("; ") || "none"}${shots[0].stepError ? ` (a step failed: ${shots[0].stepError})` : ""}. Judge the state the interaction produced: the feedback, the affordance, what changed and whether it is clear` : ""}${shots[0].auth ? ". The visitor is signed in." : ""}. You already have its above-the-fold capture per viewport; here is the full-page capture per viewport (the whole scroll) and the measured facts. Name the page's real strengths first, then list findings, then account for every design discipline in coverage, then anything you still need in requests. Set page to "${route}".`,
      ),
    );
    for (const s of shots) {
      parts.push(text(`Screenshot: ${route} at ${s.viewport}, full page`), await imagePart(s.full));
      const audit = await readAudit(s);
      if (audit) parts.push(text(`Measured facts for ${route} at ${s.viewport} (JSON): ${auditForPrompt(audit)}`));
    }
    const { data, thoughts } = await client.generateJSON({ parts, schema: PAGE, op: `page:${route}` });
    const slug = routeSlug(route);
    data.findings = (data.findings ?? []).map((f, i) => ({ id: `${slug}-${i + 1}`, ...f, page: route }));
    data.requests = data.requests ?? [];
    data.coverage = data.coverage ?? [];
    const page = { route, ...data, audits: {} };
    for (const s of shots) {
      const audit = await readAudit(s);
      if (audit) page.audits[s.viewport] = audit;
    }
    if (thoughts) thoughtLog.push(`## ${route}\n\n${thoughts}`);
    process.stderr.write(`  reviewed ${route}: score ${data.score}, ${data.findings.length} findings, ${data.requests.length} requests\n`);
    return page;
  };

  try {
    const pages = [];
    for (const [route, shots] of groupByRoute(manifest.shots)) {
      if (done[route]) {
        pages.push(done[route]);
        process.stderr.write(`  reused ${route} from checkpoint: score ${done[route].score}, ${done[route].findings.length} findings\n`);
        continue;
      }
      const page = await reviewPage(route, shots, Boolean(cached));
      pages.push(page);
      done[route] = page;
      await checkpoint();
    }

    // The critic's page requests, fulfilled where the tool can: same origin, capped.
    let followed = { routes: [], skipped: null };
    const follow = config.followRequests ?? {};
    if (follow.enabled) {
      const wanted = followablePages(mergeRequests(pages.map((p) => p.requests)), manifest, follow.maxPages ?? 3);
      if (wanted.length) {
        process.stderr.write(`  the critic asked for ${wanted.join(", ")}; capturing\n`);
        const more = await captureMore(manifest, wanted);
        followed = { routes: wanted, skipped: more.skipped };
        for (const [route, shots] of groupByRoute(more.shots)) {
          // These first screens are not in the cache, so they travel with the call.
          const page = await reviewPage(route, shots, false);
          pages.push(page);
          done[route] = page;
          await checkpoint();
        }
      }
    }

    const seen = pages
      .flatMap((p) => p.findings.map((f) => `[${p.route}] ${f.observation}`))
      .slice(0, 60)
      .join(" | ");
    const parts = cached ? [] : [...prefix];
    parts.push(
      text(
        `## Task\nUsing the first screen of every page at every viewport, judge the whole site: consistency of type scale, spacing rhythm, components and tone across pages; whether a redesign is warranted or targeted fixes suffice (revamp_needed); and the five changes with the highest impact for the least effort across the site. Keep consistency_findings to genuine cross-page patterns (at most six) and do not repeat per-page findings. List anything you still need in requests. Per-page findings already recorded: ${seen}`,
      ),
    );

    let overall;
    let siteError = null;
    try {
      const site = await client.generateJSON({ parts, schema: OVERALL, op: "site" });
      overall = site.data;
      overall.consistency_findings = (overall.consistency_findings ?? []).map((f, i) => ({ id: `site-${i + 1}`, ...f }));
      overall.requests = overall.requests ?? [];
      if (site.thoughts) thoughtLog.push(`## site\n\n${site.thoughts}`);
    } catch (err) {
      siteError = err.message;
      overall = {
        verdict: `site pass failed (${err.message}); per-page results below are complete`,
        score: null,
        revamp_needed: null,
        consistency_findings: [],
        top_priorities: [],
        requests: [],
      };
    }

    const requests = mergeRequests([...pages.map((p) => p.requests), overall.requests]);
    const result = {
      tool: "ui-critic",
      model: config.model,
      label: manifest.label,
      base: manifest.base,
      reviewedAt: new Date().toISOString(),
      overall,
      pages,
      requests,
      followed,
      skipped: manifest.skipped ?? [],
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
