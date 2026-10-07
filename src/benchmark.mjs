import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { capture } from "./capture.mjs";
import { createClient } from "./provider.mjs";
import { imagePart, text } from "./parts.mjs";
import { requireBrief, contextSections } from "./brief.mjs";
import { loadDecisions, decisionsSection } from "./decisions.mjs";
import { briefSection } from "./critique.mjs";
import { esc, relativeSrc } from "./html.mjs";
import { routeSlug } from "./capture.mjs";

/**
 * Benchmarks: the products the brief names as the ones visitors compare with,
 * captured at the same viewports and reviewed beside the product page by page. A
 * benchmark maps each of the product's routes to its own equivalent page:
 *   { "name": "Jumia", "base": "https://www.jumia.com.ng", "routes": { "/": "/", "/shop": "/catalog/" } }
 * Only public pages are loaded, as a visitor would, a few at a time.
 */

/** A file-safe folder label for a benchmark. */
export const benchmarkLabel = (name) => `benchmark-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site"}`;

const COMPARISON = {
  type: "OBJECT",
  properties: {
    standing: { type: "STRING", enum: ["ahead", "level", "behind"], description: "the product's page against the benchmark's, for this product's audience" },
    they_do_better: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          what: { type: "STRING" },
          evidence: { type: "STRING", description: "where on their page" },
          adopt: { type: "STRING", description: "how to bring it to our page within our brand and decisions, specific and testable" },
        },
        required: ["what", "evidence", "adopt"],
      },
    },
    we_do_better: { type: "ARRAY", items: { type: "STRING" } },
    avoid: { type: "ARRAY", items: { type: "STRING" }, description: "things on their page not to copy, and why" },
    summary: { type: "STRING", description: "two sentences" },
  },
  required: ["standing", "they_do_better", "we_do_better", "avoid", "summary"],
};

/**
 * Captures each benchmark's mapped pages at the product capture's viewports, then
 * compares page by page. Writes benchmark.json and benchmark.html into the product
 * capture's folder.
 */
export async function benchmark({ dir, config, only = null, judge = true }) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  manifest.dir = manifest.dir ?? dir;
  if (manifest.platform && manifest.platform !== "web") throw new Error("benchmarks are captured in a browser; compare an app with --from-images captures instead");
  const list = (config.benchmarks ?? []).filter((b) => !only || b.name.toLowerCase() === only.toLowerCase());
  if (!list.length) throw new Error(only ? `no benchmark named ${only} in the config` : 'no benchmarks in the config: add "benchmarks": [{ "name", "base", "routes": { "/": "/" } }]');
  const viewports = Object.fromEntries(Object.entries(manifest.viewports ?? {}).filter(([, vp]) => !vp.a11yPreset));
  let client = null;
  let prefix = [];
  if (judge) {
    requireBrief(config);
    client = createClient(config, { ledgerPath: path.join(config.out, config.ledger), runLabel: `benchmark:${manifest.label}` });
    const decisions = await loadDecisions(config);
    const extra = await contextSections(config);
    prefix = [text("You are a senior product designer comparing a product's pages with a competitor's, to find what is worth adopting and what is not, for this product's audience."), text(briefSection(config.briefText))];
    if (decisions.length) prefix.push(text(decisionsSection(decisions)));
    if (extra) prefix.push(text(extra));
  }
  const results = [];
  try {
    for (const b of list) {
      const ours = Object.keys(b.routes).filter((r) => manifest.shots.some((s) => !s.scenario && (s.path ?? s.route) === r));
      if (!ours.length) {
        results.push({ name: b.name, base: b.base, error: `none of the mapped routes (${Object.keys(b.routes).join(", ")}) is in the capture` });
        continue;
      }
      process.stderr.write(`  capturing ${b.name}\n`);
      const theirs = await capture({ ...config, out: path.dirname(path.resolve(dir)), base: b.base, routes: ours.map((r) => b.routes[r]), viewports, scenarios: [], auth: null, label: benchmarkLabel(b.name), sweep: null });
      const pages = [];
      for (const route of ours) {
        for (const vp of Object.keys(viewports)) {
          const mine = manifest.shots.find((s) => !s.scenario && (s.path ?? s.route) === route && s.viewport === vp);
          const other = theirs.shots.find((s) => s.path === b.routes[route] && s.viewport === vp);
          if (!mine || !other) continue;
          const page = { route, theirRoute: b.routes[route], viewport: vp, ours: mine.fold, theirs: other.fold, oursFull: mine.full, theirsFull: other.full };
          // A bot check instead of their page (or ours) is not a page to compare.
          const blocked = other.blocked ? `${b.name}: ${other.blocked}` : mine.blocked ? `ours: ${mine.blocked}` : null;
          if (blocked) page.blocked = blocked;
          if (client && !blocked) {
            try {
              const parts = [
                ...prefix,
                text(`## Task\nCompare our page ${route} with ${b.name}'s ${b.routes[route]} at ${vp}. Say whether ours is ahead, level or behind for our audience; list what they do better and exactly how to adopt it within our brand and settled decisions; list what we do better; and list what on their page not to copy and why. Cite the element for every point.`),
                text("OURS, first screen"),
                await imagePart(mine.fold),
                text(`${b.name.toUpperCase()}, first screen`),
                await imagePart(other.fold),
              ];
              if (mine.full && other.full) parts.push(text("OURS, full page"), await imagePart(mine.full), text(`${b.name.toUpperCase()}, full page`), await imagePart(other.full));
              page.judgement = (await client.generateJSON({ parts, schema: COMPARISON, op: `benchmark:${b.name}:${route}@${vp}` })).data;
            } catch (err) {
              page.error = err.message;
            }
          }
          pages.push(page);
          process.stderr.write(`  ${b.name} ${route} at ${vp}: ${page.judgement?.standing ?? page.blocked ?? page.error ?? "captured"}\n`);
        }
      }
      results.push({ name: b.name, base: b.base, dir: theirs.dir, pages });
    }
  } finally {
    if (client) await client.close();
  }
  const out = { tool: "ui-critic", kind: "benchmark", base: manifest.base, label: manifest.label, generatedAt: new Date().toISOString(), usage: client ? client.summary() : null, benchmarks: results };
  const jsonPath = path.join(dir, "benchmark.json");
  const htmlPath = path.join(dir, "benchmark.html");
  await writeFile(jsonPath, JSON.stringify(out, null, 2));
  await writeFile(htmlPath, renderBenchmarkHTML(out, dir));
  return { ...out, jsonPath, htmlPath };
}

/** The benchmark report: per page and viewport, ours beside theirs with the comparison. */
export function renderBenchmarkHTML(result, dir) {
  const list = (title, items, fmt = (x) => esc(x)) => (items?.length ? `<p><strong>${title}</strong></p><ul>${items.map((x) => `<li>${fmt(x)}</li>`).join("")}</ul>` : "");
  const sections = result.benchmarks.map((b) => {
    if (b.error) return `<section><h2>${esc(b.name)}</h2><p class="warn">${esc(b.error)}</p></section>`;
    const pages = b.pages.map((p) => {
      const j = p.judgement;
      return `<div class="pair" id="${esc(`${routeSlug(p.route)}-${p.viewport}`)}"><h3>${esc(p.route)} vs ${esc(p.theirRoute)} at ${esc(p.viewport)}${j ? ` <span class="standing s-${esc(j.standing)}">${esc(j.standing)}</span>` : ""}</h3>${j ? `<p>${esc(j.summary)}</p>` : p.blocked ? `<p class="warn">Not compared: ${esc(p.blocked)}. Take this screenshot yourself and compare with --from-images.</p>` : p.error ? `<p class="warn">Not compared: ${esc(p.error)}</p>` : ""}<div class="sides"><figure><img loading="lazy" src="${esc(relativeSrc(dir, p.ours))}" alt="ours"><figcaption>ours</figcaption></figure><figure><img loading="lazy" src="${esc(relativeSrc(dir, p.theirs))}" alt="${esc(b.name)}"><figcaption>${esc(b.name)}</figcaption></figure></div>${j ? `${list("They do better", j.they_do_better, (x) => `${esc(x.what)} <span class="tag">(${esc(x.evidence)})</span><br><span class="do">Adopt: ${esc(x.adopt)}</span>`)}${list("We do better", j.we_do_better)}${list("Not worth copying", j.avoid)}` : ""}</div>`;
    });
    return `<section><h2>${esc(b.name)} <span class="tag">${esc(b.base)}</span></h2>${pages.join("")}</section>`;
  });
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Benchmarks: ${esc(result.label)}</title>
<style>
:root { --bg:#fbfaf8; --fg:#1c1b1f; --muted:#5f5e66; --line:#e6e3de; --high:#b42318; --low:#2f5bc4; --medium:#a15c07; color-scheme: light; }
:root[data-theme="dark"] { --bg:#141418; --fg:#ecebf2; --muted:#a6a5b0; --line:#2d2c35; --high:#ff8b80; --low:#94b3ff; --medium:#ffb35c; color-scheme: dark; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui, sans-serif; }
main { max-width:1180px; margin:0 auto; padding:24px 16px 64px; }
header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:19px; margin:24px 0 6px; } h3 { font-size:15px; margin:18px 0 6px; }
.tag, .meta { color:var(--muted); font-size:13px; font-weight:400; } .warn { color:var(--medium); } .do { font-weight:600; }
.theme { background:none; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:6px 10px; font:inherit; cursor:pointer; }
section { border-top:1px solid var(--line); }
.sides { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px; }
@media (max-width:700px) { .sides { grid-template-columns:1fr; } }
figure { margin:0; } img { width:100%; height:auto; border:1px solid var(--line); border-radius:6px; display:block; }
figcaption { font-size:12px; color:var(--muted); padding-top:4px; }
ul { margin:4px 0; padding-left:20px; }
.standing { font-size:12px; font-weight:700; text-transform:uppercase; } .s-ahead { color:var(--low); } .s-behind { color:var(--high); } .s-level { color:var(--muted); }
</style></head>
<body><main><header><div><h1>Benchmarks: ${esc(result.label)}</h1><p class="meta">${esc(result.base)} &middot; ${esc(result.generatedAt)}</p></div><button class="theme" type="button">Dark</button></header>
${sections.join("\n")}
</main>
<script>
(() => {
  const root = document.documentElement;
  try { const t = localStorage.getItem("ui-critic-theme"); if (t) root.dataset.theme = t; } catch (e) {}
  const btn = document.querySelector(".theme");
  const label = () => { btn.textContent = root.dataset.theme === "dark" ? "Light" : "Dark"; };
  label();
  btn.addEventListener("click", () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; label(); try { localStorage.setItem("ui-critic-theme", root.dataset.theme); } catch (e) {} });
})();
</script></body></html>
`;
}
