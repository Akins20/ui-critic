import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imagePart, text } from "./parts.mjs";
import { createClient } from "./provider.mjs";
import { renderCritique } from "./report.mjs";
import { routeSlug, captureMore } from "./capture.mjs";
import { auditForPrompt } from "./audit.mjs";
import { requireBrief, contextSections } from "./brief.mjs";
import { loadDecisions, decisionsSection, withholdSettled } from "./decisions.mjs";
import { readEnvFile } from "./steps.mjs";
import { runPool, serialWriter } from "./pool.mjs";
import { nouns, isNative, detailImages } from "./shots.mjs";
import { DEFAULT_DISCIPLINES, NATIVE_DISCIPLINES } from "./config.mjs";
import { renderCritiqueHTML } from "./html.mjs";
import { lintCapture, renderLint, lintForPrompt } from "./lint.mjs";

/**
 * The critic's standing instructions. The disciplines list is spelled out so the
 * review sweeps every craft (type, spacing, dividers, states, motion and the rest)
 * and accounts for each in coverage, instead of fixating on the loudest problem.
 */
export function preamble(disciplines, principles = [], platform = "web") {
  const list = disciplines.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const rules = principles.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const { item } = nouns(platform);
  return `${rulesFor(platform)}

Design disciplines to sweep on every ${item}, one by one. For each, either raise a finding or record in coverage that you checked it and it is fine (or not applicable), with a one-line note:
${list}${rules ? `

Interaction principles every screen must satisfy. A violation is a finding; name the principle in the observation. Where a screenshot cannot show it (a pressed state, a loading state, an error state), say so and ask for the measurement or the ${item} state in requests rather than assuming it is fine:
${rules}` : ""}`;
}

const SUBJECT = {
  web: "a live website",
  android: "a native Android app",
  ios: "a native iOS app",
  images: "a product's screens",
};

/**
 * The rule about runtime facts, per platform: on the web the browser reports
 * console errors and layout shift; an app's log is noisier, so its error lines are
 * weaker evidence than a crash.
 */
const RUNTIME_RULE = {
  web: "- Runtime facts in the measured data (console errors, failed requests, HTTP errors, cumulative layout shift) are defects a screenshot cannot show: report each as a finding with the exact message or URL, and treat a layout shift above 0.1 as a real problem.\n- Interaction facts were measured by hovering each control and walking the page with Tab: a keyboard stop without visible focus fails WCAG 2.4.7, focus on an invisible element or jumping back up the page breaks keyboard use (WCAG 2.4.3), a missing skip link costs keyboard users every header link on every page, and a control with no hover change on a desktop breaks the feedback principle. Report them naming the controls listed.",
  android:
    "- Runtime facts in the measured data: a crash, an ANR, or the app no longer in the foreground is a defect to report with the exact message. Error log lines are weaker evidence (an app's log carries framework noise, and errors seen on every launch are listed once for the run, not per screen): report them when they plausibly explain something visible or point at a real fault. Frame timing appears only from a physical device; a janky-frame share above ten percent while scrolling is worth reporting.",
  ios: "- Runtime facts, when present, are defects a screenshot cannot show: report each with the exact message.",
  images: "- There are no runtime facts for supplied screenshots; do not guess at loading behaviour or errors you cannot see.",
};

/** Platform conventions the critic judges against where the brief is silent. */
const PLATFORM_RULE = {
  web: "",
  android:
    "\n- This is an Android app: judge it against Android conventions (Material Design top app bars, back behaviour, bottom navigation, touch targets of at least 48dp, system bars and edge-to-edge insets) wherever the brief does not decide otherwise. Measured sizes are in dp and are each element's bounds: a touch area enlarged beyond the bounds (React Native hitSlop, an Android TouchDelegate) cannot be seen in them, so present a small target as likely rather than certain, and recommend checking for an enlarged touch area before resizing the visual. An unlabelled control is one a screen reader announces without a name. Contrast is measured from the screenshot's pixels, so treat a ratio as close, not exact; samples drawn over a busy background or under a floating bar are counted, not measured. The scroll status says only how far the capture went, never that content is hidden.",
  ios: "\n- This is an iOS app: judge it against Apple's Human Interface Guidelines (navigation and tab bars, touch targets of at least 44pt, safe areas, Dynamic Type) wherever the brief does not decide otherwise.",
  images: "\n- These are screenshots the team supplied, not a live capture: measured facts are few, so judge from the pixels and ask in requests for anything you cannot see.",
};

/** The critic's standing rules for a platform; the web wording is the original one. */
export function rulesFor(platform = "web") {
  const p = SUBJECT[platform] ? platform : "web";
  const { item } = nouns(p);
  return `You are a senior product designer and conversion specialist reviewing ${SUBJECT[p]} from screenshots and measured facts. You are fluent in every craft of interface design: layout, spacing, typography, colour, surfaces and dividers, iconography, component states, motion, copy, accessibility and conversion.

Rules:
- Every finding must cite what you actually see: the screenshot (${item} and viewport), the element, its text or position. Never invent elements or assume what is off screen.
- Measured facts (fonts, sizes, target sizes, contrast ratios) are ground truth: use them instead of estimating, and do not contradict them.
- Rank by impact on a first-time visitor's ability to understand the offer, trust it and act. Say why each finding matters.
- Recommendations must be specific and testable (sizes, order, wording, placement), never generic advice. Never suggest dark patterns or fake urgency.
- The brief's product purpose, audience, brand and constraints are decisions already made: judge against them, not against a generic store.
- Separate genuine UI defects from placeholder content the brief tells you to ignore, and say which is which.
- If you cannot judge something well from what you were given, ask for it in requests (${isNative(p) ? "a screen and how to reach it" : "a page path"}, a file, a question for the team, a measurement) rather than guessing.
${RUNTIME_RULE[p]}${PLATFORM_RULE[p]}
- Scores are 0 to 100 against what a strong competitor in the same market ships today: 50 is average, 80 is excellent.`;
}

export const PREAMBLE = rulesFor("web");

/**
 * The viewport values a finding may name: every viewport the capture used, plus
 * "all" when there are several. Built from the capture rather than fixed, so a
 * phone-only review, or one with a tablet beside the phone, labels its findings
 * with the names it was configured with instead of a forced desktop or mobile.
 */
export function viewportChoices(names) {
  const unique = Array.from(new Set((names ?? []).filter((n) => typeof n === "string" && n)));
  if (unique.length === 0) return ["all"];
  return unique.length > 1 ? [...unique, "all"] : unique;
}

/** The viewport names of a capture: its manifest's viewports, else the ones its shots name. */
export function manifestViewports(manifest) {
  const named = Object.keys(manifest?.viewports ?? {});
  return named.length ? named : Array.from(new Set((manifest?.shots ?? []).map((s) => s.viewport)));
}

/**
 * The images a finding can point at: "first" (the first-screen capture), "full"
 * (a web page's full-page capture), or "frame2" and on (an app screen's scroll
 * frames), as many as the capture has.
 */
export function imageChoices(manifest) {
  const most = Math.max(1, ...(manifest?.shots ?? []).map((s) => (Array.isArray(s.frames) ? s.frames.length : 1)));
  const hasFull = (manifest?.shots ?? []).some((s) => s.full && !s.frames);
  const out = ["first"];
  if (hasFull) out.push("full");
  for (let i = 2; i <= most; i += 1) out.push(`frame${i}`);
  return out;
}

/**
 * A finding's region as the report can use it: a known viewport and image and a box
 * of four numbers from 0 to 1000 with its corners in order, or no box at all. The
 * schema cannot say "four numbers in range", so the check is here.
 */
export function normalizeRegion(region, viewports, images) {
  if (!region || typeof region !== "object") return null;
  const viewport = viewports.includes(region.viewport) ? region.viewport : (viewports[0] ?? null);
  const image = images.includes(region.image) ? region.image : "first";
  const b = Array.isArray(region.box) ? region.box.map(Number) : [];
  const ok = b.length === 4 && b.every((v) => Number.isFinite(v) && v >= 0 && v <= 1000) && b[2] > b[0] && b[3] > b[1];
  return { viewport, image, box: ok ? b : null };
}

const regionSchema = (viewports, images) => ({
  type: "OBJECT",
  description: "where a reader should look: the viewport and image the finding is clearest on, and a box around it",
  properties: {
    viewport: { type: "STRING", enum: Array.from(new Set(viewports.filter(Boolean))).length ? Array.from(new Set(viewports.filter(Boolean))) : ["default"] },
    image: { type: "STRING", enum: images, description: "first is the first-screen capture, full the full-page capture, frame2 and on the scroll frames" },
    box: {
      type: "ARRAY",
      items: { type: "INTEGER" },
      description: "[ymin, xmin, ymax, xmax] around the element on that image, each from 0 to 1000; empty when the finding is not in one place",
    },
  },
  required: ["viewport", "image", "box"],
});

const findingSchema = (viewports, images = ["first"], routes = null) => ({
  type: "OBJECT",
  properties: {
    // The page as the screenshot labels name it. Where the routes are known the
    // choice is closed, so a finding cannot point at a page that was never captured.
    page: routes?.length
      ? { type: "STRING", enum: routes, description: "the page or screen, exactly as the screenshot labels name it" }
      : { type: "STRING", description: "the page or screen, exactly as the screenshot labels name it" },
    viewport: {
      type: "STRING",
      enum: viewportChoices(viewports),
      description: "the viewport the finding was seen at, by the name used in the screenshot labels, or all when it applies to every viewport",
    },
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
    conflicts_with_decision: {
      type: "STRING",
      description: "the settled decision this finding would reopen, quoted from the settled decisions list, or an empty string when it reopens none",
    },
    region: regionSchema(viewports, images),
  },
  required: ["page", "viewport", "severity", "category", "observation", "evidence", "recommendation", "effort", "defect_kind", "conflicts_with_decision", "region"],
});

const COVERAGE = {
  type: "OBJECT",
  properties: {
    discipline: { type: "STRING", description: "the discipline, by its short name from the list" },
    status: { type: "STRING", enum: ["ok", "issue", "not-applicable"] },
    note: { type: "STRING", description: "one line: what you checked and what you saw" },
  },
  required: ["discipline", "status", "note"],
};

const requestSchema = (platform) => ({
  type: "OBJECT",
  properties: {
    kind: { type: "STRING", enum: ["page", "file", "answer", "measurement"] },
    target: {
      type: "STRING",
      description: isNative(platform)
        ? "a screen (its deep link, or the taps that reach it), a file such as the design tokens, a question for the team, or what to measure"
        : "a page path like /checkout, a file such as the design tokens, a question for the team, or what to measure",
    },
    why: { type: "STRING", description: "what judgement this would unblock" },
  },
  required: ["kind", "target", "why"],
});

/** The schema of one page review, for a capture with the given viewport names and images. */
export const pageSchema = (viewports, platform = "web", images = ["first", "full"]) => ({
  type: "OBJECT",
  properties: {
    page: { type: "STRING" },
    summary: { type: "STRING", description: `two sentences on how this ${nouns(platform).item} performs for its job` },
    score: { type: "INTEGER" },
    strengths: { type: "ARRAY", items: { type: "STRING" } },
    findings: { type: "ARRAY", items: findingSchema(viewports, images) },
    coverage: { type: "ARRAY", items: COVERAGE, description: "one entry per design discipline in the list, in order" },
    requests: { type: "ARRAY", items: requestSchema(platform), description: `what else you need to judge this ${nouns(platform).item} better; empty if nothing` },
  },
  required: ["page", "summary", "score", "strengths", "findings", "coverage", "requests"],
});

/** The schema of the site-level review, for a capture with the given viewport names and routes. */
export const overallSchema = (viewports, platform = "web", routes = null) => ({
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", description: "three sentences: what works, what does not, what to do" },
    score: { type: "INTEGER" },
    revamp_needed: { type: "BOOLEAN", description: "true only if targeted fixes cannot get this UI to competitive" },
    // The site pass sees first screens only, so its findings point at those.
    consistency_findings: { type: "ARRAY", items: findingSchema(viewports, ["first"], routes) },
    top_priorities: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "the five changes with the highest impact for the least effort, most valuable first",
    },
    requests: { type: "ARRAY", items: requestSchema(platform), description: `what else you need to judge the ${nouns(platform).whole} better; empty if nothing` },
  },
  required: ["verdict", "score", "revamp_needed", "consistency_findings", "top_priorities", "requests"],
});

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
  // An app screen has no address to open, so its requests go to the human or agent.
  if (isNative(manifest.platform)) return [];
  const have = new Set(manifest.shots.map((s) => s.path ?? s.route));
  const out = [];
  for (const r of requests) {
    if (r.kind !== "page") continue;
    // A page request is a path or URL; anything after the first space is commentary.
    let route = String(r.target ?? "").trim().split(/\s+/)[0];
    if (!route) continue;
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

/**
 * What each accessibility or theme variant among the viewports tests, so the critic
 * judges a 200% zoom capture for overlap and cut-off content rather than for its
 * larger type, and says which variant a finding comes from.
 */
export function variantNotes(viewports = {}) {
  const lines = [];
  for (const [name, vp] of Object.entries(viewports)) {
    const what = [];
    if (vp.zoom > 1) what.push(`browser zoom at ${Math.round(vp.zoom * 100)}% (WCAG 1.4.4: everything must still work, with nothing overlapping or cut off)`);
    if (vp.width > 0 && vp.width <= 320) what.push("a 320px-wide screen (WCAG 1.4.10 reflow: text content must not need sideways scrolling)");
    if (vp.textSpacing) what.push("text spacing raised to WCAG 1.4.12's limits (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em): no text may be cut off or overlap");
    if (vp.forcedColors) what.push("Windows high-contrast mode: icons, borders and focus indicators must survive and nothing may disappear");
    if (vp.vision) what.push(`a simulation of ${vp.vision}: information carried by colour alone is lost, so it needs a second cue`);
    if (vp.colorScheme === "dark") what.push("the dark colour scheme");
    if (vp.night) what.push("the dark theme");
    if (vp.fontScale && vp.fontScale !== 1) what.push(`the system font at ${vp.fontScale}x`);
    if (what.length) lines.push(`- ${name}: ${what.join("; ")}`);
  }
  return lines.length ? `## Variants among the viewports\nJudge each variant for what it tests, and say which variant a finding comes from:\n${lines.join("\n")}` : "";
}

/**
 * The disciplines for a capture: the configured list, except that an app capture
 * reviewed with the untouched web list gets the native one, which speaks of platform
 * conventions instead of breakpoints.
 */
export function disciplinesFor(config, platform) {
  return isNative(platform) && config.disciplines === DEFAULT_DISCIPLINES ? NATIVE_DISCIPLINES : config.disciplines;
}

/** How a shot's first screen is named to the critic. */
export const foldLabel = (platform) => (isNative(platform) ? "first screen" : "above the fold");

/**
 * The task for one page or screen review. A scenario says which steps produced the
 * state, and when a step failed or changed nothing the critic is told the intended
 * state may not be on screen, so it reviews what the capture shows instead of what
 * the scenario meant to show.
 */
export function pageTask(route, shots, platform = "web") {
  const s = shots[0];
  const { item } = nouns(platform);
  const subject = s.scenario ? `the state "${s.scenario}" of the ${item} ${s.path}` : `the ${item} ${route}`;
  let state = "";
  if (s.scenario) {
    state = `, captured after these steps: ${(s.steps ?? []).join("; ") || "none"}`;
    if (s.stepError) state += ` (a step failed: ${s.stepError})`;
    const warnings = Array.from(new Set(shots.flatMap((x) => x.stepWarnings ?? [])));
    if (warnings.length) state += `. Some steps had no visible effect (${warnings.join("; ")})`;
    state += ". Judge the state the interaction produced: the feedback, the affordance, what changed and whether it is clear";
    if (s.stepError || warnings.length) {
      state += ". Because a step failed or changed nothing, the capture may not show the intended state: judge what it does show, and say plainly in a finding that the intended state was not reached instead of reviewing it";
    }
  }
  const signedIn = s.auth ? ". The visitor is signed in" : "";
  let what;
  if (isNative(platform)) {
    what = shots.some((x) => detailImages(x).length)
      ? "You already have its first screen per viewport; here are its further scroll frames per viewport, in order, and the measured facts. Frames overlap a little, and bars fixed to the screen edges (an app bar, a bottom navigation bar) repeat in every frame: judge them once."
      : "You already have its first screen per viewport, and it does not scroll, so that is all of it; here are the measured facts.";
  } else {
    what =
      "You already have its above-the-fold capture per viewport; here is the full-page capture per viewport (the whole scroll) and the measured facts. Full-page captures omit bars fixed to the bottom of the viewport (a sticky buy bar, a tab bar): judge those from the first-screen capture, and never report them as covering the footer.";
  }
  return `## Task\nReview ${subject} ("${s.title}")${state}${signedIn}. ${what} Name the ${item}'s real strengths first, then list findings, then account for every design discipline in coverage, then anything you still need in requests. Set page to "${route}". ${REGION_RULE}`;
}

/** How the critic marks where a finding is, so the visual report can draw it. */
const REGION_RULE =
  "For every finding, set region to the viewport and image where it shows most clearly (first is the first-screen capture, full the full-page capture, frame2 and on the scroll frames) and a box [ymin, xmin, ymax, xmax] from 0 to 1000 tightly around the element on that image, or an empty box when it is not in one place.";

/** The task for the whole-site (or whole-app) pass. */
export function siteTask(platform = "web", seen = "", launchErrors = [], lintFacts = "") {
  const { item, items, whole } = nouns(platform);
  const launch = launchErrors.length ? ` Errors the app logs on every plain launch (report them once here if they matter, never per ${item}): ${launchErrors.join(" | ")}.` : "";
  const lint = lintFacts ? ` Design-system measurements across every ${item}, taken from the computed styles (ground truth for consistency; cite them, and do not contradict them): ${lintFacts}.` : "";
  return `## Task\nUsing the first screen of every ${item} at every viewport, judge the whole ${whole}: consistency of type scale, spacing rhythm, components and tone across ${items}; whether a redesign is warranted or targeted fixes suffice (revamp_needed); and the five changes with the highest impact for the least effort across the ${whole}. Keep consistency_findings to genuine cross-${item} patterns (at most six) and do not repeat per-${item} findings. Set each finding's page to the one ${item} that shows the pattern best and its region on that ${item}'s first screen (image first), with an empty box when no single place shows it. List anything you still need in requests.${launch}${lint} Per-${item} findings already recorded: ${seen}`;
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
  const client = createClient(config, {
    ledgerPath: path.join(config.out, config.ledger),
    runLabel: `critique:${manifest.label}`,
  });

  const extra = await contextSections(config);
  const decisions = await loadDecisions(config);
  // The capture decides the platform: a web config can critique an app capture.
  const platform = manifest.platform ?? "web";
  const fold = foldLabel(platform);
  const prefix = [text(preamble(disciplinesFor(config, platform), config.principles, platform)), text(briefSection(config.briefText))];
  if (decisions.length) prefix.push(text(decisionsSection(decisions)));
  if (extra) prefix.push(text(extra));
  const variants = variantNotes(manifest.viewports);
  if (variants) prefix.push(text(variants));
  for (const s of manifest.shots) {
    prefix.push(text(`Screenshot: ${s.route} at ${s.viewport}, ${fold} (${s.title})`), await imagePart(s.fold));
  }
  const cached = await client.ensureCache(prefix, `ui-critic ${manifest.label}`);
  const viewports = manifestViewports(manifest);
  const images = imageChoices(manifest);
  const PAGE = pageSchema(viewports, platform, images);
  const thoughtLog = [];
  const done = await loadPartial(dir, manifest, config.model);
  const partialPath = path.join(dir, PARTIAL_FILE);
  const checkpoint = serialWriter(() =>
    writeFile(partialPath, JSON.stringify({ capturedAt: manifest.capturedAt, model: config.model, pages: done }, null, 2)),
  );
  const concurrency = config.concurrency ?? 1;

  const reviewPage = async (route, shots, inPrefix) => {
    const parts = inPrefix ? [] : [...prefix];
    if (!inPrefix) {
      for (const s of shots) parts.push(text(`Screenshot: ${route} at ${s.viewport}, ${fold} (${s.title})`), await imagePart(s.fold));
    }
    parts.push(text(pageTask(route, shots, platform)));
    for (const s of shots) {
      for (const img of detailImages(s)) parts.push(text(`Screenshot: ${route} at ${s.viewport}, ${img.label}`), await imagePart(img.file));
      const audit = await readAudit(s);
      if (audit) parts.push(text(`Measured facts for ${route} at ${s.viewport} (JSON): ${auditForPrompt(audit, isNative(platform) ? 6000 : 5000)}`));
    }
    const { data, thoughts } = await client.generateJSON({ parts, schema: PAGE, op: `page:${route}` });
    const slug = routeSlug(route);
    const all = (data.findings ?? []).map((f, i) => ({ id: `${slug}-${i + 1}`, ...f, page: route, region: normalizeRegion(f.region, viewports, images) }));
    const { kept, withheld } = withholdSettled(all);
    data.findings = kept;
    data.requests = data.requests ?? [];
    data.coverage = data.coverage ?? [];
    const page = { route, ...data, withheld, audits: {} };
    const stepWarnings = Array.from(new Set(shots.flatMap((s) => s.stepWarnings ?? [])));
    if (stepWarnings.length) page.stepWarnings = stepWarnings;
    if (shots[0].stepError) page.stepError = shots[0].stepError;
    for (const s of shots) {
      const audit = await readAudit(s);
      if (audit) page.audits[s.viewport] = audit;
    }
    if (thoughts) thoughtLog.push(`## ${route}\n\n${thoughts}`);
    process.stderr.write(`  reviewed ${route}: score ${data.score}, ${data.findings.length} findings${withheld.length ? ` (${withheld.length} withheld as settled)` : ""}, ${data.requests.length} requests\n`);
    return page;
  };

  try {
    // Pages are reviewed a few at a time (config.concurrency); each finished page
    // is checkpointed as it lands, and results keep the manifest's order.
    const entries = Array.from(groupByRoute(manifest.shots));
    const pages = await runPool(entries, concurrency, async ([route, shots]) => {
      if (done[route]) {
        process.stderr.write(`  reused ${route} from checkpoint: score ${done[route].score}, ${done[route].findings.length} findings\n`);
        return done[route];
      }
      const page = await reviewPage(route, shots, Boolean(cached));
      done[route] = page;
      await checkpoint();
      return page;
    });

    // The critic's page requests, fulfilled where the tool can: same origin, capped.
    let followed = { routes: [], skipped: null };
    const follow = config.followRequests ?? {};
    if (follow.enabled) {
      const wanted = followablePages(mergeRequests(pages.map((p) => p.requests)), manifest, follow.maxPages ?? 3);
      if (wanted.length) {
        process.stderr.write(`  the critic asked for ${wanted.join(", ")}; capturing\n`);
        const secrets = await readEnvFile(config.auth?.envFile);
        const more = await captureMore(manifest, wanted, { auth: config.auth ?? null, secrets });
        followed = { routes: wanted, skipped: more.skipped };
        const extraPages = await runPool(Array.from(groupByRoute(more.shots)), concurrency, async ([route, shots]) => {
          // These first screens are not in the cache, so they travel with the call.
          const page = await reviewPage(route, shots, false);
          done[route] = page;
          await checkpoint();
          return page;
        });
        pages.push(...extraPages);
      }
    }

    const seen = pages
      .flatMap((p) => p.findings.map((f) => `[${p.route}] ${f.observation}`))
      .slice(0, 60)
      .join(" | ");
    // The design-system lint is free and measured: run it, keep its report beside the
    // critique, and give the site pass its numbers.
    let lint = null;
    try {
      lint = await lintCapture(dir, config.lint ?? {});
      await writeFile(path.join(dir, "lint.json"), JSON.stringify(lint, null, 2));
      await writeFile(path.join(dir, "lint.md"), renderLint(lint));
    } catch {
      lint = null;
    }
    const parts = cached ? [] : [...prefix];
    parts.push(text(siteTask(platform, seen, manifest.launchErrors ?? [], lint ? lintForPrompt(lint) : "")));

    let overall;
    let siteError = null;
    try {
      // Routes are read now, so pages the critic asked for and the tool followed count too.
      const OVERALL = overallSchema(viewports, platform, pages.map((p) => p.route));
      const site = await client.generateJSON({ parts, schema: OVERALL, op: "site" });
      overall = site.data;
      const siteSplit = withholdSettled((overall.consistency_findings ?? []).map((f, i) => ({ id: `site-${i + 1}`, ...f, region: normalizeRegion(f.region, viewports, ["first"]) })));
      overall.consistency_findings = siteSplit.kept;
      overall.withheld = siteSplit.withheld;
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
      platform,
      label: manifest.label,
      base: manifest.base,
      ...(manifest.launchErrors?.length ? { launchErrors: manifest.launchErrors } : {}),
      reviewedAt: new Date().toISOString(),
      overall,
      pages,
      requests,
      followed,
      skipped: manifest.skipped ?? [],
      decisions,
      ...(lint ? { lint } : {}),
      usage: client.summary(),
      ...(siteError ? { error: siteError } : {}),
    };
    const jsonPath = path.join(dir, "critique.json");
    const mdPath = path.join(dir, "critique.md");
    const htmlPath = path.join(dir, "critique.html");
    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    await writeFile(mdPath, renderCritique(result));
    await writeFile(htmlPath, renderCritiqueHTML(result, manifest, dir));
    if (thoughtLog.length) await writeFile(path.join(dir, "thoughts.md"), thoughtLog.join("\n\n") + "\n");
    if (siteError) throw new Error(`site pass failed: ${siteError} (per-page results were written to ${jsonPath}; rerun to retry the site pass)`);
    return { ...result, jsonPath, mdPath, htmlPath };
  } finally {
    await client.close();
  }
}
