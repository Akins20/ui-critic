import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "./provider.mjs";
import { imagePart, text } from "./parts.mjs";
import { requireBrief, contextSections } from "./brief.mjs";
import { loadDecisions, decisionsSection } from "./decisions.mjs";
import { briefSection } from "./critique.mjs";
import { routeSlug } from "./capture.mjs";
import { esc, relativeSrc } from "./html.mjs";
import { decodePNG } from "./png.mjs";
import { parseColor, toHex, deltaE } from "./color.mjs";

/**
 * Fidelity: what was built against what was designed. The design is read from Figma
 * over the REST API, which gives both a picture of each frame and the frame's real
 * numbers (fills, font sizes, corner radii, auto-layout spacing, shadows). So the
 * check is two things at once:
 *   measured  the design's values against the values the page actually renders, the
 *             same inventory the design-system lint reads, so drift is a fact
 *   judged    the frame and the screen side by side, for what differs that matters
 * A token goes in FIGMA_TOKEN. Nothing is written back to Figma; the file is read.
 */

const API = "https://api.figma.com/v1";

/** A Figma REST client. `fetchImpl` is injectable so the tool can be tested without the network. */
export function figmaClient({ token, fetch: fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error("no Figma token: export FIGMA_TOKEN with a personal access token that can read the file");
  const call = async (url) => {
    const res = await fetchImpl(url, { headers: { "X-Figma-Token": token } });
    if (res.status === 403) throw new Error("Figma refused the token (403): it is wrong, expired, or has no access to this file");
    if (res.status === 404) throw new Error("Figma has no such file (404): check the file key in the share link, between /file/ or /design/ and the name");
    if (res.status === 429) throw new Error("Figma is rate limiting this token (429): wait and run again");
    if (!res.ok) throw new Error(`Figma ${res.status} for ${String(url).replace(API, "")}`);
    const body = await res.json();
    if (body.err || body.error) throw new Error(`Figma: ${body.err || body.message || "error"}`);
    return body;
  };
  return {
    // Only the top-level frames are needed to pair screens, and a whole design file
    // can be many megabytes; the matched frames are fetched in full by `nodes`.
    file: (key) => call(`${API}/files/${encodeURIComponent(key)}?depth=2`),
    nodes: (key, ids) => call(`${API}/files/${encodeURIComponent(key)}/nodes?ids=${ids.map(encodeURIComponent).join(",")}`),
    images: async (key, ids, { scale = 2, format = "png" } = {}) => (await call(`${API}/images/${encodeURIComponent(key)}?ids=${ids.map(encodeURIComponent).join(",")}&format=${format}&scale=${scale}`)).images ?? {},
    download: async (url) => {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`could not download a rendered frame (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** The file key out of a Figma URL, or the key itself if that is what was given. */
export function fileKey(input) {
  const match = String(input).match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/);
  return match ? match[1] : String(input).trim();
}

/** The top-level frames of every page in a file: what a designer hands over. */
export function collectFrames(document) {
  const frames = [];
  for (const page of document?.children ?? []) {
    if (page.type !== "CANVAS") continue;
    for (const node of page.children ?? []) {
      if (!/^(FRAME|COMPONENT|COMPONENT_SET|INSTANCE)$/.test(node.type)) continue;
      const box = node.absoluteBoundingBox ?? {};
      frames.push({ id: node.id, name: node.name, page: page.name, width: Math.round(box.width ?? 0), height: Math.round(box.height ?? 0) });
    }
  }
  return frames;
}

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

/** The words a route is known by, so "/" finds a frame called Home. */
function routeWords(route) {
  const parts = words(route);
  if (!parts.length) return ["home", "index", "landing", "homepage"];
  return parts;
}

/** Which viewport a frame is drawn for, from its name or, failing that, its width. */
export function frameViewport(frame, viewports) {
  const name = words(frame.name);
  for (const vp of Object.keys(viewports ?? {})) {
    if (name.includes(vp.toLowerCase())) return vp;
  }
  if (name.includes("mobile") || name.includes("phone")) return "mobile";
  if (name.includes("desktop") || name.includes("web")) return "desktop";
  if (!frame.width) return null;
  return frame.width >= 1000 ? "desktop" : frame.width <= 640 ? "mobile" : null;
}

/**
 * Pairs captured screens with design frames. An explicit map in the config wins
 * ("/": "12:34", or "/@mobile": "12:35"); otherwise a frame is matched when its name
 * carries all of the route's words, and the viewport is read from the frame's name or
 * its width. What stays unpaired on either side is returned, never silently dropped.
 */
export function pairFrames(frames, shots, explicit = {}) {
  const pairs = [];
  const usedFrames = new Set();
  const byId = new Map(frames.map((f) => [f.id, f]));
  for (const shot of shots) {
    const route = shot.path ?? shot.route;
    const keyed = explicit[`${route}@${shot.viewport}`] ?? explicit[route];
    let frame = keyed ? byId.get(keyed) : null;
    if (keyed && !frame) {
      pairs.push({ route, viewport: shot.viewport, shot, error: `the config points ${route} at frame ${keyed}, which is not a top-level frame in the file` });
      continue;
    }
    if (!frame) {
      const want = routeWords(route);
      const candidates = frames.filter((f) => {
        const name = words(f.name);
        return want.some((w) => name.includes(w));
      });
      frame = candidates.find((f) => frameViewport(f, null) === shot.viewport) ?? candidates.find((f) => !frameViewport(f, null)) ?? null;
    }
    if (!frame) continue;
    usedFrames.add(frame.id);
    pairs.push({ route, viewport: shot.viewport, shot, frame });
  }
  return { pairs, unpairedFrames: frames.filter((f) => !usedFrames.has(f.id)) };
}

const px = (n) => `${Math.round(Number(n) * 100) / 100}px`;

/** A Figma paint as a CSS colour string, so design and browser values compare directly. */
export function paintColor(paint, nodeOpacity = 1) {
  if (!paint || paint.visible === false || paint.type !== "SOLID" || !paint.color) return null;
  const { r, g, b, a = 1 } = paint.color;
  const alpha = Math.round(a * (paint.opacity ?? 1) * nodeOpacity * 100) / 100;
  if (alpha <= 0.02) return null;
  const rgb = [r, g, b].map((v) => Math.round(v * 255));
  return alpha >= 1 ? `rgb(${rgb.join(", ")})` : `rgba(${rgb.join(", ")}, ${alpha})`;
}

/**
 * The design's style inventory, in the same shape the browser records for a page:
 * every colour, family, size, weight, line height, radius, shadow and spacing the
 * frames use, with how often and a few samples of where.
 */
export function designInventory(roots) {
  const tallies = {};
  let nodes = 0;
  const add = (kind, value, where) => {
    if (!value) return;
    const map = (tallies[kind] = tallies[kind] || new Map());
    const entry = map.get(value) || { value, count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3) entry.samples.push(where);
    map.set(value, entry);
  };
  const walk = (node, trail) => {
    if (!node || node.visible === false) return;
    nodes += 1;
    const where = `${node.type === "TEXT" ? "text" : (node.type ?? "node").toLowerCase()} "${String(node.name ?? "").slice(0, 28)}"${trail ? ` in ${trail}` : ""}`;
    const opacity = node.opacity ?? 1;
    const fill = (node.fills ?? []).map((p) => paintColor(p, opacity)).find(Boolean);
    if (node.type === "TEXT") {
      const s = node.style ?? {};
      if (fill) add("colors", fill, where);
      if (s.fontFamily) add("families", s.fontFamily, where);
      if (s.fontSize) add("sizes", px(s.fontSize), where);
      if (s.fontWeight) add("weights", String(s.fontWeight), where);
      const ratio = s.lineHeightPx && s.fontSize ? s.lineHeightPx / s.fontSize : s.lineHeightPercentFontSize ? s.lineHeightPercentFontSize / 100 : null;
      if (ratio) add("lineHeights", String(Math.round(ratio * 100) / 100), where);
      if (s.letterSpacing) add("letterSpacing", px(s.letterSpacing), where);
    } else if (fill) {
      add("backgrounds", fill, where);
    }
    const stroke = (node.strokes ?? []).map((p) => paintColor(p, opacity)).find(Boolean);
    if (stroke && (node.strokeWeight ?? 1) > 0) add("borders", stroke, where);
    const radius = node.cornerRadius ?? (Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii.find((r) => r > 0) : null);
    if (radius) add("radii", px(radius), where);
    for (const effect of node.effects ?? []) {
      if (effect.visible === false || !/SHADOW/.test(effect.type ?? "")) continue;
      const color = paintColor({ type: "SOLID", color: effect.color }, 1);
      add("shadows", `${px(effect.offset?.x ?? 0)} ${px(effect.offset?.y ?? 0)} ${px(effect.radius ?? 0)}${effect.spread ? ` ${px(effect.spread)}` : ""} ${color ?? ""}`.trim(), where);
    }
    if (node.itemSpacing) add("spacing", px(node.itemSpacing), where);
    for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
      if (node[side]) add("spacing", px(node[side]), where);
    }
    const next = node.type === "TEXT" ? trail : `${String(node.name ?? "").slice(0, 20)}`;
    for (const child of node.children ?? []) walk(child, next || trail);
  };
  for (const root of roots) walk(root, "");
  const list = (kind, cap) => Array.from((tallies[kind] || new Map()).values()).sort((a, b) => b.count - a.count).slice(0, cap);
  const out = { nodes };
  for (const kind of ["colors", "backgrounds", "borders", "families", "sizes", "weights", "lineHeights", "letterSpacing", "radii", "shadows", "spacing"]) out[kind] = list(kind, kind === "spacing" ? 80 : 50);
  return out;
}

const LENGTH_KINDS = new Set(["sizes", "radii", "spacing", "letterSpacing"]);
const COLOR_KINDS = new Set(["colors", "backgrounds", "borders"]);

/**
 * Whether a design value and a built value are the same thing, by kind. The
 * tolerance is given by the caller, because "the same value" and "near enough to be
 * that value, typed by hand" are two different questions asked of the same pair.
 */
function sameValue(kind, a, b, tolerance) {
  const d = distanceOf(kind, a, b);
  if (d === null) return false;
  if (COLOR_KINDS.has(kind)) return d <= tolerance.color;
  if (kind === "lineHeights") return d <= tolerance.ratio;
  if (LENGTH_KINDS.has(kind)) return d <= tolerance.length;
  return d === 0;
}

const unitOf = (v) => String(v).trim().match(/[a-z%]*$/i)?.[0] ?? "";

/**
 * How far apart two values of a kind are, or null when they are not comparable at
 * all. A translucent colour and an opaque one are not comparable, because what a
 * translucent panel looks like depends on what is behind it; nor are a percentage
 * and a pixel length, which would otherwise make a 50% radius match a 50px one.
 */
function distanceOf(kind, a, b) {
  if (a === b) return 0;
  if (COLOR_KINDS.has(kind)) {
    const ca = parseColor(a);
    const cb = parseColor(b);
    if (!ca || !cb) return null;
    if (Math.abs((ca.a ?? 1) - (cb.a ?? 1)) > 0.02) return null;
    return deltaE(ca.rgb, cb.rgb);
  }
  if (LENGTH_KINDS.has(kind) || kind === "lineHeights") {
    const na = parseFloat(a);
    const nb = parseFloat(b);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return null;
    if (kind !== "lineHeights" && unitOf(a) !== unitOf(b)) return null;
    return Math.abs(na - nb);
  }
  if (kind === "families") return String(a).toLowerCase() === String(b).toLowerCase() ? 0 : null;
  return null;
}

/**
 * The measured difference between the design's inventory and the built page's: what
 * the design uses that the page never renders, and what the page renders that the
 * design never asked for. Colours compare by CIEDE2000 and lengths within half a
 * pixel, so an invisible rounding is not reported as drift.
 */
export function inventoryDiff(design, built, { nearDelta = 3 } = {}) {
  const kinds = ["colors", "backgrounds", "borders", "families", "sizes", "weights", "lineHeights", "radii", "shadows", "spacing"];
  // The same value, and near enough to be that value typed by hand instead of taken
  // from the design: the second is what makes a difference drift rather than news.
  const same = { color: nearDelta, length: 0.5, ratio: 0.03 };
  const near = { color: 6, length: 2.5, ratio: 0.08 };
  const cap = 12;
  const out = {};
  for (const kind of kinds) {
    const d = design?.[kind] ?? [];
    const b = built?.[kind] ?? [];
    if (!d.length && !b.length) continue;
    const missing = d.filter((entry) => !b.some((other) => sameValue(kind, entry.value, other.value, same)));
    const extra = b.filter((entry) => !d.some((other) => sameValue(kind, entry.value, other.value, same)));
    // Pair the closest first and let each design value be claimed once: a value the
    // design uses can only have been mistyped into one thing, so four built colours
    // all reported as drift from the same one would be three wrong accusations.
    const candidates = [];
    for (const entry of extra) {
      for (const other of d) {
        if (!sameValue(kind, entry.value, other.value, near)) continue;
        candidates.push({ entry, design: other, distance: distanceOf(kind, entry.value, other.value) ?? Infinity });
      }
    }
    candidates.sort((x, y) => x.distance - y.distance);
    const claimedDesign = new Set();
    const claimedBuilt = new Set();
    const drifted = [];
    for (const c of candidates) {
      if (claimedDesign.has(c.design.value) || claimedBuilt.has(c.entry.value)) continue;
      claimedDesign.add(c.design.value);
      claimedBuilt.add(c.entry.value);
      drifted.push({ built: c.entry.value, design: c.design.value, count: c.entry.count, samples: c.entry.samples });
    }
    const restMissing = missing.filter((entry) => !claimedDesign.has(entry.value));
    const restExtra = extra.filter((entry) => !claimedBuilt.has(entry.value));
    out[kind] = {
      missing: restMissing.slice(0, cap),
      extra: restExtra.slice(0, cap),
      drifted: drifted.slice(0, cap),
      more: Math.max(0, restMissing.length - cap) + Math.max(0, restExtra.length - cap) + Math.max(0, drifted.length - cap),
    };
    if (!out[kind].missing.length && !out[kind].extra.length && !out[kind].drifted.length) delete out[kind];
  }
  return out;
}

/**
 * Where a built screen's pixels sit furthest from the design's. The design is scaled
 * to the screen's width and the two are compared block by block. This locates
 * differences; it does not score them, because real content in place of a design's
 * placeholder moves a great many pixels without anything being wrong.
 */
export function frameDiff(designImage, builtImage, { columns = 4 } = {}) {
  if (!designImage?.width || !builtImage?.width) return null;
  const scale = builtImage.width / designImage.width;
  const height = Math.min(builtImage.height, Math.round(designImage.height * scale));
  if (height < 8) return null;
  const block = Math.max(8, Math.round(builtImage.width / columns));
  const rows = Math.max(1, Math.ceil(height / block));
  const step = Math.max(1, Math.round(block / 24));
  const blocks = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const x0 = col * block;
      const y0 = row * block;
      const x1 = Math.min(builtImage.width, x0 + block);
      const y1 = Math.min(height, y0 + block);
      if (x1 <= x0 || y1 <= y0) continue;
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const bo = (y * builtImage.width + x) * 4;
          const dx = Math.min(designImage.width - 1, Math.floor(x / scale));
          const dy = Math.min(designImage.height - 1, Math.floor(y / scale));
          const dof = (dy * designImage.width + dx) * 4;
          const dr = builtImage.data[bo] - designImage.data[dof];
          const dg = builtImage.data[bo + 1] - designImage.data[dof + 1];
          const db = builtImage.data[bo + 2] - designImage.data[dof + 2];
          sum += Math.sqrt(dr * dr + dg * dg + db * db) / 441.67;
          n += 1;
        }
      }
      if (n) blocks.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, difference: Math.round((sum / n) * 1000) / 1000 });
    }
  }
  if (!blocks.length) return null;
  for (const b of blocks) b.where = regionName(b, builtImage.width, height);
  const overall = Math.round((blocks.reduce((t, b) => t + b.difference * b.width * b.height, 0) / blocks.reduce((t, b) => t + b.width * b.height, 0)) * 1000) / 1000;
  const comparedHeight = Math.round((height / builtImage.height) * 100);
  return { overall, comparedHeight, worst: [...blocks].sort((a, b) => b.difference - a.difference).slice(0, 4), blocks };
}

/** Where a block sits, in words a reader can find on the screen. */
function regionName(block, width, height) {
  const third = (v, total, names) => names[Math.min(2, Math.floor((v / total) * 3))];
  const down = third(block.y + block.height / 2, height, ["top", "middle", "lower"]);
  const across = third(block.x + block.width / 2, width, ["left", "centre", "right"]);
  return `${down} ${across}`;
}

const FIDELITY = {
  type: "OBJECT",
  properties: {
    standing: { type: "STRING", enum: ["faithful", "close", "diverged"], description: "how the built screen stands against the design" },
    differences: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          what: { type: "STRING", description: "what differs, naming the element" },
          kind: { type: "STRING", enum: ["spacing", "type", "colour", "layout", "content", "missing", "extra", "state"] },
          severity: { type: "STRING", enum: ["high", "medium", "low"] },
          fix: { type: "STRING", description: "the change to the build that would match the design, specific and testable" },
        },
        required: ["what", "kind", "severity", "fix"],
      },
    },
    not_a_concern: { type: "ARRAY", items: { type: "STRING" }, description: "differences that are fine: real content for placeholder, a state the design does not draw, a deliberate improvement" },
    summary: { type: "STRING", description: "two sentences" },
  },
  required: ["standing", "differences", "not_a_concern", "summary"],
};

const factLine = (diff, pixels) => {
  const bits = [];
  for (const [kind, d] of Object.entries(diff)) {
    const parts = [];
    if (d.drifted.length) parts.push(`${d.drifted.length} drifted (${d.drifted.slice(0, 3).map((x) => `${x.built} where the design has ${x.design}`).join("; ")})`);
    if (d.missing.length) parts.push(`${d.missing.length} in the design but never rendered (${d.missing.slice(0, 3).map((x) => x.value).join(", ")})`);
    if (d.extra.length) parts.push(`${d.extra.length} rendered but not in the design (${d.extra.slice(0, 3).map((x) => x.value).join(", ")})`);
    if (parts.length) bits.push(`${kind}: ${parts.join("; ")}`);
  }
  if (pixels) bits.push(`pixels: the built screen sits furthest from the frame in the ${[...new Set(pixels.worst.map((b) => b.where))].slice(0, 2).join(" and ")}${pixels.comparedHeight < 100 ? `, over the top ${pixels.comparedHeight}% of the screen that the frame covers` : ""}`);
  return bits.length ? bits.join("\n") : "no measured difference in the style inventory";
};

/**
 * Compares a capture with the Figma frames it was built from. Writes fidelity.json,
 * fidelity.md and fidelity.html into the capture folder, and the rendered frames
 * beside them so the report stands on its own.
 */
export async function fidelity({ dir, config, key = null, judge = true, fetch: fetchImpl = undefined, token = process.env.FIGMA_TOKEN }) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const fileRef = fileKey(key ?? config.figma?.file ?? "");
  if (!fileRef) throw new Error('no Figma file: pass --file <key or share link>, or set "figma": { "file": "..." } in the config');
  const api = figmaClient({ token, fetch: fetchImpl });
  const file = await api.file(fileRef);
  const frames = collectFrames(file.document);
  if (!frames.length) throw new Error("that Figma file has no top-level frames to compare with");
  const shots = (manifest.shots ?? []).filter((s) => !s.blocked && !s.scenario && !(manifest.viewports?.[s.viewport]?.a11yPreset));
  const { pairs, unpairedFrames } = pairFrames(frames, shots, config.figma?.frames ?? {});
  const matched = pairs.filter((p) => p.frame);
  if (!matched.length) {
    throw new Error(`no frame matched a captured screen. Frames in the file: ${frames.map((f) => `${f.name} (${f.id})`).slice(0, 12).join(", ")}. Map them with "figma": { "frames": { "/": "<id>" } }`);
  }
  const ids = [...new Set(matched.map((p) => p.frame.id))];
  const [nodeBody, images] = await Promise.all([api.nodes(fileRef, ids), api.images(fileRef, ids, { scale: config.figma?.scale ?? 2 })]);
  const framesDir = path.join(dir, "figma");
  await mkdir(framesDir, { recursive: true });
  const downloaded = new Map();
  for (const id of ids) {
    const url = images[id];
    if (!url) continue;
    try {
      const target = path.join(framesDir, `${id.replace(/[^A-Za-z0-9]+/g, "-")}.png`);
      await writeFile(target, await api.download(url));
      downloaded.set(id, target);
    } catch (err) {
      process.stderr.write(`  could not download frame ${id}: ${err.message}\n`);
    }
  }
  let client = null;
  let prefix = [];
  if (judge) {
    requireBrief(config);
    client = createClient(config, { ledgerPath: path.join(config.out, config.ledger), runLabel: `fidelity:${manifest.label}` });
    const decisions = await loadDecisions(config);
    const extra = await contextSections(config);
    prefix = [
      text(
        "You are checking an implementation against its design. You are given the design frame and the screen that was built from it, with the measured difference between the design's values and the ones the page renders. Report what differs that matters, and say plainly what does not matter: real content in place of a placeholder, a state the design does not draw, or a deliberate improvement are not failures. Judge the build against the design, not against your own taste.",
      ),
      text(briefSection(config.briefText)),
    ];
    if (decisions.length) prefix.push(text(decisionsSection(decisions)));
    if (extra) prefix.push(text(extra));
  }
  const results = [];
  try {
    for (const pair of matched) {
      const entry = { route: pair.route, viewport: pair.viewport, frame: { id: pair.frame.id, name: pair.frame.name, page: pair.frame.page, width: pair.frame.width, height: pair.frame.height } };
      const node = nodeBody.nodes?.[pair.frame.id]?.document;
      const built = pair.shot.styles ? JSON.parse(await readFile(pair.shot.styles, "utf8")) : null;
      if (node) entry.design = designInventory([node]);
      if (entry.design && built) {
        entry.diff = inventoryDiff(entry.design, built, { nearDelta: config.lint?.nearDelta ?? 3 });
        // A frame that holds far less than the page does cannot say much about what
        // the page adds, so the reader is told rather than left to read a long list
        // of "not in the design" as a list of mistakes.
        const count = (inv) => ["colors", "backgrounds", "families", "sizes", "radii", "shadows", "spacing"].reduce((t, k) => t + (inv[k]?.length ?? 0), 0);
        const designed = count(entry.design);
        const rendered = count(built);
        if (rendered && designed / rendered < 0.5) entry.thinDesign = { designed, rendered };
      }
      const framePng = downloaded.get(pair.frame.id);
      entry.builtPng = pair.shot.fold;
      if (framePng) {
        entry.framePng = framePng;
        try {
          entry.pixels = frameDiff(decodePNG(await readFile(framePng)), decodePNG(await readFile(pair.shot.fold)));
        } catch {
          // a frame that could not be decoded simply has no pixel locator
        }
      }
      if (client && framePng) {
        try {
          const parts = [
            ...prefix,
            text(`## Task\nThe design frame "${pair.frame.name}" against the screen built for ${pair.route} at ${pair.viewport}.`),
            text(`## Measured\n${factLine(entry.diff ?? {}, entry.pixels)}${entry.thinDesign ? `\nThe frame holds far fewer values than the page renders (${entry.thinDesign.designed} against ${entry.thinDesign.rendered}), so it is probably a partial or outdated design. Judge what differs where the frame does cover the screen, and do not treat what the frame leaves out as a fault in the build.` : ""}`),
            text("DESIGN, the Figma frame"),
            await imagePart(framePng),
            text("BUILT, the screen as it renders"),
            await imagePart(pair.shot.fold),
          ];
          entry.judgement = (await client.generateJSON({ parts, schema: FIDELITY, op: `fidelity:${pair.route}@${pair.viewport}` })).data;
        } catch (err) {
          entry.error = err.message;
        }
      }
      results.push(entry);
      process.stderr.write(`  ${pair.route} at ${pair.viewport} against "${pair.frame.name}": ${entry.judgement?.standing ?? entry.error ?? "measured"}\n`);
    }
  } finally {
    if (client) await client.close();
  }
  const out = {
    tool: "ui-critic",
    kind: "fidelity",
    base: manifest.base,
    label: manifest.label,
    figmaFile: fileRef,
    fileName: file.name ?? null,
    generatedAt: new Date().toISOString(),
    usage: client ? client.summary() : null,
    pages: results,
    unmatchedScreens: pairs.filter((p) => !p.frame).map((p) => ({ route: p.route, viewport: p.viewport, error: p.error ?? null })),
    unusedFrames: unpairedFrames.map((f) => ({ id: f.id, name: f.name, page: f.page })),
  };
  const jsonPath = path.join(dir, "fidelity.json");
  const mdPath = path.join(dir, "fidelity.md");
  const htmlPath = path.join(dir, "fidelity.html");
  await writeFile(jsonPath, JSON.stringify(out, null, 2));
  await writeFile(mdPath, renderFidelity(out));
  await writeFile(htmlPath, renderFidelityHTML(out, dir));
  return { ...out, jsonPath, mdPath, htmlPath };
}

const KIND_LABEL = { colors: "Text colour", backgrounds: "Background", borders: "Border", families: "Font", sizes: "Font size", weights: "Font weight", lineHeights: "Line height", radii: "Radius", shadows: "Shadow", spacing: "Spacing" };

/** The fidelity report as Markdown. */
export function renderFidelity(out) {
  const lines = [`# Fidelity: ${out.label} against ${out.fileName ?? out.figmaFile}`, "", `Design file \`${out.figmaFile}\`, generated ${out.generatedAt}.`, ""];
  for (const page of out.pages) {
    lines.push(`## ${page.route} at ${page.viewport}`, "", `Design frame **${page.frame.name}**${page.frame.page ? ` on page ${page.frame.page}` : ""} (${page.frame.width}x${page.frame.height}).`, "");
    if (page.judgement) {
      lines.push(`**${page.judgement.standing}.** ${page.judgement.summary}`, "");
      if (page.judgement.differences?.length) {
        lines.push("| Severity | Kind | What differs | Fix |", "| --- | --- | --- | --- |");
        for (const d of page.judgement.differences) lines.push(`| ${d.severity} | ${d.kind} | ${d.what} | ${d.fix} |`);
        lines.push("");
      }
      if (page.judgement.not_a_concern?.length) lines.push("Not a concern: " + page.judgement.not_a_concern.join("; "), "");
    }
    if (page.thinDesign) lines.push(`> The frame holds ${page.thinDesign.designed} style values against the page's ${page.thinDesign.rendered}, so it is probably partial or out of date. What it leaves out is not a fault in the build.`, "");
    const diff = page.diff ?? {};
    const kinds = Object.keys(diff);
    if (kinds.length) {
      lines.push("### Measured against the design's values", "");
      for (const kind of kinds) {
        const d = diff[kind];
        if (d.drifted.length) lines.push(`- **${KIND_LABEL[kind] ?? kind} drifted:** ${d.drifted.map((x) => `\`${x.built}\` where the design has \`${x.design}\` (${x.count} elements)`).join(", ")}`);
        if (d.missing.length) lines.push(`- **${KIND_LABEL[kind] ?? kind} in the design, never rendered:** ${d.missing.map((x) => `\`${x.value}\``).join(", ")}`);
        if (d.extra.length) lines.push(`- **${KIND_LABEL[kind] ?? kind} rendered, not in the design:** ${d.extra.map((x) => `\`${x.value}\` (${x.count})`).join(", ")}`);
      }
      lines.push("");
    } else if (page.design) {
      lines.push("No measured difference between the design's values and the rendered ones.", "");
    }
    if (page.pixels) lines.push(`Pixels sit furthest from the frame in the ${[...new Set(page.pixels.worst.map((b) => b.where))].slice(0, 2).join(" and ")}${page.pixels.comparedHeight < 100 ? ` (the frame covers the top ${page.pixels.comparedHeight}% of the screen)` : ""}.`, "");
    if (page.error) lines.push(`Not judged: ${page.error}`, "");
  }
  if (out.unmatchedScreens.length) lines.push("## Screens with no frame", "", ...out.unmatchedScreens.map((s) => `- ${s.route} at ${s.viewport}${s.error ? `: ${s.error}` : ""}`), "");
  if (out.unusedFrames.length) lines.push("## Frames with no screen", "", ...out.unusedFrames.map((f) => `- ${f.name} (${f.id})${f.page ? ` on ${f.page}` : ""}`), "");
  if (out.usage) lines.push("", `Usage: ${out.usage.text ?? JSON.stringify(out.usage)}`);
  return lines.join("\n");
}

/** The fidelity report as one HTML file: each design frame beside the screen built from it. */
export function renderFidelityHTML(out, dir) {
  const page = (p) => {
    const rows = Object.entries(p.diff ?? {})
      .flatMap(([kind, d]) => [
        ...d.drifted.map((x) => `<tr><td>${esc(KIND_LABEL[kind] ?? kind)}</td><td class="t drift">drifted</td><td><code>${esc(x.built)}</code> where the design has <code>${esc(x.design)}</code></td><td>${x.count}</td></tr>`),
        ...d.missing.map((x) => `<tr><td>${esc(KIND_LABEL[kind] ?? kind)}</td><td class="t miss">not rendered</td><td><code>${esc(x.value)}</code></td><td>${x.count}</td></tr>`),
        ...d.extra.map((x) => `<tr><td>${esc(KIND_LABEL[kind] ?? kind)}</td><td class="t add">not designed</td><td><code>${esc(x.value)}</code></td><td>${x.count}</td></tr>`),
      ])
      .join("");
    const diffs = (p.judgement?.differences ?? []).map((d) => `<li><b>${esc(d.severity)}</b> <span class="k">${esc(d.kind)}</span> ${esc(d.what)}<div class="fix">${esc(d.fix)}</div></li>`).join("");
    return `<section><h2>${esc(p.route)} <span class="vp">${esc(p.viewport)}</span></h2>
<p class="frame">Design frame <b>${esc(p.frame.name)}</b>${p.frame.page ? ` on ${esc(p.frame.page)}` : ""} (${p.frame.width}x${p.frame.height})${p.judgement ? ` &middot; <b class="s-${esc(p.judgement.standing)}">${esc(p.judgement.standing)}</b>` : ""}</p>
${p.judgement ? `<p class="sum">${esc(p.judgement.summary)}</p>` : ""}
${p.thinDesign ? `<p class="thin">The frame holds ${p.thinDesign.designed} style values against the page's ${p.thinDesign.rendered}, so it is probably partial or out of date. What it leaves out is not a fault in the build.</p>` : ""}
<div class="pair"><figure><figcaption>Design</figcaption>${p.framePng ? `<img loading="lazy" src="${esc(relativeSrc(dir, p.framePng))}" alt="">` : '<div class="none">not rendered</div>'}</figure><figure><figcaption>Built</figcaption>${p.builtPng ? `<img loading="lazy" src="${esc(relativeSrc(dir, p.builtPng))}" alt="">` : '<div class="none">no screenshot</div>'}</figure></div>
${diffs ? `<h3>What differs</h3><ul class="d">${diffs}</ul>` : ""}
${p.judgement?.not_a_concern?.length ? `<p class="ok">Not a concern: ${esc(p.judgement.not_a_concern.join("; "))}</p>` : ""}
${rows ? `<h3>Measured against the design's values</h3><table><thead><tr><th>Property</th><th>State</th><th>Value</th><th>Uses</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fidelity: ${esc(out.label)}</title><style>
:root{color-scheme:light dark;--bg:#fbfafc;--fg:#1b1a1f;--mut:#6a6676;--line:#e6e3ea;--card:#fff;--drift:#b26a00;--miss:#9a2f5f;--add:#2a6f8f}
@media (prefers-color-scheme:dark){:root{--bg:#131217;--fg:#eceaf1;--mut:#a09cab;--line:#2c2a33;--card:#1b1a20}}
*{box-sizing:border-box}body{margin:0;padding:32px;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:0 0 4px}h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:22px 0 8px}
.lead{color:var(--mut);margin:0 0 28px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 20px}
.vp{font-size:13px;color:var(--mut);font-weight:400}.frame,.sum{margin:0 0 10px;color:var(--mut)}.sum{color:var(--fg)}
.s-faithful{color:#2a7d4f}.s-close{color:#b26a00}.s-diverged{color:#b23a48}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0}
figure{margin:0}figcaption{font-size:12px;color:var(--mut);margin-bottom:6px}
.pair img{width:100%;max-height:70vh;object-fit:contain;object-position:top;background:#fff;border:1px solid var(--line);border-radius:8px;display:block}
.none{padding:24px;border:1px dashed var(--line);border-radius:8px;color:var(--mut);text-align:center}
ul.d{list-style:none;padding:0;margin:0}ul.d li{border-top:1px solid var(--line);padding:10px 0}
.k{display:inline-block;font-size:12px;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:0 8px;margin:0 6px}
.fix{color:var(--mut);font-size:14px;margin-top:3px}.ok{color:var(--mut);font-size:14px}
.thin{border-left:3px solid var(--drift);padding:6px 12px;margin:0 0 12px;color:var(--mut);font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.t{font-weight:600}.drift{color:var(--drift)}.miss{color:var(--miss)}.add{color:var(--add)}
.tail{color:var(--mut);font-size:14px}
@media (max-width:720px){body{padding:16px}.pair{grid-template-columns:1fr}}
</style></head><body>
<h1>Fidelity: ${esc(out.label)}</h1>
<p class="lead">Against ${esc(out.fileName ?? out.figmaFile)} &middot; ${esc(out.generatedAt)}</p>
${out.pages.map(page).join("\n")}
${out.unmatchedScreens.length ? `<section><h2>Screens with no frame</h2><ul class="tail">${out.unmatchedScreens.map((s) => `<li>${esc(s.route)} at ${esc(s.viewport)}${s.error ? `: ${esc(s.error)}` : ""}</li>`).join("")}</ul></section>` : ""}
${out.unusedFrames.length ? `<section><h2>Frames with no screen</h2><ul class="tail">${out.unusedFrames.map((f) => `<li>${esc(f.name)} <code>${esc(f.id)}</code></li>`).join("")}</ul></section>` : ""}
</body></html>`;
}
