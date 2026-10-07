import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { imageSize, decodePNG, isPNG } from "./png.mjs";
import { dominantColors } from "./pixels.mjs";
import { routeSlug } from "./capture.mjs";

/**
 * A capture made from screenshots someone already has: an iOS app, a Figma export,
 * a Flutter desktop build, a competitor's screens. Files are named
 * <screen>.<viewport>.<frame>.<ext>, where the viewport and the frame are optional:
 *   checkout.png             the screen "checkout", viewport guessed from its shape
 *   checkout.phone.png       the same at the viewport "phone"
 *   checkout.phone.2.png     its second scroll frame
 * The result is an ordinary capture directory with a manifest, so critique,
 * compare and verify work on it unchanged. There is little to measure in a bare
 * image, so the facts are its size and its dominant colours.
 */

const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Splits a screenshot's file name into its screen, viewport (or null) and frame. */
export function parseImageName(file) {
  const parts = path.basename(file).replace(IMAGE, "").split(".");
  let frame = 1;
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) frame = Number(parts.pop());
  const viewport = parts.length > 1 ? parts.pop() : null;
  return { screen: parts.join("."), viewport, frame };
}

/** A viewport name from an image's shape: tall is a phone, wide is a desktop, between is a tablet. */
export function viewportFromSize(size) {
  if (!size) return "screen";
  const ratio = size.height / size.width;
  if (ratio >= 1.6) return "phone";
  if (ratio <= 0.85) return "desktop";
  return "tablet";
}

/** Builds a capture from a folder of screenshots and writes its manifest. */
export async function captureFromImages({ from, out, label }) {
  let names;
  try {
    names = (await readdir(from)).filter((f) => IMAGE.test(f));
  } catch (err) {
    throw new Error(`could not read the screenshots folder ${from}: ${err.message}`);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!names.length) throw new Error(`no PNG, JPEG or WebP screenshots in ${from}`);
  const dir = path.join(out, label);
  await mkdir(dir, { recursive: true });

  const groups = new Map();
  for (const name of names) {
    const buf = await readFile(path.join(from, name));
    const size = imageSize(buf);
    const { screen, viewport, frame } = parseImageName(name);
    const vp = viewport ?? viewportFromSize(size);
    const key = `${screen}|${vp}`;
    if (!groups.has(key)) groups.set(key, { screen, viewport: vp, frames: [] });
    groups.get(key).frames.push({ frame, name, buf, size });
  }

  const shots = [];
  const viewports = {};
  for (const group of groups.values()) {
    group.frames.sort((a, b) => a.frame - b.frame);
    const slug = routeSlug(group.screen);
    const files = [];
    for (const [i, fr] of group.frames.entries()) {
      const file = path.join(dir, `${slug}.${group.viewport}.${i === 0 ? "fold" : `frame${i + 1}`}${path.extname(fr.name).toLowerCase()}`);
      await writeFile(file, fr.buf);
      files.push(file);
    }
    const first = group.frames[0];
    const facts = { platform: "images", image: first.size, frames: group.frames.length };
    if (isPNG(first.buf)) {
      try {
        facts.palette = dominantColors(decodePNG(first.buf));
      } catch {
        // an unusual PNG (interlaced, say) simply has no palette fact
      }
    }
    const audit = path.join(dir, `${slug}.${group.viewport}.audit.json`);
    await writeFile(audit, JSON.stringify(facts, null, 2));
    if (!viewports[group.viewport]) viewports[group.viewport] = first.size ? { width: first.size.width, height: first.size.height } : {};
    shots.push({
      platform: "images",
      route: group.screen,
      path: group.screen,
      url: path.resolve(from, first.name),
      viewport: group.viewport,
      title: group.screen,
      fold: files[0],
      frames: files,
      audit,
      auth: false,
    });
  }
  const manifest = { label, platform: "images", base: path.resolve(from), capturedAt: new Date().toISOString(), viewports, hideSelectors: [], shots, skipped: [], dir };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
