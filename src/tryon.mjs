import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { capture } from "./capture.mjs";
import { createClient } from "./provider.mjs";
import { imagePart, text } from "./parts.mjs";
import { requireBrief, contextSections } from "./brief.mjs";
import { loadDecisions, decisionsSection } from "./decisions.mjs";
import { briefSection } from "./critique.mjs";
import { esc, relativeSrc } from "./html.mjs";
import { decodePNG } from "./png.mjs";

/**
 * Try-on: see a design change on the real pages before anyone edits the code. CSS is
 * laid over the live site (an agent's proposed fix, or directions the critic drafts
 * for a goal), the pages are captured with it and compared with the original
 * capture, and a gallery shows each direction beside the original.
 */

const MAX_CSS = 20_000;
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//i;

/**
 * Makes CSS safe to lay over a page: no imports or url() fetches from anywhere but
 * Google Fonts (data: URLs are kept), no legacy script hooks, and a size cap. It is
 * inserted as a style element's text, so it cannot break out into markup.
 */
export function sanitizeCss(css) {
  let s = String(css ?? "").slice(0, MAX_CSS);
  s = s.replace(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?[^;]*;?/gi, (whole, href) => (FONT_HOSTS.test(href) ? whole : ""));
  s = s.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, _q, href) => (FONT_HOSTS.test(href) || /^data:/i.test(href) ? whole : "none"));
  s = s.replace(/expression\s*\(/gi, "(").replace(/-moz-binding\s*:/gi, "x-binding:").replace(/behavior\s*:/gi, "x-behavior:").replace(/javascript:/gi, "");
  return s;
}

/**
 * The routes and viewports of a capture, as a try-on repeats them: its resting pages
 * (signed in where they were), at its own viewports without the accessibility
 * variants.
 */
export function tryonPlan(manifest, routes = null, maxRoutes = 3) {
  return planOf(manifest, routes, maxRoutes);
}

/**
 * Makes try-on CSS win over the page's own: :root becomes :root:not(#uic), which
 * outranks the page's :root and :root[data-theme] rules whatever order they load in.
 */
export function boostRoot(css) {
  return String(css).replace(/:root(?![\w-])/g, ":root:not(#uic)");
}

/** The share of pixels (in percent) that differ between two PNGs of one size, or null when they cannot be compared. */
export function pixelChange(a, b) {
  try {
    const x = decodePNG(a);
    const y = decodePNG(b);
    if (x.width !== y.width || x.height !== y.height) return null;
    let changed = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 6) changed += 1;
    }
    return Math.round((changed / (x.width * x.height)) * 1000) / 10;
  } catch {
    return null;
  }
}

function planOf(manifest, routes, maxRoutes) {
  const seen = new Map();
  for (const s of (manifest.shots ?? []).filter((x) => !x.scenario)) {
    const p = s.path ?? s.route;
    if (!seen.has(p)) seen.set(p, { path: p, auth: Boolean(s.auth) });
  }
  const all = Array.from(seen.values());
  const chosen = routes?.length ? all.filter((r) => routes.includes(r.path)) : all.slice(0, maxRoutes);
  const viewports = Object.fromEntries(Object.entries(manifest.viewports ?? {}).filter(([, vp]) => !vp.a11yPreset));
  return { routes: chosen, viewports };
}

const DIRECTIONS = {
  type: "OBJECT",
  properties: {
    directions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "two or three words, lowercase, naming the direction" },
          rationale: { type: "STRING", description: "two sentences: what it changes and why it serves the brief" },
          css: { type: "STRING", description: "CSS to lay over the live pages; prefer overriding the page's own custom properties on :root, then targeted rules" },
        },
        required: ["name", "rationale", "css"],
      },
    },
  },
  required: ["directions"],
};

/** Asks the critic for directions toward a goal, as CSS over the captured pages. */
export async function proposeDirections({ config, manifest, goal, count, lintFacts = "", critiqueSummary = "" }) {
  const client = createClient(config, { ledgerPath: path.join(config.out, config.ledger), runLabel: `tryon:${manifest.label}` });
  const decisions = await loadDecisions(config);
  const extra = await contextSections(config);
  const parts = [
    text(
      "You are a senior product designer proposing design directions as CSS that will be laid over the live pages of a product and captured, so the team can see each direction on the real pages before changing any code.",
    ),
    text(briefSection(config.briefText)),
  ];
  if (decisions.length) parts.push(text(decisionsSection(decisions)));
  if (extra) parts.push(text(extra));
  if (lintFacts) parts.push(text(`## The page's design system, measured\n${lintFacts}`));
  if (critiqueSummary) parts.push(text(`## The latest critique\n${critiqueSummary}`));
  for (const s of manifest.shots.filter((x) => !x.scenario).slice(0, 6)) parts.push(text(`Screenshot: ${s.route} at ${s.viewport}`), await imagePart(s.fold));
  parts.push(
    text(
      `## Task\nPropose ${count} distinct directions for this goal: ${goal}. Each is CSS laid over the pages exactly as they are: override the page's own custom properties on :root where they exist (they are listed in the measured design system), and add targeted rules only where a property does not reach. Keep every direction within the brief's brand system and the settled decisions, keep text contrast at WCAG AA or better, never hide content, and do not use external resources other than Google Fonts.`,
    ),
  );
  try {
    const { data } = await client.generateJSON({ parts, schema: DIRECTIONS, op: "tryon:directions" });
    return { directions: (data.directions ?? []).slice(0, count), usage: client.summary() };
  } finally {
    await client.close();
  }
}

const JUDGEMENT = {
  type: "OBJECT",
  properties: {
    changed: { type: "ARRAY", items: { type: "STRING" }, description: "what visibly differs between ORIGINAL and DIRECTION, each naming the element and the change" },
    serves_goal: { type: "STRING", enum: ["yes", "partly", "no"] },
    verdict: { type: "STRING", enum: ["better", "same", "worse", "mixed"], description: "the direction against the original, as a design for this product's brief" },
    gains: { type: "ARRAY", items: { type: "STRING" } },
    losses: { type: "ARRAY", items: { type: "STRING" }, description: "what the direction costs: contrast, brand fit, hierarchy, readability" },
    notes: { type: "STRING" },
  },
  required: ["changed", "serves_goal", "verdict", "gains", "losses", "notes"],
};

const PICK = {
  type: "OBJECT",
  properties: {
    best: { type: "STRING", description: "the name of the direction that serves the goal best, exactly as given, or original when none beats it" },
    why: { type: "STRING", description: "two sentences" },
  },
  required: ["best", "why"],
};

/**
 * Judges one direction on one page: what it visibly changed (the measured share of
 * changed pixels is given, so a subtle change is not mistaken for none), whether it
 * serves the goal, and its gains and losses against the original for this brief. A
 * neutral, deliberate change is the point of a try-on, so it is described, not only
 * scored.
 */
async function judgeDirection(client, prefix, { route, viewport, goal, direction, original, tried, percent }) {
  const parts = [...prefix];
  parts.push(
    text(
      `## Task\nA design direction was laid over the live page ${route} at ${viewport}: "${direction.name}". ${direction.rationale} The goal: ${goal}. Measured: ${percent ?? "an unknown share"}% of the first screen's pixels changed. Compare ORIGINAL and DIRECTION: list what visibly changed (the element and how), say whether the direction serves the goal, and judge it against the original as a design for this brief (better, same, worse or mixed), with its gains and its losses; watch text contrast, brand fit, hierarchy and readability.`,
    ),
    text("ORIGINAL, first screen"),
    await imagePart(original),
    text("DIRECTION, first screen"),
    await imagePart(tried),
  );
  const { data } = await client.generateJSON({ parts, schema: JUDGEMENT, op: `tryon:${direction.name}:${route}@${viewport}` });
  return data;
}

/** A file-safe label for a direction. */
export const directionSlug = (name, i) => `tryon-${String(name || `direction-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || `direction-${i + 1}`}`;

/**
 * Captures the base capture's routes again with each direction's CSS laid over them,
 * compares each with the base when the critic is available, and writes tryon.json and
 * the tryon.html gallery into the base capture's folder.
 */
export async function tryon({ dir, config, goal, count = 3, css = null, routes = null, judge = true }) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  manifest.dir = manifest.dir ?? dir;
  if (manifest.platform && manifest.platform !== "web") throw new Error("try-on lays CSS over live pages, which needs a web capture");
  const plan = tryonPlan(manifest, routes);
  if (!plan.routes.length) throw new Error(routes?.length ? `none of ${routes.join(", ")} is in the capture` : "no captured routes to try on");
  let directions;
  let proposalUsage = null;
  let judgeUsage = null;
  let pick = null;
  if (css) {
    directions = [{ name: "proposal", rationale: "CSS supplied for review.", css }];
  } else {
    requireBrief(config);
    let lintFacts = "";
    let critiqueSummary = "";
    try {
      // The lint is free; it gives the critic the page's own token names to override.
      const { lintCapture, lintForPrompt } = await import("./lint.mjs");
      const lint = await lintCapture(dir, config.lint ?? {});
      lintFacts = `${lintForPrompt(lint, 1500)}. The page's custom properties: ${JSON.stringify(lint.tokensDeclared ?? {}).slice(0, 2500)}`;
    } catch {
      // no style inventory: the critic works from the screenshots
    }
    try {
      const c = JSON.parse(await readFile(path.join(dir, "critique.json"), "utf8"));
      critiqueSummary = `${c.overall.verdict} Priorities: ${(c.overall.top_priorities ?? []).join(" | ")}`;
    } catch {
      // no critique yet
    }
    const proposed = await proposeDirections({ config, manifest, goal: goal || "apply the critique's top priorities", count, lintFacts, critiqueSummary });
    directions = proposed.directions;
    proposalUsage = proposed.usage;
  }
  const goalText = css ? "the supplied CSS" : goal || "apply the critique's top priorities";
  let client = null;
  let prefix = [];
  if (judge) {
    requireBrief(config);
    client = createClient(config, { ledgerPath: path.join(config.out, config.ledger), runLabel: `tryon:${manifest.label}` });
    const decisions = await loadDecisions(config);
    prefix = [text("You are a senior product designer judging design directions tried on the live pages of a product."), text(briefSection(config.briefText))];
    if (decisions.length) prefix.push(text(decisionsSection(decisions)));
  }
  const results = [];
  try {
    for (const [i, d] of directions.entries()) {
      const label = directionSlug(d.name, i);
      const safe = boostRoot(sanitizeCss(d.css));
      process.stderr.write(`  trying on ${d.name}\n`);
      // Beside the original capture, so the gallery finds both.
      const shot = await capture({ ...config, out: path.dirname(path.resolve(dir)), base: manifest.base, routes: plan.routes, viewports: plan.viewports, scenarios: [], label, sweep: null, injectCss: safe });
      // How much of each first screen the CSS changed, measured: a direction that changed
      // nothing (a selector that matched nothing, say) is said plainly.
      const pages = [];
      for (const s of shot.shots) {
        const base = manifest.shots.find((o) => !o.scenario && (o.path ?? o.route) === s.path && o.viewport === s.viewport);
        if (!base) continue;
        const percent = pixelChange(await readFile(base.fold), await readFile(s.fold));
        const page = { route: s.path, viewport: s.viewport, percent, original: base.fold, tried: s.fold };
        if (client && !(percent !== null && percent < 0.5)) {
          try {
            page.judgement = await judgeDirection(client, prefix, { route: s.path, viewport: s.viewport, goal: goalText, direction: d, original: base.fold, tried: s.fold, percent });
          } catch (err) {
            page.error = err.message;
          }
        }
        pages.push(page);
      }
      const nothing = pages.length && pages.every((p) => p.percent !== null && p.percent < 0.5);
      if (nothing) process.stderr.write(`  ${d.name}: the CSS changed nothing on the first screens; check its selectors\n`);
      results.push({ name: d.name, rationale: d.rationale, css: safe, label, dir: shot.dir, changedNothing: Boolean(nothing), pages });
    }
    // With several directions, one look at all of them names the one to take forward.
    if (client && results.length > 1) {
      const first = (r) => r.pages.find((p) => !/mobile|phone/i.test(p.viewport)) ?? r.pages[0];
      const parts = [...prefix, text(`## Task\nThese directions were tried for the goal: ${goalText}. Name the one that serves the goal best for this brief, or original when none beats the original.`)];
      const orig = first(results[0]);
      if (orig) parts.push(text("ORIGINAL"), await imagePart(orig.original));
      for (const r of results) {
        const p = first(r);
        if (p) parts.push(text(`DIRECTION "${r.name}": ${r.rationale}`), await imagePart(p.tried));
      }
      try {
        pick = (await client.generateJSON({ parts, schema: PICK, op: "tryon:pick" })).data;
      } catch (err) {
        pick = { best: null, why: `no pick: ${err.message}` };
      }
    }
  } finally {
    if (client) {
      judgeUsage = client.summary();
      await client.close();
    }
  }
  const out = { tool: "ui-critic", kind: "tryon", base: manifest.base, label: manifest.label, goal: goalText, routes: plan.routes.map((r) => r.path), generatedAt: new Date().toISOString(), pick, proposalUsage, judgeUsage, directions: results };
  const jsonPath = path.join(dir, "tryon.json");
  const htmlPath = path.join(dir, "tryon.html");
  await writeFile(jsonPath, JSON.stringify(out, null, 2));
  await writeFile(htmlPath, renderTryonHTML(out, manifest, dir));
  return { ...out, jsonPath, htmlPath };
}

/** The try-on gallery: the pick, then each direction's rationale, CSS, and each page beside the original with its judgement. */
export function renderTryonHTML(result, manifest, dir) {
  const original = (route, viewport) => (manifest.shots ?? []).find((s) => (s.path ?? s.route) === route && s.viewport === viewport && !s.scenario);
  const list = (title, items) => (items?.length ? `<p><strong>${title}:</strong></p><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const sections = result.directions.map((d) => {
    const pages = (d.pages ?? []).map((p) => {
      const before = p.original ?? original(p.route, p.viewport)?.fold;
      const after = p.tried ?? path.join(d.dir, path.basename(before ?? ""));
      const j = p.judgement;
      const head = j ? ` <span class="verdict v-${esc(j.verdict)}">${esc(j.verdict)}</span> <span class="tag">serves the goal: ${esc(j.serves_goal)}</span>` : "";
      const measured = p.percent === null || p.percent === undefined ? "" : `<span class="tag">${esc(p.percent)}% of the first screen changed</span>`;
      return `<div class="pair"><h3>${esc(p.route)} at ${esc(p.viewport)}${head}</h3>${measured}<div class="sides"><figure><img loading="lazy" src="${esc(relativeSrc(dir, before))}" alt="original"><figcaption>original</figcaption></figure><figure><img loading="lazy" src="${esc(relativeSrc(dir, after))}" alt="${esc(d.name)}"><figcaption>${esc(d.name)}</figcaption></figure></div>${j ? `${list("What changed", j.changed)}${list("Gains", j.gains)}${list("Losses", j.losses)}${j.notes ? `<p class="tag">${esc(j.notes)}</p>` : ""}` : p.error ? `<p class="tag">Not judged: ${esc(p.error)}</p>` : ""}</div>`;
    });
    const warn = d.changedNothing ? `<p class="warn">This CSS changed nothing on the first screens: its selectors may not match this site.</p>` : "";
    return `<section class="direction"><h2>${esc(d.name)}</h2><p>${esc(d.rationale)}</p>${warn}<details><summary>CSS</summary><pre>${esc(d.css)}</pre></details>${pages.join("")}</section>`;
  });
  const pick = result.pick?.best ? `<section class="pick"><h2>Recommended: ${esc(result.pick.best)}</h2><p>${esc(result.pick.why)}</p></section>` : "";
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Try-on: ${esc(result.label)}</title>
<style>
:root { --bg:#fbfaf8; --fg:#1c1b1f; --muted:#5f5e66; --line:#e6e3de; --surface:#fff; --high:#b42318; --low:#2f5bc4; --medium:#a15c07; color-scheme: light; }
:root[data-theme="dark"] { --bg:#141418; --fg:#ecebf2; --muted:#a6a5b0; --line:#2d2c35; --surface:#1b1b21; --high:#ff8b80; --low:#94b3ff; --medium:#ffb35c; color-scheme: dark; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, sans-serif; }
main { max-width:1180px; margin:0 auto; padding:24px 16px 64px; }
header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:19px; margin:0 0 6px; } h3 { font-size:15px; margin:16px 0 4px; }
.meta, .tag { color:var(--muted); font-size:13px; }
.warn { color:var(--medium); }
.theme { background:none; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:6px 10px; font:inherit; cursor:pointer; }
section.direction, section.pick { padding:24px 0; border-top:1px solid var(--line); }
.sides { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px; }
@media (max-width:700px) { .sides { grid-template-columns:1fr; } }
figure { margin:0; } img { width:100%; height:auto; border:1px solid var(--line); border-radius:6px; display:block; }
figcaption { font-size:12px; color:var(--muted); padding-top:4px; }
pre { white-space:pre-wrap; background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:12px; }
ul { margin:4px 0; padding-left:20px; }
.verdict { font-size:12px; font-weight:700; text-transform:uppercase; } .v-better { color:var(--low); } .v-worse { color:var(--high); } .v-mixed { color:var(--medium); } .v-same { color:var(--muted); }
</style></head>
<body><main><header><div><h1>Try-on: ${esc(result.goal)}</h1><p class="meta">${esc(result.base)} &middot; ${esc(result.routes.join(", "))} &middot; ${esc(result.generatedAt)}</p></div><button class="theme" type="button">Dark</button></header>
${pick}
${sections.join("\n")}
</main>
<script>
(() => {
  const root = document.documentElement;
  try { const t = localStorage.getItem("ui-critic-theme"); if (t) root.dataset.theme = t; } catch (e) {}
  const btn = document.querySelector(".theme");
  const label = () => { btn.textContent = root.dataset.theme === "dark" ? "Light" : "Dark"; };
  label();
  btn.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    label();
    try { localStorage.setItem("ui-critic-theme", root.dataset.theme); } catch (e) {}
  });
})();
</script></body></html>
`;
}
