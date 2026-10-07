import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadPlaywright, routeSlug } from "./capture.mjs";
import { parseColor, toHex, deltaE, chroma } from "./color.mjs";
import { contrastRatio, dominantColors } from "./pixels.mjs";
import { decodePNG, isPNG } from "./png.mjs";
import { createClient } from "./provider.mjs";
import { imagePart, text } from "./parts.mjs";
import { requireBrief } from "./brief.mjs";
import { briefSection } from "./critique.mjs";
import { esc } from "./html.mjs";

/**
 * Store screenshots and social images from real captures, rendered in the same
 * browser the capture uses (an HTML template per asset, photographed at the store's
 * exact size), so no image library or design tool is needed:
 *   Google Play phone  1080 x 1920
 *   App Store 6.7"     1290 x 2796
 *   social card        1200 x 630 (Open Graph, link previews)
 * Each store image is a caption over a phone frame holding the screen, on the
 * product's brand colour; a social card is the page's title beside its first screen.
 */

export const STORE_SIZES = {
  play: { width: 1080, height: 1920, label: "Google Play phone" },
  appstore: { width: 1290, height: 2796, label: "App Store 6.7-inch" },
};
export const SOCIAL_SIZE = { width: 1200, height: 630 };

/**
 * The brand colour for the background: a token whose name says brand, primary,
 * accent or a colour word, else the most used colourful colour, else a deep ink.
 * The caption colour is whichever of white or near-black reads better on it.
 */
export function brandColors(tokens = {}, palette = []) {
  const named = Object.entries(tokens).find(([name, value]) => /brand|primary|accent|plum|purple|blue|green|red|teal|indigo/i.test(name) && parseColor(value)?.a === 1);
  const fromPalette = palette.map((p) => p.color).find((c) => {
    const rgb = parseColor(c)?.rgb;
    if (!rgb) return false;
    const max = Math.max(...rgb);
    const min = Math.min(...rgb);
    return max - min > 60;
  });
  const bg = named ? toHex(parseColor(named[1]).rgb) : fromPalette ?? "#1c1b1f";
  const rgb = parseColor(bg).rgb;
  const ink = contrastRatio(rgb, [255, 255, 255]) >= contrastRatio(rgb, [20, 20, 24]) ? "#ffffff" : "#141418";
  return { bg, ink };
}

/**
 * When a capture has no stylesheet to read tokens from (an app, a folder of
 * screenshots), the brand colour comes from the screens themselves: the colourful
 * colours across every phone shot, near-duplicates merged by CIEDE2000 and summed.
 * Greys and near-whites are left out by chroma, so the background is the product's
 * accent, not the paper. One accent drawn at several lightnesses (text, buttons,
 * headers) merges into one family, and the family is named by its most vivid shade,
 * so a footer painted one flat colour does not outweigh the real brand colour.
 */
export async function paletteFromShots(shots) {
  const bins = [];
  for (const file of shots) {
    let image;
    try {
      const buffer = await readFile(file);
      if (!isPNG(buffer)) continue;
      image = decodePNG(buffer);
    } catch {
      continue;
    }
    for (const { color, share } of dominantColors(image, 12)) {
      const rgb = parseColor(color)?.rgb;
      if (!rgb || chroma(rgb) < 12) continue; // a grey or an off-white
      const hit = bins.find((b) => deltaE(b.rgb, rgb) < 15);
      if (hit) {
        hit.share += share;
        if (chroma(rgb) > chroma(hit.rgb)) {
          hit.rgb = rgb;
          hit.color = color;
        }
      } else bins.push({ color, rgb, share });
    }
  }
  return bins.sort((a, b) => b.share - a.share).map(({ color, share }) => ({ color, share: Math.round(share * 1000) / 1000 }));
}

/**
 * The social headline: the page title with any trailing " | Site" suffix dropped
 * and a leading product name removed, so the card does not say the product's name
 * in both the eyebrow and the headline.
 */
export function socialTitle(raw, name) {
  let title = String(raw).split(/\s[|·—–-]\s/)[0].trim();
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`^${escaped}\\s*[,:–—|-]\\s*`, "i"), "").trim();
  }
  return (title || String(raw)).slice(0, 70);
}

const dataUrl = async (file) => `data:${/\.jpe?g$/i.test(file) ? "image/jpeg" : "image/png"};base64,${(await readFile(file)).toString("base64")}`;

/** The HTML of one store screenshot: caption above a phone frame holding the screen. */
export function storeTemplate({ width, height, caption, image, bg, ink, camera = "island", font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }) {
  const pad = Math.round(width * 0.07);
  const captionSize = Math.round(width * 0.068);
  const phoneW = Math.round(width * 0.78);
  const bezel = Math.round(phoneW * 0.035);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${bg};}
body{display:flex;flex-direction:column;align-items:center;font-family:${font};}
h1{margin:${pad}px ${pad}px ${Math.round(pad * 0.7)}px;color:${ink};font-size:${captionSize}px;line-height:1.15;font-weight:800;text-align:center;letter-spacing:-0.01em;}
.phone{width:${phoneW}px;flex:1;min-height:0;margin-bottom:-${Math.round(phoneW * 0.25)}px;background:#0b0b0d;border-radius:${Math.round(phoneW * 0.12)}px ${Math.round(phoneW * 0.12)}px 0 0;padding:${bezel}px ${bezel}px 0;box-shadow:0 ${Math.round(width * 0.02)}px ${Math.round(width * 0.06)}px rgba(0,0,0,.35);position:relative;}
.screen{width:100%;height:100%;border-radius:${Math.round(phoneW * 0.09)}px ${Math.round(phoneW * 0.09)}px 0 0;overflow:hidden;background:#fff;}
.screen img{width:100%;display:block;}
.island{position:absolute;top:${bezel + Math.round(phoneW * 0.025)}px;left:50%;transform:translateX(-50%);width:${camera === "island" ? Math.round(phoneW * 0.26) : Math.round(phoneW * 0.035)}px;height:${camera === "island" ? Math.round(phoneW * 0.07) : Math.round(phoneW * 0.035)}px;border-radius:999px;background:#0b0b0d;}
</style></head><body><h1>${esc(caption)}</h1><div class="phone"><div class="screen"><img src="${image}" alt=""></div><div class="island"></div></div></body></html>`;
}

/** The HTML of one social card: product and page title beside the page's first screen in a browser frame. */
export function socialTemplate({ width, height, title, subtitle, image, bg, ink, font = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${bg};font-family:${font};}
body{display:grid;grid-template-columns:1fr 1.15fr;align-items:center;gap:40px;padding:0 0 0 64px;box-sizing:border-box;}
.copy{color:${ink};}
.copy p{margin:0 0 14px;font-size:24px;opacity:.85;}
.copy h1{margin:0;font-size:52px;line-height:1.08;font-weight:800;letter-spacing:-0.015em;}
.window{background:#fff;border-radius:14px 0 0 14px;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden;height:470px;display:flex;flex-direction:column;}
.bar{height:34px;background:#ececf0;display:flex;align-items:center;gap:8px;padding-left:14px;}
.bar i{width:11px;height:11px;border-radius:50%;background:#c9c9cf;display:block;}
.window img{width:100%;flex:1;min-height:0;object-fit:cover;object-position:top;display:block;}
</style></head><body><div class="copy"><p>${esc(subtitle)}</p><h1>${esc(title)}</h1></div><div class="window"><div class="bar"><i></i><i></i><i></i></div><img src="${image}" alt=""></div></body></html>`;
}

const CAPTIONS = {
  type: "OBJECT",
  properties: {
    captions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { route: { type: "STRING" }, caption: { type: "STRING", description: "at most six words, the benefit this screen shows, in the product's voice" } },
        required: ["route", "caption"],
      },
    },
  },
  required: ["captions"],
};

/** Captions for each screen, drafted by the critic from the brief. */
export async function draftCaptions({ config, manifest, shots }) {
  requireBrief(config);
  const client = createClient(config, { ledgerPath: path.join(config.out, config.ledger), runLabel: `assets:${manifest.label}` });
  try {
    const parts = [text("You write store listing captions: the one benefit each screen shows, at most six words, in the product's own voice, with no hype words, no exclamation marks and no claims the screen does not show."), text(briefSection(config.briefText))];
    for (const s of shots) parts.push(text(`Screen ${s.route}`), await imagePart(s.fold));
    parts.push(text(`## Task\nWrite one caption for each screen: ${shots.map((s) => s.route).join(", ")}.`));
    const { data } = await client.generateJSON({ parts, schema: CAPTIONS, op: "assets:captions" });
    return Object.fromEntries((data.captions ?? []).map((c) => [c.route, c.caption]));
  } finally {
    await client.close();
  }
}

/** Which shots make store screenshots: phone-sized first screens, one per screen. */
export function storeShots(manifest) {
  const phone = (s) => {
    const vp = manifest.viewports?.[s.viewport] ?? {};
    return vp.isMobile || /phone|mobile/i.test(s.viewport) || manifest.platform === "android" || manifest.platform === "ios";
  };
  const seen = new Set();
  return (manifest.shots ?? []).filter((s) => !s.blocked && phone(s) && !seen.has(s.route) && seen.add(s.route) && !(manifest.viewports?.[s.viewport]?.a11yPreset));
}

/**
 * Renders the store screenshots and social cards for a capture into
 * <capture>/assets, and returns the files with their sizes.
 */
export async function renderAssets({ dir, config, kinds = ["store", "social"], captions = {}, auto = false, product = null }) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  let tokens = {};
  let palette = [];
  try {
    const { lintCapture } = await import("./lint.mjs");
    const lint = await lintCapture(dir, config.lint ?? {});
    tokens = lint.tokensDeclared ?? {};
    palette = lint.proposal?.palette ?? [];
  } catch {
    // no style inventory (an app or a folder of screenshots): read the colour off the screens
  }
  if (!palette.length && !Object.keys(tokens).length) {
    const folds = storeShots(manifest).map((s) => s.fold).filter(Boolean);
    palette = await paletteFromShots(folds);
  }
  const colors = { ...brandColors(tokens, palette), ...(config.assets?.background ? { bg: config.assets.background } : {}) };
  if (config.assets?.background) {
    const rgb = parseColor(colors.bg)?.rgb ?? [28, 27, 31];
    colors.ink = contrastRatio(rgb, [255, 255, 255]) >= contrastRatio(rgb, [20, 20, 24]) ? "#ffffff" : "#141418";
  }
  const outDir = path.join(dir, "assets");
  await mkdir(outDir, { recursive: true });
  const phones = storeShots(manifest);
  let captionMap = { ...(config.assets?.captions ?? {}), ...captions };
  if (auto && kinds.includes("store") && phones.length) captionMap = { ...(await draftCaptions({ config, manifest, shots: phones })), ...captionMap };
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch();
  const written = [];
  try {
    const shoot = async (html, size, file) => {
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "load" });
      await page.screenshot({ path: file, type: "png" });
      await page.close();
      written.push({ file, width: size.width, height: size.height });
    };
    if (kinds.includes("store")) {
      for (const [n, s] of phones.entries()) {
        const caption = captionMap[s.route] ?? captionMap[s.path] ?? s.title ?? s.route;
        const image = await dataUrl(s.fold);
        for (const [store, size] of Object.entries(STORE_SIZES)) {
          const folder = path.join(outDir, store);
          await mkdir(folder, { recursive: true });
          await shoot(storeTemplate({ ...size, caption, image, camera: store === "play" ? "punch-hole" : "island", ...colors }), size, path.join(folder, `${String(n + 1).padStart(2, "0")}-${routeSlug(s.route)}.png`));
        }
      }
    }
    if (kinds.includes("social") && (!manifest.platform || manifest.platform === "web")) {
      const desk = (manifest.shots ?? []).filter((s) => !s.blocked && !s.scenario && !(manifest.viewports?.[s.viewport]?.isMobile) && !(manifest.viewports?.[s.viewport]?.a11yPreset));
      const seen = new Set();
      const folder = path.join(outDir, "social");
      await mkdir(folder, { recursive: true });
      const name = product ?? new URL(manifest.base).hostname.replace(/^www\./, "");
      for (const s of desk) {
        if (seen.has(s.route)) continue;
        seen.add(s.route);
        const title = socialTitle(s.title || s.route, name);
        await shoot(socialTemplate({ ...SOCIAL_SIZE, title, subtitle: name, image: await dataUrl(s.fold), ...colors }), SOCIAL_SIZE, path.join(folder, `${routeSlug(s.route)}.png`));
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(path.join(outDir, "assets.json"), JSON.stringify({ colors, captions: captionMap, files: written }, null, 2));
  return { dir: outDir, colors, captions: captionMap, files: written };
}
