import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseColor, toHex, deltaE, simulateVision, chroma, VISION_SIMULATIONS } from "./color.mjs";

/**
 * The design-system lint: what a site's pages actually use for colour, type,
 * spacing, radius and shadow, measured in the browser, set against the tokens it
 * declares. Everything here is deterministic and free (no critic is called), so it
 * can run on every capture and in CI. It reports drift (a value that is almost a
 * token), sprawl (too many sizes, families, radii, shadows), values off the spacing
 * grid, cramped and over-long lines, and proposes the consolidated scales.
 */

export const LINT_DEFAULTS = {
  spacingBase: 4,
  maxFamilies: 2,
  maxSizes: 8,
  maxRadii: 4,
  maxShadows: 3,
  nearDelta: 3,
  tokens: undefined,
};

const KINDS = ["colors", "backgrounds", "borders", "families", "sizes", "weights", "lineHeights", "letterSpacing", "radii", "shadows", "spacing", "tightBodyText"];
const COLOR_KINDS = ["colors", "backgrounds", "borders"];

/** A colour value as #rrggbb, with the opacity after it when it is translucent. */
export function colorKey(value) {
  const c = parseColor(value);
  if (!c) return String(value);
  return c.a < 1 ? `${toHex(c.rgb)} at ${Math.round(c.a * 100)}%` : toHex(c.rgb);
}

/** Merges the inventories of every page and viewport, summing counts and noting the pages. */
export function mergeInventories(items) {
  const out = { elements: 0, tokens: {}, longLines: [] };
  for (const kind of KINDS) out[kind] = new Map();
  for (const { route, viewport, styles } of items) {
    if (!styles) continue;
    out.elements += styles.elements ?? 0;
    Object.assign(out.tokens, styles.tokens ?? {});
    for (const l of styles.longLines ?? []) out.longLines.push({ ...l, page: route, viewport });
    for (const kind of KINDS) {
      for (const e of styles[kind] ?? []) {
        const key = COLOR_KINDS.includes(kind) ? colorKey(e.value) : String(e.value);
        const m = out[kind].get(key) ?? { value: key, count: 0, samples: [], pages: [] };
        m.count += e.count ?? 0;
        if (!m.pages.includes(route)) m.pages.push(route);
        for (const s of e.samples ?? []) if (m.samples.length < 3 && !m.samples.includes(s)) m.samples.push(s);
        out[kind].set(key, m);
      }
    }
  }
  return out;
}

/** Flattens a tokens file: a flat map, or nested W3C design tokens with $value. */
export function flattenTokens(data, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && "$value" in value) out[name] = String(value.$value);
    else if (value && typeof value === "object") Object.assign(out, flattenTokens(value, name));
    else out[name] = String(value);
  }
  return out;
}

/** Splits tokens into colours and lengths (px, or rem at 16px), keeping their names. */
export function classifyTokens(tokens) {
  const colors = [];
  const lengths = [];
  for (const [name, raw] of Object.entries(tokens ?? {})) {
    const value = String(raw).trim();
    const c = parseColor(value);
    if (c) {
      if (c.a >= 1) colors.push({ name, hex: toHex(c.rgb), rgb: c.rgb });
      continue;
    }
    const px = /^(-?[\d.]+)px$/.exec(value);
    const rem = /^(-?[\d.]+)rem$/.exec(value);
    if (px) lengths.push({ name, px: Number(px[1]) });
    else if (rem) lengths.push({ name, px: Number(rem[1]) * 16 });
  }
  return { colors, lengths };
}

const px = (value) => {
  const m = /^(-?[\d.]+)px$/.exec(String(value).trim());
  return m ? Number(m[1]) : null;
};

const top = (list, n = 8) => list.slice(0, n).map((e) => ({ value: e.value, count: e.count, pages: e.pages, samples: e.samples, ...(e.note ? { note: e.note } : {}) }));

/**
 * The modular type scale that fits the sizes in use best: a base (the most used
 * size) times a ratio to whole powers, judged by the usage-weighted relative error.
 */
export function fitTypeScale(sizes) {
  const used = sizes.map((s) => ({ px: px(s.value), count: s.count })).filter((s) => s.px);
  if (!used.length) return null;
  const base = used.slice().sort((a, b) => b.count - a.count)[0].px;
  let best = null;
  for (const ratio of [1.125, 1.2, 1.25, 1.333, 1.414, 1.5]) {
    const steps = [];
    for (let k = -2; k <= 6; k += 1) steps.push(Math.round(base * ratio ** k * 2) / 2);
    let error = 0;
    let weight = 0;
    const mapping = [];
    for (const s of used) {
      const step = steps.reduce((a, b) => (Math.abs(b - s.px) < Math.abs(a - s.px) ? b : a));
      error += (Math.abs(step - s.px) / s.px) * s.count;
      weight += s.count;
      mapping.push({ from: `${s.px}px`, to: `${step}px` });
    }
    const score = error / weight;
    if (!best || score < best.score) best = { ratio, base: `${base}px`, steps: steps.filter((v, i) => steps.indexOf(v) === i).map((v) => `${v}px`), mapping, score: Math.round(score * 1000) / 1000 };
  }
  return best;
}

/** Groups colours whose difference is under the threshold, most used first. */
export function clusterColors(entries, threshold) {
  const clusters = [];
  for (const e of entries) {
    const c = parseColor(e.value.split(" ")[0]);
    if (!c) continue;
    const home = clusters.find((cl) => deltaE(cl.rgb, c.rgb) < threshold);
    if (home) home.members.push(e);
    else clusters.push({ rgb: c.rgb, hex: toHex(c.rgb), members: [e] });
  }
  return clusters;
}

/** Runs every rule over a merged inventory. */
export function lintInventory(inv, options = {}) {
  const o = { ...LINT_DEFAULTS, ...options };
  const tokens = { ...inv.tokens, ...(o.extraTokens ?? {}) };
  const { colors: tokenColors, lengths: tokenLengths } = classifyTokens(tokens);
  const findings = [];
  const metrics = {};

  // Colour: every colour used for text, backgrounds and borders.
  const usedColors = new Map();
  for (const kind of COLOR_KINDS) {
    for (const e of inv[kind].values()) {
      const m = usedColors.get(e.value) ?? { value: e.value, count: 0, pages: [], samples: [] };
      m.count += e.count;
      for (const p of e.pages) if (!m.pages.includes(p)) m.pages.push(p);
      for (const s of e.samples) if (m.samples.length < 3 && !m.samples.includes(s)) m.samples.push(s);
      usedColors.set(e.value, m);
    }
  }
  const colorList = Array.from(usedColors.values()).sort((a, b) => b.count - a.count);
  const opaque = colorList.filter((e) => !e.value.includes(" at "));
  metrics.colorsUsed = colorList.length;
  if (tokenColors.length) {
    const near = [];
    const off = [];
    let onToken = 0;
    let total = 0;
    for (const e of opaque) {
      const rgb = parseColor(e.value).rgb;
      total += e.count;
      // A browser computes a token's colour exactly, so only an exact match is the
      // token. An invisible difference is still drift: a typed value, not the token.
      if (tokenColors.some((t) => t.hex === e.value)) {
        onToken += e.count;
        continue;
      }
      const nearest = tokenColors.map((t) => ({ t, d: deltaE(rgb, t.rgb) })).sort((a, b) => a.d - b.d)[0];
      if (nearest.d < o.nearDelta) near.push({ ...e, note: `almost ${nearest.t.name} (${nearest.t.hex}), a difference of ${Math.round(nearest.d * 10) / 10}` });
      else off.push({ ...e, note: `nearest token ${nearest.t.name} (${nearest.t.hex}) is ${Math.round(nearest.d)} away` });
    }
    metrics.colorTokens = tokenColors.length;
    metrics.tokenCoverage = total ? Math.round((onToken / total) * 100) / 100 : null;
    if (near.length) {
      findings.push({
        rule: "color-near-token",
        severity: "high",
        title: `${near.length} colour${near.length === 1 ? " is" : "s are"} almost a token but not quite`,
        detail: "A value a hair away from a token is drift: someone typed the colour instead of using the token, so a theme change will miss it.",
        values: top(near),
        fix: "Replace each with the token it is almost equal to.",
      });
    }
    if (off.length) {
      findings.push({
        rule: "color-off-palette",
        severity: off.length > 4 ? "medium" : "low",
        title: `${off.length} colour${off.length === 1 ? "" : "s"} used that no token defines`,
        detail: "Colours outside the palette, by usage.",
        values: top(off),
        fix: "Map each to a palette token, or add a token if it is a deliberate new role.",
      });
    }
  } else if (opaque.length > 12) {
    findings.push({
      rule: "color-no-tokens",
      severity: "medium",
      title: `${opaque.length} distinct colours and no colour tokens`,
      detail: "Without tokens every colour is a one-off, and they drift.",
      values: top(opaque),
      fix: "Adopt the proposed palette below as tokens.",
    });
  }
  const pairs = clusterColors(opaque, o.nearDelta).filter((cl) => cl.members.length > 1);
  if (pairs.length && !tokenColors.length) {
    findings.push({
      rule: "color-near-duplicates",
      severity: "medium",
      title: `${pairs.length} group${pairs.length === 1 ? "" : "s"} of colours that look the same`,
      detail: "Colours this close cannot be told apart; one of each group is drift.",
      values: pairs.slice(0, 8).map((cl) => ({ value: cl.members.map((m) => m.value).join(" vs "), count: cl.members.reduce((s, m) => s + m.count, 0), pages: cl.members[0].pages, samples: cl.members[0].samples })),
      fix: "Keep the most used colour of each group.",
    });
  }

  // Colour vision: colours clearly different to most people that collapse into one
  // for someone with a colour-vision deficiency. Greys carry no hue, so a pair needs
  // at least one colourful member.
  const hues = opaque.slice(0, 16).map((e) => ({ ...e, rgb: parseColor(e.value).rgb })).filter((e) => chroma(e.rgb) > 15);
  const collapses = [];
  for (let i = 0; i < hues.length; i += 1) {
    for (let j = i + 1; j < hues.length; j += 1) {
      const normal = deltaE(hues[i].rgb, hues[j].rgb);
      if (normal < 12) continue;
      for (const type of VISION_SIMULATIONS) {
        const seen = deltaE(simulateVision(hues[i].rgb, type), simulateVision(hues[j].rgb, type));
        // Collapsed: hard to see apart, and most of the difference gone.
        if (seen < 8 && seen < normal * 0.3) {
          collapses.push({
            value: `${hues[i].value} and ${hues[j].value}`,
            count: Math.min(hues[i].count, hues[j].count),
            pages: hues[i].pages.filter((p) => hues[j].pages.includes(p)),
            samples: [hues[i].samples[0], hues[j].samples[0]].filter(Boolean),
            note: `look alike with ${type} (a difference of ${Math.round(seen * 10) / 10}, against ${Math.round(normal)} for most people)`,
          });
          break;
        }
      }
    }
  }
  if (collapses.length) {
    findings.push({
      rule: "color-vision",
      severity: "medium",
      title: `${collapses.length} pair${collapses.length === 1 ? "" : "s"} of colours that some readers cannot tell apart`,
      detail: "About one in twelve men has a colour-vision deficiency. When colour alone separates two meanings (error and success, sale and regular), these readers lose the difference.",
      values: top(collapses),
      fix: "Where the pair carries meaning, add a second cue: an icon, a label, a pattern or a weight change.",
    });
  }

  // Type.
  const sizes = Array.from(inv.sizes.values()).sort((a, b) => b.count - a.count);
  metrics.fontSizes = sizes.length;
  const scale = fitTypeScale(sizes);
  const sizeTokens = tokenLengths.filter((t) => /font|text|size|fs|type/i.test(t.name)).map((t) => t.px);
  if (sizeTokens.length) {
    const off = sizes.filter((s) => !sizeTokens.includes(px(s.value)));
    if (off.length) {
      findings.push({ rule: "type-off-scale", severity: "medium", title: `${off.length} font size${off.length === 1 ? "" : "s"} not on the type scale`, detail: `The scale tokens are ${sizeTokens.map((v) => `${v}px`).join(", ")}.`, values: top(off), fix: "Use the nearest scale token." });
    }
  }
  if (sizes.length > o.maxSizes) {
    findings.push({ rule: "type-sprawl", severity: "medium", title: `${sizes.length} distinct font sizes`, detail: `More than ${o.maxSizes} sizes reads as no hierarchy at all.`, values: top(sizes, 12), fix: scale ? `Consolidate onto a ${scale.ratio} scale from ${scale.base}: ${scale.steps.join(", ")}.` : "Consolidate onto a modular scale." });
  }
  const families = Array.from(inv.families.values()).sort((a, b) => b.count - a.count);
  metrics.families = families.length;
  if (families.length > o.maxFamilies) {
    findings.push({ rule: "type-families", severity: "medium", title: `${families.length} font families`, detail: `More than ${o.maxFamilies} families weakens the voice and costs load time.`, values: top(families), fix: "Keep one family for text and at most one for display." });
  }
  const tight = Array.from(inv.tightBodyText.values());
  if (tight.length) {
    findings.push({ rule: "type-line-height", severity: "medium", title: "Body text with cramped line height", detail: "Paragraph text at a line height under 1.3 is hard to read (WCAG 1.4.12 asks that 1.5 not break the layout).", values: top(tight), fix: "Set body text to a line height of 1.4 to 1.6." });
  }
  if (inv.longLines.length) {
    findings.push({
      rule: "type-line-length",
      severity: "low",
      title: `${inv.longLines.length} block${inv.longLines.length === 1 ? "" : "s"} of text with lines over 90 characters`,
      detail: "Lines past about 75 characters make the eye lose its place.",
      values: inv.longLines.slice(0, 8).map((l) => ({ value: `${l.charsPerLine} characters per line`, count: 1, pages: [l.page], samples: [l.sample] })),
      fix: "Cap text blocks at about 65ch (max-width: 65ch).",
    });
  }

  // Spacing.
  const spacing = Array.from(inv.spacing.values()).map((e) => ({ ...e, px: px(e.value) })).filter((e) => e.px !== null);
  // Within half a pixel of the grid is on it: em maths gives values like 16.08px.
  const offBy = (v) => {
    const r = Math.abs(v) % o.spacingBase;
    return Math.min(r, o.spacingBase - r);
  };
  const offGrid = spacing.filter((e) => Math.abs(e.px) > 2 && offBy(e.px) > 0.5).sort((a, b) => b.count - a.count);
  metrics.spacingValues = spacing.length;
  metrics.offGridSpacing = offGrid.length;
  if (offGrid.length) {
    findings.push({
      rule: "spacing-off-grid",
      severity: offGrid.length > 6 ? "medium" : "low",
      title: `${offGrid.length} spacing value${offGrid.length === 1 ? "" : "s"} off the ${o.spacingBase}px grid`,
      detail: "Padding, margins and gaps that are not multiples of the base break the rhythm.",
      values: top(offGrid.map((e) => ({ ...e, note: `nearest on the grid: ${Math.round(e.px / o.spacingBase) * o.spacingBase}px` })), 12),
      fix: `Snap each to the nearest multiple of ${o.spacingBase}px.`,
    });
  }

  // Radius and shadow.
  const radii = Array.from(inv.radii.values()).filter((e) => !/%$/.test(e.value) && (px(e.value) ?? 0) < 999).sort((a, b) => b.count - a.count);
  metrics.radii = radii.length;
  const radiusTokens = tokenLengths.filter((t) => /radius|round/i.test(t.name)).map((t) => t.px);
  const offRadius = radiusTokens.length ? radii.filter((r) => !radiusTokens.includes(px(r.value))) : [];
  if (radii.length > o.maxRadii || offRadius.length) {
    findings.push({
      rule: "radius-drift",
      severity: "low",
      title: offRadius.length ? `${offRadius.length} corner radi${offRadius.length === 1 ? "us is" : "i are"} not a radius token` : `${radii.length} different corner radii`,
      detail: "Corners that almost match look like mistakes.",
      values: top(offRadius.length ? offRadius : radii),
      fix: radiusTokens.length ? `Use the radius tokens (${radiusTokens.map((v) => `${v}px`).join(", ")}).` : "Pick two or three radii (small, medium, pill) and use only those.",
    });
  }
  const shadows = Array.from(inv.shadows.values()).sort((a, b) => b.count - a.count);
  metrics.shadows = shadows.length;
  if (shadows.length > o.maxShadows) {
    findings.push({ rule: "shadow-drift", severity: "low", title: `${shadows.length} different shadows`, detail: "Elevation reads as a system when there are only a few levels.", values: top(shadows), fix: "Define two or three elevation levels and reuse them." });
  }

  // The proposal: what the scales would be if consolidated.
  const palette = clusterColors(opaque, 5).slice(0, 12).map((cl) => ({ color: cl.hex, uses: cl.members.reduce((s, m) => s + m.count, 0), merges: cl.members.map((m) => m.value) }));
  const snapped = Array.from(new Set(spacing.map((e) => Math.round(Math.abs(e.px) / o.spacingBase) * o.spacingBase).filter((v) => v > 0))).sort((a, b) => a - b);
  const proposal = {
    palette,
    typeScale: scale,
    spacing: snapped.map((v) => `${v}px`),
    radii: Array.from(new Set(radii.map((r) => Math.max(4, Math.round((px(r.value) ?? 0) / 4) * 4)))).sort((a, b) => a - b).map((v) => `${v}px`),
  };
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { metrics, tokens: { colors: tokenColors.length, lengths: tokenLengths.length }, findings, proposal };
}

/**
 * Which theme a viewport shows the authored styles in, or null when its styles are
 * not the design as written: forced colours replace them with system colours, and
 * text spacing, zoom and colour-vision variants only repeat or stretch them.
 */
export function lintScheme(vp = {}) {
  if (vp.forcedColors || vp.textSpacing || vp.vision || vp.zoom > 1) return null;
  return vp.colorScheme === "dark" ? "dark" : "light";
}

/**
 * Loads the style inventories of a capture and lints them, one theme at a time: a
 * dark theme has its own token values, so it is checked against those and its
 * findings say so.
 */
export async function lintCapture(dir, options = {}) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const items = [];
  for (const shot of manifest.shots ?? []) {
    if (!shot.styles) continue;
    const scheme = lintScheme(manifest.viewports?.[shot.viewport]);
    if (!scheme) continue;
    try {
      items.push({ route: shot.route, viewport: shot.viewport, scheme, styles: JSON.parse(await readFile(shot.styles, "utf8")) });
    } catch {
      // a shot whose inventory could not be read is left out
    }
  }
  if (!items.length) {
    throw new Error(manifest.platform && manifest.platform !== "web" ? "the design-system lint reads computed styles, which only a web capture has" : `${dir} has no style inventories; capture it again with this version`);
  }
  let extraTokens = {};
  if (options.tokens) extraTokens = flattenTokens(JSON.parse(await readFile(path.resolve(options.tokens), "utf8")));
  const light = items.filter((i) => i.scheme === "light");
  const dark = items.filter((i) => i.scheme === "dark");
  const main = lintInventory(mergeInventories(light.length ? light : dark), { ...options, extraTokens });
  if (light.length && dark.length) {
    // The dark theme against its own tokens; its sprawl rules repeat the light ones,
    // so only its colour findings are added.
    const night = lintInventory(mergeInventories(dark), { ...options, extraTokens: {} });
    for (const f of night.findings.filter((x) => x.rule.startsWith("color"))) main.findings.push({ ...f, rule: `${f.rule}-dark`, title: `Dark theme: ${f.title}` });
    main.metrics.darkTokenCoverage = night.metrics.tokenCoverage ?? null;
  }
  const order = { high: 0, medium: 1, low: 2 };
  main.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  // The custom properties the pages declare, by name, for a try-on to override.
  const declared = Object.fromEntries(Object.entries(mergeInventories(light.length ? light : dark).tokens).slice(0, 150));
  return { tool: "ui-critic", kind: "lint", base: manifest.base, label: manifest.label, pages: Array.from(new Set(items.map((i) => i.route))), generatedAt: new Date().toISOString(), ...main, tokensDeclared: declared };
}

/** The lint as Markdown. */
export function renderLint(r) {
  const lines = [`# Design-system lint: ${r.label} (${r.base})`, ""];
  const m = r.metrics;
  lines.push(`Pages ${r.pages.length}; colours used ${m.colorsUsed}${m.colorTokens ? ` against ${m.colorTokens} colour tokens (token coverage ${Math.round((m.tokenCoverage ?? 0) * 100)}%)` : ", no colour tokens"}; font sizes ${m.fontSizes}; families ${m.families}; radii ${m.radii}; shadows ${m.shadows}; spacing values off the grid ${m.offGridSpacing} of ${m.spacingValues}.`, "");
  if (!r.findings.length) lines.push("No findings: the pages keep to their tokens and scales.", "");
  for (const f of r.findings) {
    lines.push(`## [${f.severity}] ${f.title}`, f.detail, "");
    for (const v of f.values) lines.push(`- \`${v.value}\` used ${v.count}x${v.note ? `, ${v.note}` : ""}${v.samples?.length ? `, e.g. ${v.samples.join("; ")}` : ""}${v.pages?.length ? ` (on ${v.pages.join(", ")})` : ""}`);
    lines.push("", `Do: ${f.fix}`, "");
  }
  const p = r.proposal;
  lines.push("## Proposed scales", "");
  if (p.palette.length) lines.push(`Palette: ${p.palette.map((c) => `${c.color} (${c.uses})`).join(", ")}`);
  if (p.typeScale) lines.push(`Type: ratio ${p.typeScale.ratio} from ${p.typeScale.base}: ${p.typeScale.steps.join(", ")}`);
  if (p.spacing.length) lines.push(`Spacing: ${p.spacing.join(", ")}`);
  if (p.radii.length) lines.push(`Radii: ${p.radii.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

/** The lint in a few lines, as measured facts for the critic's site-level pass. */
export function lintForPrompt(r, limit = 1800) {
  const parts = [`colours used ${r.metrics.colorsUsed}${r.metrics.colorTokens ? `, token coverage ${Math.round((r.metrics.tokenCoverage ?? 0) * 100)}%` : ""}; font sizes ${r.metrics.fontSizes}; families ${r.metrics.families}; radii ${r.metrics.radii}; shadows ${r.metrics.shadows}; spacing off the grid ${r.metrics.offGridSpacing}`];
  for (const f of r.findings) parts.push(`${f.title}: ${f.values.slice(0, 4).map((v) => `${v.value}${v.note ? ` (${v.note})` : ""}`).join(", ")}`);
  const s = parts.join(". ");
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}
