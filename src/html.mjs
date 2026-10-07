import { realpathSync } from "node:fs";
import path from "node:path";
import { auditSummary } from "./audit.mjs";
import { routeSlug } from "./capture.mjs";

/**
 * The visual reports: critique.html draws every finding as a numbered box on the
 * screenshot it is about, beside the list of findings, with filters; compare.html
 * puts before and after side by side with a slider. Each is one self-contained file
 * (no requests to anywhere) next to the screenshots, which it references relatively,
 * so the folder can be zipped, uploaded as a CI artifact or opened from disk.
 * Light first, with a dark toggle.
 */

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * A path from the report's folder to an image, with forward slashes for a browser.
 * Both sides are resolved through the real path first, because on Windows a capture
 * recorded from a short 8.3 directory ("ELIJAH~1.OGU") and a report rendered from
 * the long one are the same folder but not the same string, and the picture would
 * get a path climbing out to the drive root that no browser or server can follow.
 */
export function relativeSrc(from, file) {
  if (!file) return "";
  return path.relative(realPath(from), realPath(path.resolve(file))).split(path.sep).join("/");
}

function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** The file behind a region's image name for a shot: first, full, or frameN. */
export function imageFile(shot, image) {
  if (!shot) return null;
  if (image === "first") return shot.fold;
  if (image === "full") return shot.full ?? null;
  const m = /^frame(\d+)$/.exec(image ?? "");
  if (m && Array.isArray(shot.frames)) return shot.frames[Number(m[1]) - 1] ?? null;
  return null;
}

/** Every image of a shot with its region name and a caption. */
export function shotImages(shot) {
  const out = [{ image: "first", file: shot.fold, caption: shot.frames ? "first screen" : "above the fold" }];
  if (shot.full && !shot.frames) out.push({ image: "full", file: shot.full, caption: "full page" });
  if (Array.isArray(shot.frames)) shot.frames.slice(1).forEach((file, i) => out.push({ image: `frame${i + 2}`, file, caption: `frame ${i + 2} of ${shot.frames.length}` }));
  return out;
}

const STYLE = `
:root { --bg:#fbfaf8; --surface:#ffffff; --fg:#1c1b1f; --muted:#5f5e66; --line:#e6e3de; --accent:#5a3ec8; --high:#b42318; --medium:#a15c07; --low:#2f5bc4; --hot:rgba(90,62,200,.16); color-scheme: light; }
:root[data-theme="dark"] { --bg:#141418; --surface:#1b1b21; --fg:#ecebf2; --muted:#a6a5b0; --line:#2d2c35; --accent:#b6a4ff; --high:#ff8b80; --medium:#ffb35c; --low:#94b3ff; --hot:rgba(182,164,255,.18); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; }
header.top { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 0; } h3 { font-size: 15px; margin: 24px 0 8px; }
.meta { color: var(--muted); font-size: 13px; margin: 0; }
.theme { background: none; border: 1px solid var(--line); color: var(--fg); border-radius: 8px; padding: 6px 10px; font: inherit; cursor: pointer; }
.overall { display: grid; grid-template-columns: auto 1fr; gap: 8px 20px; padding: 20px 0; border-bottom: 1px solid var(--line); }
.big { font-size: 40px; font-weight: 700; line-height: 1; } .big small { font-size: 15px; color: var(--muted); font-weight: 400; }
.overall ol { margin: 8px 0 0; padding-left: 20px; }
nav.filters { position: sticky; top: 0; z-index: 5; background: var(--bg); display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
nav.filters label { display: inline-flex; gap: 6px; align-items: center; }
nav.filters select, nav.filters input[type=search] { font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; }
.count { color: var(--muted); margin-left: auto; }
section.page, section.pair { padding: 28px 0; border-bottom: 1px solid var(--line); scroll-margin-top: 112px; }
li.finding { scroll-margin-top: 112px; }
.page-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.score { font-weight: 700; color: var(--accent); }
.summary { margin: 6px 0; } .facts { color: var(--muted); font-size: 13px; margin: 4px 0; }
.warn { color: var(--medium); font-size: 13px; margin: 4px 0; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 24px; margin-top: 16px; }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
.shots { display: flex; gap: 12px; flex-wrap: wrap; align-content: flex-start; }
figure { margin: 0; width: min(100%, 300px); }
figure.wide { width: min(100%, 520px); }
.frame { position: relative; line-height: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--surface); }
.frame img { width: 100%; height: auto; display: block; }
figcaption { font-size: 12px; color: var(--muted); padding-top: 4px; }
a.box { position: absolute; border: 2px solid var(--sev); border-radius: 4px; background: transparent; text-decoration: none; }
a.box span { position: absolute; top: -2px; left: -2px; background: var(--sev); color: #fff; font: 600 11px/16px system-ui, sans-serif; padding: 0 5px; border-radius: 3px 0 4px 0; }
a.box.hot, a.box:hover, a.box:focus-visible { background: var(--hot); outline: 2px solid var(--sev); outline-offset: 1px; }
.sev-high { --sev: var(--high); } .sev-medium { --sev: var(--medium); } .sev-low { --sev: var(--low); }
ol.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
li.finding { padding: 10px 12px; border-left: 3px solid var(--sev); background: var(--surface); border-radius: 0 6px 6px 0; }
li.finding.hot { background: var(--hot); }
li.finding .tag { font-size: 12px; color: var(--muted); }
li.finding .num { display: inline-block; min-width: 20px; font-weight: 700; color: var(--sev); }
li.finding p { margin: 4px 0 0; } li.finding .do { font-weight: 600; }
details { margin-top: 10px; } summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.hidden { display: none !important; }
ul.plain { padding-left: 18px; margin: 6px 0; }
.empty { color: var(--muted); }
.chip { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line); vertical-align: -1px; margin-right: 6px; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`;

const SCRIPT = `
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
  const items = Array.from(document.querySelectorAll("li.finding"));
  const boxes = Array.from(document.querySelectorAll("a.box"));
  const sev = Array.from(document.querySelectorAll("input[data-sev]"));
  const cat = document.querySelector("select[data-cat]");
  const vp = document.querySelector("select[data-vp]");
  const q = document.querySelector("input[type=search]");
  const count = document.querySelector(".count");
  const apply = () => {
    const on = new Set(sev.filter((s) => s.checked).map((s) => s.dataset.sev));
    const text = (q.value || "").toLowerCase();
    let shown = 0;
    for (const li of items) {
      const ok = on.has(li.dataset.sev) && (!cat.value || li.dataset.cat === cat.value) && (!vp.value || li.dataset.vp === vp.value || li.dataset.vp === "all") && (!text || li.textContent.toLowerCase().includes(text));
      li.classList.toggle("hidden", !ok);
      if (ok) shown += 1;
    }
    for (const b of boxes) {
      const li = document.getElementById(b.dataset.f);
      b.classList.toggle("hidden", !li || li.classList.contains("hidden"));
    }
    count.textContent = shown + " of " + items.length + " findings";
  };
  [...sev, cat, vp].forEach((el) => el.addEventListener("change", apply));
  q.addEventListener("input", apply);
  const link = (id, on) => {
    document.querySelectorAll('[data-f="' + id + '"]').forEach((el) => el.classList.toggle("hot", on));
    const li = document.getElementById(id);
    if (li) li.classList.toggle("hot", on);
  };
  for (const el of [...items, ...boxes]) {
    const id = el.dataset.f || el.id;
    el.addEventListener("mouseenter", () => link(id, true));
    el.addEventListener("mouseleave", () => link(id, false));
    el.addEventListener("focus", () => link(id, true));
    el.addEventListener("blur", () => link(id, false));
  }
  apply();
})();
`;

function findingItem(f, n) {
  const kind = [f.severity, f.category, f.viewport, `effort ${f.effort}`, f.defect_kind].filter(Boolean).join(", ");
  return `<li class="finding sev-${esc(f.severity)}" id="f-${esc(f.id)}" data-f="f-${esc(f.id)}" tabindex="0" data-sev="${esc(f.severity)}" data-cat="${esc(f.category)}" data-vp="${esc(f.viewport)}">
<span class="num">${n}</span> <span class="tag">${esc(kind)}</span>
<p>${esc(f.observation)}</p>
<p class="tag">Evidence: ${esc(f.evidence)}</p>
<p class="do">Do: ${esc(f.recommendation)}</p>
</li>`;
}

function boxFor(f, n) {
  const [ymin, xmin, ymax, xmax] = f.region.box;
  const style = `top:${ymin / 10}%;left:${xmin / 10}%;height:${(ymax - ymin) / 10}%;width:${(xmax - xmin) / 10}%`;
  return `<a class="box sev-${esc(f.severity)}" href="#f-${esc(f.id)}" data-f="f-${esc(f.id)}" style="${style}" aria-label="Finding ${n}: ${esc(f.observation)}"><span>${n}</span></a>`;
}

function figure(dir, img, viewport, boxes) {
  const wide = /desktop|tablet/i.test(viewport) && img.image === "first";
  return `<figure${wide ? ' class="wide"' : ""}><div class="frame"><img loading="lazy" src="${esc(relativeSrc(dir, img.file))}" alt="${esc(`${viewport}, ${img.caption}`)}">${boxes.join("")}</div><figcaption>${esc(viewport)}, ${esc(img.caption)}</figcaption></figure>`;
}

/**
 * The shots of one page with its findings' boxes drawn on them. First screens and
 * any image a finding points at are shown; the rest fold away.
 */
function pageShots(dir, shots, findings, numbers) {
  const shown = [];
  const folded = [];
  for (const shot of shots) {
    for (const img of shotImages(shot)) {
      const here = findings.filter((f) => f.region?.box && f.region.viewport === shot.viewport && (imageFile(shot, f.region.image) ?? shot.fold) === img.file);
      const html = figure(dir, img, shot.viewport, here.map((f) => boxFor(f, numbers.get(f.id))));
      if (img.image === "first" || here.length) shown.push(html);
      else folded.push(html);
    }
  }
  return `<div class="shots">${shown.join("")}${folded.length ? `<details><summary>${folded.length} more capture${folded.length === 1 ? "" : "s"}</summary><div class="shots">${folded.join("")}</div></details>` : ""}</div>`;
}

/** A colour chip for a value that is a colour, or nothing. */
function swatch(value) {
  const hex = /^#[0-9a-f]{6}/i.exec(String(value))?.[0];
  return hex ? `<span class="chip" style="background:${hex}" aria-hidden="true"></span>` : "";
}

/** The design-system lint as a section: metrics, findings with swatches, the proposed scales. */
function lintSection(lint) {
  const m = lint.metrics ?? {};
  const facts = [`${m.colorsUsed ?? 0} colours`, m.colorTokens ? `token coverage ${Math.round((m.tokenCoverage ?? 0) * 100)}%` : "no colour tokens", `${m.fontSizes ?? 0} font sizes`, `${m.families ?? 0} families`, `${m.radii ?? 0} radii`, `${m.shadows ?? 0} shadows`, `${m.offGridSpacing ?? 0} spacing values off the grid`];
  const items = (lint.findings ?? []).map(
    (f) => `<li class="finding sev-${esc(f.severity)}"><span class="tag">${esc(f.severity)}, ${esc(f.rule)}</span><p><strong>${esc(f.title)}</strong>. ${esc(f.detail)}</p><ul class="plain">${f.values
      .map((v) => `<li>${swatch(v.value)}<code>${esc(v.value)}</code> used ${esc(v.count)}x${v.note ? `, ${esc(v.note)}` : ""}${v.samples?.length ? ` <span class="tag">(${esc(v.samples.join("; "))})</span>` : ""}</li>`)
      .join("")}</ul><p class="do">Do: ${esc(f.fix)}</p></li>`,
  );
  const p = lint.proposal ?? {};
  const proposal = [
    p.palette?.length ? `<p>Palette: ${p.palette.map((c) => `${swatch(c.color)}<code>${esc(c.color)}</code>`).join(" ")}</p>` : "",
    p.typeScale ? `<p>Type: ratio ${esc(p.typeScale.ratio)} from ${esc(p.typeScale.base)}: ${esc(p.typeScale.steps.join(", "))}</p>` : "",
    p.spacing?.length ? `<p>Spacing: ${esc(p.spacing.join(", "))}</p>` : "",
    p.radii?.length ? `<p>Radii: ${esc(p.radii.join(", "))}</p>` : "",
  ].join("");
  return `<section class="page" id="design-system"><div class="page-head"><h2>Design system</h2><span class="tag">measured from the computed styles, free</span></div><p class="facts">${esc(facts.join(", "))}</p>${items.length ? `<ol class="findings">${items.join("")}</ol>` : '<p class="empty">No drift: the pages keep to their tokens and scales.</p>'}<details><summary>Proposed scales</summary>${proposal}</details></section>`;
}

/** The critique as one HTML page. */
export function renderCritiqueHTML(result, manifest, dir) {
  const shotsByRoute = new Map();
  for (const s of manifest?.shots ?? []) {
    if (!shotsByRoute.has(s.route)) shotsByRoute.set(s.route, []);
    shotsByRoute.get(s.route).push(s);
  }
  const allFindings = [...(result.overall.consistency_findings ?? []), ...result.pages.flatMap((p) => p.findings)];
  const categories = Array.from(new Set(allFindings.map((f) => f.category))).sort();
  const viewports = Array.from(new Set((manifest?.shots ?? []).map((s) => s.viewport)));
  const native = result.platform && result.platform !== "web";
  const usage = result.usage ? `${result.usage.calls} calls, about $${result.usage.estimatedCostUSD?.toFixed?.(4) ?? "?"} with ${esc(result.usage.model ?? result.model)}` : "";
  const parts = [];
  parts.push(`<header class="top"><div><h1>UI critique: ${esc(result.label)}</h1><p class="meta">${esc(result.base)} &middot; ${esc(result.model)} &middot; reviewed ${esc(result.reviewedAt)}${usage ? ` &middot; ${usage}` : ""}</p></div><button class="theme" type="button">Dark</button></header>`);
  const score = result.overall.score == null ? "n/a" : result.overall.score;
  parts.push(`<section class="overall"><div class="big">${esc(score)}<small>/100</small></div><div><p>${esc(result.overall.verdict)}</p>${result.overall.revamp_needed ? "<p><strong>A revamp is recommended.</strong></p>" : ""}${result.overall.top_priorities?.length ? `<ol>${result.overall.top_priorities.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>` : ""}</div></section>`);
  parts.push(`<nav class="filters" aria-label="Filter findings">
${["high", "medium", "low"].map((s) => `<label class="sev-${s}"><input type="checkbox" data-sev="${s}" checked> ${s}</label>`).join("")}
<label>Category <select data-cat><option value="">all</option>${categories.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
<label>Viewport <select data-vp><option value="">all</option>${viewports.map((v) => `<option>${esc(v)}</option>`).join("")}</select></label>
<input type="search" placeholder="Search findings" aria-label="Search findings">
<span class="count"></span></nav>`);

  const numbers = new Map();
  if (result.overall.consistency_findings?.length) {
    const site = result.overall.consistency_findings;
    site.forEach((f, i) => numbers.set(f.id, `S${i + 1}`));
    const byPage = new Map();
    for (const f of site) {
      if (!f.region?.box) continue;
      if (!byPage.has(f.page)) byPage.set(f.page, []);
      byPage.get(f.page).push(f);
    }
    const figs = [];
    for (const [route, list] of byPage) {
      for (const shot of shotsByRoute.get(route) ?? []) {
        const here = list.filter((f) => f.region.viewport === shot.viewport);
        if (here.length) figs.push(figure(dir, { image: "first", file: shot.fold, caption: `${route}, first screen` }, shot.viewport, here.map((f) => boxFor(f, numbers.get(f.id)))));
      }
    }
    parts.push(`<section class="page" id="cross"><div class="page-head"><h2>${native ? "Across screens" : "Across pages"}</h2></div><div class="layout"><div class="shots">${figs.join("") || '<p class="empty">These patterns are not in one place.</p>'}</div><ol class="findings">${site.map((f) => findingItem(f, numbers.get(f.id))).join("")}</ol></div></section>`);
  }

  for (const page of result.pages) {
    page.findings.forEach((f, i) => numbers.set(f.id, String(i + 1)));
    const shots = shotsByRoute.get(page.route) ?? [];
    const facts = Object.entries(page.audits ?? {})
      .map(([vp, a]) => `${vp}: ${auditSummary(a)}`)
      .filter((s) => !s.endsWith(": "));
    parts.push(`<section class="page" id="p-${esc(routeSlug(page.route))}">
<div class="page-head"><h2>${esc(page.route)}</h2><span class="score">${esc(page.score)}/100</span></div>
<p class="summary">${esc(page.summary)}</p>
${facts.length ? `<p class="facts">Measured: ${esc(facts.join("; "))}</p>` : ""}
${page.stepError ? `<p class="warn">A step failed, so this may not show the intended state: ${esc(page.stepError)}</p>` : ""}
${page.stepWarnings?.length ? `<p class="warn">Steps that changed nothing on screen: ${esc(page.stepWarnings.join("; "))}</p>` : ""}
<div class="layout">${pageShots(dir, shots, page.findings, numbers)}<div>${page.findings.length ? `<ol class="findings">${page.findings.map((f) => findingItem(f, numbers.get(f.id))).join("")}</ol>` : '<p class="empty">No findings.</p>'}
${page.strengths?.length ? `<details><summary>Strengths (${page.strengths.length})</summary><ul class="plain">${page.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></details>` : ""}
${page.coverage?.length ? `<details><summary>Disciplines checked (${page.coverage.length})</summary><ul class="plain">${page.coverage.map((c) => `<li><strong>${esc(c.discipline)}</strong>: ${esc(c.status)}. ${esc(c.note)}</li>`).join("")}</ul></details>` : ""}
</div></div></section>`);
  }

  if (result.lint) parts.push(lintSection(result.lint));

  const extras = [];
  const open = (result.requests ?? []).filter((r) => !(r.kind === "page" && result.followed?.routes?.includes(r.target)));
  if (open.length) extras.push(`<h3>The critic asks for</h3><ul class="plain">${open.map((r) => `<li>[${esc(r.kind)}] ${esc(r.target)}: ${esc(r.why)}</li>`).join("")}</ul>`);
  const withheld = [...(result.overall.withheld ?? []), ...result.pages.flatMap((p) => p.withheld ?? [])];
  if (result.decisions?.length) extras.push(`<h3>Settled decisions applied: ${result.decisions.length}; findings withheld: ${withheld.length}</h3>${withheld.length ? `<ul class="plain">${withheld.map((f) => `<li>[${esc(f.page ?? "site")}] ${esc(f.observation)} (reopens: ${esc(f.conflicts_with_decision)})</li>`).join("")}</ul>` : ""}`);
  if (result.launchErrors?.length) extras.push(`<h3>Errors the app logs on every launch</h3><ul class="plain">${result.launchErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`);
  if (result.skipped?.length) extras.push(`<h3>Not captured</h3><ul class="plain">${result.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`);
  if (extras.length) parts.push(`<section class="page">${extras.join("")}</section>`);

  return `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UI critique: ${esc(result.label)}</title><style>${STYLE}</style></head>
<body><main>${parts.join("\n")}</main><script>${SCRIPT}</script></body></html>
`;
}

const COMPARE_STYLE = `
.pair { padding: 28px 0; border-bottom: 1px solid var(--line); }
.verdict { font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; padding: 2px 8px; border-radius: 99px; border: 1px solid currentColor; }
.v-better { color: var(--low); } .v-worse { color: var(--high); } .v-mixed { color: var(--medium); } .v-same { color: var(--muted); }
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
@media (max-width: 700px) { .sides { grid-template-columns: 1fr; } }
.side h3 { margin: 0 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.side figure { width: 100%; margin-bottom: 10px; }
.slider { position: relative; line-height: 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; max-width: 520px; margin-top: 14px; }
.slider img { width: 100%; display: block; }
.slider .after { position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 0 0 50%); }
.slider input { width: 100%; max-width: 520px; display: block; }
.tag-measured { color: var(--high); font-weight: 600; } .tag-judged { color: var(--medium); font-weight: 600; }
`;

const COMPARE_SCRIPT = `
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
  for (const range of document.querySelectorAll("input[data-slider]")) {
    const after = document.getElementById(range.dataset.slider);
    const set = () => { after.style.clipPath = "inset(0 0 0 " + range.value + "%)"; };
    range.addEventListener("input", set);
    set();
  }
})();
`;

/**
 * Renders the reports again from the results saved in a capture folder, with no
 * calls to the critic: critique.html and critique.md from critique.json, and
 * compare.html from compare.json when the before capture can be found. Returns the
 * files written.
 */
export async function rerender(dir, { renderCritique }) {
  const { readFile, writeFile } = await import("node:fs/promises");
  const read = async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8"));
  const written = [];
  let manifest = null;
  try {
    manifest = await read("manifest.json");
  } catch {
    throw new Error(`${dir} has no manifest.json; point --in at a capture folder`);
  }
  try {
    const result = await read("critique.json");
    await writeFile(path.join(dir, "critique.html"), renderCritiqueHTML(result, manifest, dir));
    await writeFile(path.join(dir, "critique.md"), renderCritique(result));
    written.push(path.join(dir, "critique.html"), path.join(dir, "critique.md"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  try {
    const result = await read("compare.json");
    const beforeDir = result.before?.dir;
    if (beforeDir) {
      const before = JSON.parse(await readFile(path.join(beforeDir, "manifest.json"), "utf8"));
      await writeFile(path.join(dir, "compare.html"), renderCompareHTML(result, before, manifest, dir));
      written.push(path.join(dir, "compare.html"));
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!written.length) throw new Error(`${dir} has no critique.json or compare.json to render`);
  return written;
}

/** The before and after comparison as one HTML page. */
export function renderCompareHTML(result, before, after, dir) {
  const find = (manifest, r) => (manifest?.shots ?? []).find((s) => s.route === r.route && s.viewport === r.viewport);
  const list = (title, items, render = (x) => esc(x)) => (items?.length ? `<h3>${title}</h3><ul class="plain">${items.map((x) => `<li>${render(x)}</li>`).join("")}</ul>` : "");
  const parts = [];
  const usage = result.usage ? ` &middot; ${result.usage.calls} calls, about $${result.usage.estimatedCostUSD?.toFixed?.(4) ?? "?"}` : "";
  parts.push(`<header class="top"><div><h1>UI comparison: ${esc(result.before.label)} vs ${esc(result.after.label)}</h1><p class="meta">${esc(result.after.base)} &middot; ${esc(result.model)} &middot; compared ${esc(result.comparedAt)}${usage}</p></div><button class="theme" type="button">Dark</button></header>`);
  const rows = result.results.map((r) => `<li><a href="#c-${esc(routeSlug(r.route))}-${esc(r.viewport)}">${esc(r.route)} at ${esc(r.viewport)}</a>: <span class="verdict v-${esc(r.verdict)}">${esc(r.verdict)}</span>${r.regressed?.length ? `, ${r.regressed.length} regressed` : ""}${r.improved?.length ? `, ${r.improved.length} improved` : ""}</li>`);
  const skipped = (result.skipped ?? []).map((s) => `<li>${esc(s.route)} at ${esc(s.viewport)}: not compared, ${esc(s.reason)}</li>`);
  parts.push(`<section class="overall"><div></div><div><ul class="plain">${rows.join("")}${skipped.join("")}</ul></div></section>`);
  result.results.forEach((r, i) => {
    const b = find(before, r);
    const a = find(after, r);
    const kinds = new Map((r.regressed_detail ?? []).map((d) => [d.text, d.kind]));
    const side = (title, shot) =>
      `<div class="side"><h3>${title}</h3>${shot ? shotImages(shot).map((img) => figure(dir, img, shot.viewport, [])).join("") : '<p class="empty">No capture.</p>'}</div>`;
    const slider = b && a ? `<div class="slider"><img src="${esc(relativeSrc(dir, b.fold))}" alt="before, first screen"><div class="after" id="after-${i}"><img src="${esc(relativeSrc(dir, a.fold))}" alt="after, first screen"></div></div><input type="range" min="0" max="100" value="50" data-slider="after-${i}" aria-label="Reveal before and after">` : "";
    parts.push(`<section class="pair" id="c-${esc(routeSlug(r.route))}-${esc(r.viewport)}">
<div class="page-head"><h2>${esc(r.route)} at ${esc(r.viewport)}</h2> <span class="verdict v-${esc(r.verdict)}">${esc(r.verdict)}</span></div>
${slider}
${list("Improved", r.improved)}
${list("Regressed, confirmed on a second look", r.regressed, (t) => `${kinds.has(t) ? `<span class="tag-${esc(kinds.get(t))}">[${esc(kinds.get(t))}]</span> ` : ""}${esc(t)}`)}
${list("Reported but not confirmed", r.unconfirmed_regressions, (u) => `${esc(u.text)} <span class="tag">(${esc(u.reason)})</span>`)}
${list("Still open", r.still_open)}
${r.notes ? `<p class="facts">Notes: ${esc(r.notes)}</p>` : ""}
<div class="sides">${side("Before", b)}${side("After", a)}</div>
</section>`);
  });
  return `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>UI comparison: ${esc(result.before.label)} vs ${esc(result.after.label)}</title><style>${STYLE}${COMPARE_STYLE}</style></head>
<body><main>${parts.join("\n")}</main><script>${COMPARE_SCRIPT}</script></body></html>
`;
}
