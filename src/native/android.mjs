import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createRunner, findAdb, parseDevices, pickDevice, androidDevice, deviceInfo, keyCode, KEYS, shq } from "./adb.mjs";
import {
  parseHierarchy,
  findNode,
  labelOf,
  tapPoint,
  signature,
  mainScrollable,
  scrollAxis,
  maybeClipped,
  isVisible,
  isInteractive,
  shortClass,
  shortId,
  foregroundPackage,
  coveredByOverlay,
} from "./hierarchy.mjs";
import { isLaunchRoute, NATIVE_STEP_KEYS } from "./steps.mjs";
import { ANDROID_DEFAULTS } from "../config.mjs";
import { decodePNG } from "../png.mjs";
import { estimateTextContrast } from "../pixels.mjs";
import { readEnvFile, secretFrom, normalizeRoute } from "../steps.mjs";
import { routeSlug, scenarioLabel, scenariosAt } from "../capture.mjs";

/**
 * Native capture for Android, over adb, for any app on an emulator or a device:
 * Kotlin and Java, Compose and Views, React Native and Expo, Flutter. For each
 * screen it cold starts the app (or opens a deep link), runs the scenario's steps
 * and checks that each one changed the screen, captures the first screen and the
 * screens below it as overlapping scroll frames, measures what the hierarchy and
 * the pixels can prove (touch targets in dp, unlabelled controls, contrast), and
 * reads crashes and errors from the log since the screen began.
 *
 * The device is put in a capture state first (animations off, a frozen status bar)
 * and put back afterwards, even after a crash or Ctrl+C: the original values are
 * written to a restore file before anything changes, and a leftover file from a
 * killed run is applied before the next one starts. App data is never cleared, so a
 * signed-in session on the device survives every capture.
 */

export { ANDROID_DEFAULTS };

const ANIMATION_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until two consecutive screenshots are byte-identical, or the timeout passes. */
export async function settle(dev, { settleTimeoutMs = 8000, settleIntervalMs = 200, sleep = realSleep, clock = Date.now } = {}) {
  let prev = await dev.screencap();
  const start = clock();
  while (clock() - start < settleTimeoutMs) {
    await sleep(settleIntervalMs);
    const next = await dev.screencap();
    if (next.equals(prev)) return { png: next, settled: true };
    prev = next;
  }
  return { png: prev, settled: false };
}

/** The screen as it is now: a settled screenshot and the parsed hierarchy. */
export async function readState(dev, ctx) {
  const s = await settle(dev, ctx);
  try {
    const { nodes } = parseHierarchy(await dev.dump());
    return { png: s.png, settled: s.settled, nodes, sig: signature(nodes), dumpError: null };
  } catch (err) {
    return { png: s.png, settled: s.settled, nodes: [], sig: "", dumpError: err.message };
  }
}

/** Whether anything visible changed between two states: the hierarchy or the pixels. */
export function screenChanged(before, after) {
  return before.sig !== after.sig || !before.png.equals(after.png);
}

/** The distinct texts and descriptions on screen, for an error message that helps. */
export function visibleLabels(nodes, limit = 10) {
  const out = [];
  for (const n of nodes) {
    if (!isVisible(n)) continue;
    const t = (n.text || n.desc || "").trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

const onScreen = (nodes) => {
  const labels = visibleLabels(nodes);
  return labels.length ? ` (on screen: ${labels.map((l) => JSON.stringify(l.slice(0, 40))).join(", ")})` : "";
};

async function findOrWait(dev, state, selector, ctx, attempts = 2) {
  let current = state;
  let node = findNode(current.nodes, selector);
  for (let i = 0; !node && i < attempts; i += 1) {
    await (ctx.sleep ?? realSleep)(800);
    current = await readState(dev, ctx);
    node = findNode(current.nodes, selector);
  }
  if (!node) throw new Error(`nothing on screen matches ${selector}${onScreen(current.nodes)}`);
  return { node, state: current };
}

const overlaps = (a, b) => a && b && a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/**
 * Runs one step against the device and returns the new state, a log line without
 * secret values, and a warning when the step had no visible effect. A step whose
 * target cannot be found throws, naming what is on screen instead.
 */
export async function runNativeStep(dev, step, state, ctx) {
  const key = Object.keys(step).find((k) => NATIVE_STEP_KEYS.includes(k));
  const sleep = ctx.sleep ?? realSleep;
  const verify = async (before, log) => {
    const next = await readState(dev, ctx);
    return { state: next, log, warning: screenChanged(before, next) ? null : `${log} changed nothing on screen` };
  };
  switch (key) {
    case "goto":
      await dev.openUri(step.goto, ctx.pkg);
      return verify(state, `goto ${step.goto}`);
    case "click":
    case "tap": {
      const selector = step[key];
      const found = await findOrWait(dev, state, selector, ctx);
      const p = tapPoint(found.node);
      await dev.tap(p.x, p.y);
      return verify(found.state, `click ${selector}`);
    }
    case "longPress": {
      const found = await findOrWait(dev, state, step.longPress, ctx);
      const p = tapPoint(found.node);
      await dev.longPress(p.x, p.y);
      return verify(found.state, `longPress ${step.longPress}`);
    }
    case "fill": {
      const { selector, value, envVar } = step.fill;
      const secret = Boolean(envVar);
      const text = secret ? secretFrom(envVar, ctx.secrets ?? {}) : value;
      if (secret && text == null) throw new Error(`fill needs the environment variable ${envVar}, which is not set`);
      if (/[^\x20-\x7e]/.test(text)) throw new Error(`fill ${selector}: only plain ASCII can be typed on Android`);
      const found = await findOrWait(dev, state, selector, ctx);
      const field = found.node;
      const p = tapPoint(field);
      await dev.tap(p.x, p.y);
      await sleep(300);
      const existing = field.password ? "" : field.text && field.text !== field.hint ? field.text : "";
      for (let i = 0; i < existing.length; i += 40) {
        const n = Math.min(40, existing.length - i);
        await dev.keys([...(i === 0 ? [KEYS.moveend] : []), ...Array(n).fill(KEYS.backspace)]);
      }
      if (text.length) await dev.text(text);
      const next = await readState(dev, ctx);
      let warning = null;
      if (!secret && !field.password) {
        const same = next.nodes.find((n) => (field.id && n.id === field.id) || (n.cls === field.cls && overlaps(n.bounds, field.bounds)));
        if (same && same.text !== text) warning = `fill ${selector}: the field shows ${JSON.stringify(same.text)} after typing`;
      }
      return { state: next, log: secret ? `fill ${selector} from ${envVar}` : `fill ${selector}`, warning };
    }
    case "press":
      await dev.key(keyCode(step.press));
      return verify(state, `press ${step.press}`);
    case "hideKeyboard":
      if (await dev.keyboardShown()) {
        await dev.key(KEYS.back);
        return verify(state, "hideKeyboard");
      }
      return { state, log: "hideKeyboard (it was not open)", warning: null };
    case "wait":
      await sleep(step.wait);
      return { state: await readState(dev, ctx), log: `wait ${step.wait}ms`, warning: null };
    case "waitFor": {
      const clock = ctx.clock ?? Date.now;
      const deadline = clock() + (ctx.waitForTimeoutMs ?? 30_000);
      let current = state;
      while (!findNode(current.nodes, step.waitFor)) {
        if (clock() > deadline) throw new Error(`waitFor ${step.waitFor}: not on screen in time${onScreen(current.nodes)}`);
        await sleep(500);
        current = await readState(dev, ctx);
      }
      return { state: current, log: `waitFor ${step.waitFor}`, warning: null };
    }
    case "scroll": {
      const scroller = mainScrollable(state.nodes);
      if (!scroller) return { state, log: `scroll ${step.scroll}`, warning: `scroll ${step.scroll}: nothing on this screen scrolls` };
      const b = scroller.bounds;
      const horizontal = scrollAxis(state.nodes, scroller) === "x";
      const dir = Math.sign(step.scroll);
      const span = (horizontal ? b.width : b.height) * 0.7;
      let remaining = Math.abs(step.scroll) * ctx.info.pxPerDp;
      while (remaining > 1) {
        const d = Math.min(remaining, span);
        if (horizontal) {
          const cx = b.x1 + b.width / 2;
          const cy = b.y1 + b.height / 2;
          await dev.drag(cx + (dir * d) / 2, cy, cx - (dir * d) / 2, cy);
        } else {
          const cx = b.x1 + b.width / 2;
          const cy = b.y1 + b.height / 2;
          await dev.drag(cx, cy + (dir * d) / 2, cx, cy - (dir * d) / 2);
        }
        remaining -= d;
      }
      return verify(state, `scroll ${step.scroll}`);
    }
    case "swipe": {
      const { width: W, height: H } = ctx.info.screen;
      const strip = state.nodes.find((n) => n.scrollable && isVisible(n) && scrollAxis(state.nodes, n) === "x");
      const y = strip ? strip.bounds.y1 + strip.bounds.height / 2 : H / 2;
      const moves = {
        left: [W * 0.8, y, W * 0.2, y],
        right: [W * 0.2, y, W * 0.8, y],
        up: [W / 2, H * 0.75, W / 2, H * 0.3],
        down: [W / 2, H * 0.3, W / 2, H * 0.75],
      };
      await dev.swipe(...moves[step.swipe], 250);
      return verify(state, `swipe ${step.swipe}`);
    }
    default:
      throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}

/**
 * The first screen plus the screens below it, as overlapping frames: drag the main
 * list up by about sixty percent of its height, wait for it to settle, and stop when
 * a drag no longer moves anything (the end) or at the frame limit.
 */
export async function captureFrames(dev, state, ctx) {
  const frames = [state];
  const scroller = mainScrollable(state.nodes);
  if (!scroller || scrollAxis(state.nodes, scroller) === "x") return { frames, scroll: "none" };
  if ((ctx.scrollFrames ?? 3) <= 1) return { frames, scroll: "more" };
  const b = scroller.bounds;
  const cx = b.x1 + b.width / 2;
  let current = state;
  let reachedEnd = false;
  for (let i = 1; i < (ctx.scrollFrames ?? 3); i += 1) {
    await dev.drag(cx, b.y1 + b.height * 0.82, cx, b.y1 + b.height * 0.22);
    const next = await readState(dev, ctx);
    if (!screenChanged(current, next)) {
      reachedEnd = true;
      break;
    }
    frames.push(next);
    current = next;
  }
  if (frames.length > 1 && !ctx.coldStart) {
    for (let i = 0; i < frames.length; i += 1) await dev.swipe(cx, b.y1 + b.height * 0.25, cx, b.y1 + b.height * 0.9, 120);
  }
  // A list that never moved does not scroll at all; one that stopped moving was captured to its end.
  const scroll = frames.length === 1 && reachedEnd ? "none" : reachedEnd ? "end" : "more";
  return { frames, scroll };
}

/** The scroll status of a screen, in words a reader cannot misread. */
export const SCROLL_WORDS = {
  none: "does not scroll",
  end: "captured to the end of its scroll",
  more: "scrolls further than the captured frames (the frame limit stopped the capture; nothing is implied about the content below)",
};

/** Error lines from a logcat dump: deduplicated, stack frames dropped, capped. */
export function parseErrorLines(text, cap = 10) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\d\d-\d\d\s+[\d:.]+\s+\d+\s+\d+\s+[A-Z]\s+([^:]+?)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const message = m[2];
    if (/^\s*(at |\.\.\. \d+ more)/.test(message) || /^\t/.test(message) || !message.trim()) continue;
    const entry = `${m[1].trim()}: ${message.trim()}`.slice(0, 200);
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Crashes of the app in a crash-buffer dump: Java and Kotlin fatal exceptions
 * (the exception line after "Process: <package>") and native crashes (the signal
 * line of a tombstone that names the package).
 */
export function parseCrashes(text, pkg, cap = 3) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/^\d\d-\d\d\s+[\d:.]+\s+\d+\s+\d+\s+[A-Z]\s+[^:]+:\s?/, ""));
  const out = [];
  for (let i = 0; i < lines.length && out.length < cap; i += 1) {
    if (lines[i].startsWith(`Process: ${pkg}`)) {
      const exception = lines.slice(i + 1).find((l) => l.trim() && !/^\s*at /.test(l));
      out.push(`fatal exception: ${(exception ?? "unknown").trim().slice(0, 200)}`);
    } else if (lines[i].includes(`>>> ${pkg} <<<`)) {
      const signal = lines.slice(i, i + 12).find((l) => /signal \d+/.test(l));
      out.push(`native crash: ${(signal ?? lines[i]).trim().slice(0, 200)}`);
    }
  }
  return out;
}

/** Frame timing from `dumpsys gfxinfo`, or null when too few frames were drawn to mean anything. */
export function parseFrameStats(text) {
  const total = Number(/Total frames rendered:\s*(\d+)/.exec(text ?? "")?.[1] ?? 0);
  if (total < 10) return null;
  const janky = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text);
  const p90 = /90th percentile:\s*(\d+)ms/.exec(text);
  return { frames: total, jankyPercent: janky ? Number(janky[2]) : null, p90Ms: p90 ? Number(p90[1]) : null };
}

/** The focused activity from `dumpsys window`, as package/activity. */
export function parseActivity(text) {
  const m = /mCurrentFocus=Window\{[^}]*?\s([\w.]+)\/([\w.$]+)\}/.exec(text ?? "") ?? /mFocusedApp=.*?\s([\w.]+)\/([\w.$]+)/.exec(text ?? "");
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The screen's title: the tallest text in the top three tenths below the status bar
 * (a large collapsing title sits lower than a toolbar's), else the activity name.
 */
export function guessTitle(nodes, info, activity) {
  const top = info.screen.height * 0.3;
  const statusBar = 24 * info.pxPerDp;
  let best = null;
  for (const n of nodes) {
    if (!isVisible(n) || !n.text.trim() || n.bounds.y1 < statusBar || n.bounds.y2 > top) continue;
    if (!best || n.bounds.height > best.bounds.height) best = n;
  }
  return best ? best.text.trim().slice(0, 80) : (activity?.split("/").pop()?.split(".").pop() ?? "screen");
}

const IMAGE_CLASS = /ImageView|ImageButton/;

/**
 * How far the content had scrolled in each frame, in pixels from the first: the most
 * common upward shift of text rows found in consecutive frames at the same x and
 * size. Rows that did not move (an app bar, a bottom bar) are ignored, since they
 * would vote for no movement at all.
 */
export function frameOffsets(frameNodes) {
  const offsets = [0];
  for (let k = 1; k < frameNodes.length; k += 1) {
    const before = new Map();
    for (const n of frameNodes[k - 1]) if (isVisible(n) && n.text) before.set(`${n.text}|${n.bounds.x1}|${n.bounds.width}|${n.bounds.height}`, n.bounds.y1);
    const votes = new Map();
    for (const n of frameNodes[k]) {
      if (!isVisible(n) || !n.text) continue;
      const y = before.get(`${n.text}|${n.bounds.x1}|${n.bounds.width}|${n.bounds.height}`);
      if (y !== undefined && y > n.bounds.y1) votes.set(y - n.bounds.y1, (votes.get(y - n.bounds.y1) ?? 0) + 1);
    }
    let shift = 0;
    let best = 0;
    for (const [delta, count] of votes) if (count > best) [shift, best] = [delta, count];
    offsets.push(offsets[k - 1] + shift);
  }
  return offsets;
}

/**
 * A set of elements seen across overlapping frames. Two sightings are the same
 * element when they share kind, label and size and sit at the same place either on
 * the screen (a fixed bar) or in the content (a row that scrolled up).
 */
function sightings() {
  const items = [];
  return {
    add(key, screenY, contentY, value) {
      const hit = items.find((it) => it.key === key && (Math.abs(it.screenY - screenY) <= 2 || Math.abs(it.contentY - contentY) <= 2));
      if (hit) return false;
      items.push({ key, screenY, contentY, value });
      return true;
    },
    values: () => items.map((it) => it.value),
  };
}

/**
 * The measured facts of one screen, merged across its scroll frames: touch targets
 * in dp (under 48dp, the Material minimum, and under 24dp, the WCAG one), controls a
 * screen reader would announce without a name, images without a description, the
 * text on screen, and text contrast measured from the pixels.
 */
export function buildNativeAudit({ frames, info, app, variant = {}, activity = null, scroll = "none", runtime = null }) {
  const dp = (px) => Math.round((px / info.pxPerDp) * 10) / 10;
  const screen = info.screen;
  const offsets = frameOffsets(frames.map((f) => f.nodes));
  const targets = sightings();
  const unlabeled = [];
  const imageSet = sightings();
  let imagesWithoutDescription = 0;
  const texts = [];
  const samples = sightings();
  let complex = 0;
  let covered = 0;
  let disabled = 0;
  frames.forEach(({ nodes, image }, fi) => {
    const overlays = new Map();
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const clipped = maybeClipped(nodes, n, screen, { leading: fi > 0 });
      const size = `${Math.round(dp(n.bounds.width))}x${Math.round(dp(n.bounds.height))}`;
      const screenY = n.bounds.y1;
      const contentY = n.bounds.y1 + offsets[fi];
      if (isInteractive(n) && !clipped) {
        const label = labelOf(nodes, n);
        const target = { label: label || null, kind: shortClass(n.cls), w: dp(n.bounds.width), h: dp(n.bounds.height), id: shortId(n.id) || null, frame: fi + 1 };
        if (targets.add(`${target.kind}|${label}|${size}|${n.bounds.x1}`, screenY, contentY, target)) {
          if (!n.enabled) disabled += 1;
          if (!label) unlabeled.push({ kind: target.kind, id: target.id, w: target.w, h: target.h, at: `${dp(n.bounds.x1)},${dp(n.bounds.y1)} dp`, frame: fi + 1 });
        }
      }
      if (IMAGE_CLASS.test(n.cls) && !clipped && imageSet.add(`${n.cls}|${n.desc}|${size}|${n.bounds.x1}`, screenY, contentY, true)) {
        let p = n.parent;
        let labelledAncestor = false;
        while (p >= 0 && !labelledAncestor) {
          if (isInteractive(nodes[p]) && labelOf(nodes, nodes[p])) labelledAncestor = true;
          p = nodes[p].parent;
        }
        if (!n.desc.trim() && !labelledAncestor && !isInteractive(n)) imagesWithoutDescription += 1;
      }
      const shown = (n.text || n.hint || "").trim();
      if (!shown) continue;
      const flat = shown.replace(/\s+/g, " ").slice(0, 80);
      if (!texts.includes(flat) && texts.length < 60) texts.push(flat);
      if (image && !n.password && n.bounds.height >= 8 && !clipped) {
        const b = n.bounds;
        // Text scrolled under a floating bar shows the bar's pixels, not its own.
        if (coveredByOverlay(nodes, n, screen, overlays)) {
          if (samples.add(`${flat}|${size}|${b.x1}`, screenY, contentY, null)) covered += 1;
          continue;
        }
        const est = estimateTextContrast(image, { x: b.x1, y: b.y1, width: b.width, height: b.height });
        if (!est) continue;
        if (!samples.add(`${flat}|${size}|${b.x1}`, screenY, contentY, est.complex ? null : { text: flat.slice(0, 40), ratio: est.ratio, fg: est.fg, bg: est.bg, heightDp: dp(b.height), frame: fi + 1 })) continue;
        if (est.complex) complex += 1;
      }
    }
  });
  const all = targets.values();
  const measured = samples.values().filter(Boolean);
  const images = { total: imageSet.values().length, withoutDescription: imagesWithoutDescription };
  const small = all.filter((t) => t.w < 48 || t.h < 48).sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h));
  // Key order is prompt order: the critic's copy of the facts is truncated at a
  // length, so what decides findings comes first and the long text list last.
  return {
    platform: "android",
    device: { model: info.model, android: info.android, density: info.density, pxPerDp: info.pxPerDp, screenDp: { width: dp(screen.width), height: dp(screen.height) }, emulator: info.emulator },
    app,
    variant: { night: Boolean(variant.night), fontScale: variant.fontScale ?? 1 },
    screen: { activity, title: guessTitle(frames[0]?.nodes ?? [], info, activity), frames: frames.length, scroll: SCROLL_WORDS[scroll] ?? scroll },
    interactive: {
      note: "sizes are each element's bounds in dp; a touch area enlarged beyond its bounds (React Native hitSlop, an Android TouchDelegate) does not show here",
      total: all.length,
      under48dpCount: small.length,
      under24dpCount: all.filter((t) => t.w < 24 || t.h < 24).length,
      unlabeledCount: unlabeled.length,
      disabled,
      under48dp: small.slice(0, 10),
      unlabeled: unlabeled.slice(0, 10),
    },
    textContrast: {
      method: "pixels",
      sampled: measured.length,
      below4_5: measured.filter((s) => s.ratio < 4.5).length,
      below3: measured.filter((s) => s.ratio < 3).length,
      complexBackground: complex,
      underOverlay: covered,
      lowest: measured.sort((a, b) => a.ratio - b.ratio).slice(0, 8),
    },
    images,
    runtime,
    text: { count: texts.length, shown: texts },
    // The scroll offset of each frame in pixels, so a fact can be placed on its frame.
    frameOffsetsPx: offsets,
  };
}

async function writeRestoreFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

/**
 * Reads the settings the capture is about to change, records them in the restore
 * file, then applies the capture state: animations off (screens settle, nothing
 * smears) and a frozen status bar (the clock and notifications never differ between
 * a before and an after capture).
 */
export async function prepareDevice(dev, opts, restorePath) {
  const original = { night: await dev.nightMode(), font_scale: await dev.setting("system", "font_scale"), sysui_demo_allowed: await dev.setting("global", "sysui_demo_allowed") };
  for (const k of ANIMATION_KEYS) original[k] = await dev.setting("global", k);
  await writeRestoreFile(restorePath, { serial: dev.serial, savedAt: new Date().toISOString(), cleanStatusBar: Boolean(opts.cleanStatusBar), original });
  if (opts.disableAnimations) for (const k of ANIMATION_KEYS) await dev.putSetting("global", k, "0");
  if (opts.cleanStatusBar) {
    await dev.putSetting("global", "sysui_demo_allowed", "1");
    await freezeStatusBar(dev);
  }
  return original;
}

/**
 * Freezes the status bar (system demo mode): a fixed clock, full battery and signal,
 * no notification icons. A night mode or font scale change restarts the status bar
 * and drops demo mode, so this runs again after every variant change.
 */
export async function freezeStatusBar(dev) {
  await dev.demo("enter");
  await dev.demo("clock", { hhmm: "1200" });
  await dev.demo("battery", { level: 100, plugged: "false", powersave: "false" });
  await dev.demo("network", { wifi: "show", level: 4 });
  await dev.demo("network", { mobile: "hide" });
  await dev.demo("notifications", { visible: "false" });
}

/** Puts every recorded setting back and removes the restore file; problems are reported, not thrown. */
export async function restoreDevice(dev, original, restorePath, { cleanStatusBar = true } = {}) {
  const problems = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${what}: ${err.message}`);
    }
  };
  if (cleanStatusBar) {
    await attempt("status bar", () => dev.demo("exit"));
    await attempt("sysui_demo_allowed", () => dev.putSetting("global", "sysui_demo_allowed", original.sysui_demo_allowed ?? null));
  }
  for (const k of ANIMATION_KEYS) await attempt(k, () => dev.putSetting("global", k, original[k] ?? null));
  await attempt("font_scale", () => dev.putSetting("system", "font_scale", original.font_scale ?? null));
  if (["yes", "no", "auto"].includes(original.night)) {
    await attempt("night mode", async () => {
      if ((await dev.nightMode()) !== original.night) await dev.setNightMode(original.night);
    });
  }
  if (problems.length) {
    process.stderr.write(`  could not restore every device setting (${problems.join("; ")}); the values to put back are in ${restorePath}\n`);
    return problems;
  }
  await unlink(restorePath).catch(() => {});
  return problems;
}

/** Applies a leftover restore file from a run that was killed before it could clean up. */
export async function restoreLeftover(dev, restorePath) {
  let saved;
  try {
    saved = JSON.parse(await readFile(restorePath, "utf8"));
  } catch {
    return false;
  }
  process.stderr.write(`  restoring device settings left changed by an interrupted run (${saved.savedAt})\n`);
  await restoreDevice(dev, saved.original ?? {}, restorePath, { cleanStatusBar: saved.cleanStatusBar !== false });
  return true;
}

/**
 * Applies a viewport's variant: night mode and the system font scale; anything
 * unset goes back to the original. Returns the state the screens are captured in.
 */
export async function applyVariant(dev, variant, original, { cleanStatusBar = false, sleep = realSleep } = {}) {
  let changed = false;
  const night = variant.night === true ? "yes" : variant.night === false ? "no" : original.night;
  if (["yes", "no", "auto"].includes(night) && (await dev.nightMode()) !== night) {
    await dev.setNightMode(night);
    changed = true;
  }
  const scale = variant.fontScale !== undefined ? String(variant.fontScale) : (original.font_scale ?? null);
  if ((await dev.setting("system", "font_scale")) !== scale) {
    await dev.putSetting("system", "font_scale", scale);
    changed = true;
  }
  if (changed && cleanStatusBar) {
    // The status bar restarts on a configuration change; give it a moment, then freeze it again.
    await sleep(1200);
    await freezeStatusBar(dev);
  }
  return { night: night === "yes", fontScale: scale === null ? 1 : Number(scale) };
}

/** An error line with its numbers and addresses blanked, so the same error matches across launches. */
export const normalizeError = (line) => line.replace(/0x[0-9a-f]+/gi, "#").replace(/\d+/g, "#");

/**
 * The errors the app logs on every plain launch: one cold start before the capture,
 * read from the log. Screens then report only errors beyond these, so framework
 * chatter a process prints at startup is not passed off as a problem with a screen.
 */
export async function launchBaseline(dev, ctx, component) {
  const since = await dev.logTime().catch(() => null);
  await dev.forceStop(ctx.pkg);
  await dev.launch(component);
  await settle(dev, ctx);
  const window = since ? `-T ${shq(since)}` : "-t 2000";
  const pid = await dev.pidof(ctx.pkg);
  const lines = pid ? parseErrorLines(await dev.logcat(`${window} --pid=${pid} ${shq("*:E")}`), 40) : [];
  return lines;
}

/** The app's launcher activity, as package/activity. */
export async function launcherComponent(dev, pkg) {
  const out = await dev.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`);
  const line = out.split("\n").map((s) => s.trim()).filter(Boolean).pop();
  if (line && line.includes("/") && !/no activity/i.test(line)) return line;
  throw new Error(`${pkg} has no launcher activity; set android.activity`);
}

function safeDecode(png) {
  try {
    return decodePNG(png);
  } catch {
    return null;
  }
}

async function readRuntime(dev, ctx, since, lastNodes) {
  const window = since ? `-T ${shq(since)}` : "-t 2000";
  const crashText = await dev.logcat(`-b crash ${window}`);
  const pid = await dev.pidof(ctx.pkg);
  const errorText = pid ? await dev.logcat(`${window} --pid=${pid} ${shq("*:E")}`) : "";
  const anrText = await dev.logcat(`-b events ${window} -s am_anr`);
  const stats = ctx.info.emulator ? null : parseFrameStats((await dev.shellQuiet(`dumpsys gfxinfo ${ctx.pkg}`)).out);
  const fg = foregroundPackage(lastNodes);
  const baseline = new Set((ctx.launchErrors ?? []).map(normalizeError));
  return {
    crashes: parseCrashes(crashText, ctx.pkg),
    errors: parseErrorLines(errorText, 40).filter((e) => !baseline.has(normalizeError(e))).slice(0, 10),
    anr: anrText.includes(ctx.pkg),
    appRunning: Boolean(pid),
    foreground: fg && fg !== ctx.pkg ? fg : null,
    frameStats: stats,
  };
}

/** Captures one screen: a route (launch or deep link) or a scenario's end state. */
export async function captureNativeScreen(dev, ctx, { route, scenario = null, viewportName, variant = {}, dir, component }) {
  const since = await dev.logTime().catch(() => null);
  if (ctx.coldStart) await dev.forceStop(ctx.pkg);
  if (isLaunchRoute(route)) await dev.launch(component);
  else await dev.openUri(route, ctx.pkg);
  let state = await readState(dev, ctx);
  const steps = [];
  const warnings = [];
  let stepError = null;
  if (scenario) {
    for (const [i, step] of (scenario.steps ?? []).entries()) {
      try {
        const r = await runNativeStep(dev, step, state, ctx);
        state = r.state;
        steps.push(r.log);
        if (r.warning) warnings.push(`step ${i + 1}: ${r.warning}`);
      } catch (err) {
        stepError = `step ${i + 1}: ${err.message}`;
        break;
      }
    }
    if (scenario.settleMs) {
      await (ctx.sleep ?? realSleep)(scenario.settleMs);
      state = await readState(dev, ctx);
    }
  }
  if (!ctx.info.emulator) await dev.shellQuiet(`dumpsys gfxinfo ${ctx.pkg} reset`);
  const { frames, scroll } = await captureFrames(dev, state, ctx);
  const activity = parseActivity(await dev.focusedWindow());
  const runtime = await readRuntime(dev, ctx, since, frames[frames.length - 1].nodes);
  const slug = scenario ? `${routeSlug(route)}.${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : routeSlug(route);
  const files = [];
  for (const [i, f] of frames.entries()) {
    const file = path.join(dir, `${slug}.${viewportName}.${i === 0 ? "fold" : `frame${i + 1}`}.png`);
    await writeFile(file, f.png);
    files.push(file);
  }
  const audit = buildNativeAudit({
    frames: frames.map((f) => ({ nodes: f.nodes, image: safeDecode(f.png) })),
    info: ctx.info,
    app: ctx.app,
    variant,
    activity,
    scroll,
    runtime,
  });
  if (state.dumpError) audit.dumpError = state.dumpError;
  const auditPath = path.join(dir, `${slug}.${viewportName}.audit.json`);
  await writeFile(auditPath, JSON.stringify(audit, null, 2));
  return {
    platform: "android",
    route: scenario ? scenarioLabel(route, scenario.name) : route,
    path: route,
    url: isLaunchRoute(route) ? `android-app://${ctx.pkg}` : route,
    viewport: viewportName,
    title: audit.screen.title,
    fold: files[0],
    frames: files,
    audit: auditPath,
    scenario: scenario?.name,
    steps,
    stepError,
    stepWarnings: warnings,
    settled: state.settled,
    auth: false,
  };
}

/**
 * Captures every route and scenario at every viewport (each viewport a variant of
 * the device: night mode, font scale) and writes the manifest that critique and
 * compare read. Dependencies can be injected for tests: run (the command runner),
 * adb (its path), sleep and clock.
 */
export async function captureAndroid(config, deps = {}) {
  const opts = { ...ANDROID_DEFAULTS, ...(config.android ?? {}) };
  if (!opts.package) throw new Error("android.package is required: the application id of the app to capture, such as com.example.app");
  const run = deps.run ?? createRunner();
  const adb = deps.adb ?? (await findAdb({ configured: opts.adb }));
  const devices = parseDevices((await run(adb, ["devices", "-l"])).toString("utf8"));
  const chosen = pickDevice(devices, opts.serial);
  const dev = androidDevice({ adb, serial: chosen.serial, run });
  const info = await deviceInfo(dev);
  const installed = await dev.shellQuiet(`pm path ${opts.package}`);
  if (!installed.ok || !installed.out.includes("package:")) throw new Error(`${opts.package} is not installed on ${chosen.serial}`);
  const versionName = /versionName=(\S+)/.exec((await dev.shellQuiet(`dumpsys package ${opts.package} | grep versionName`)).out)?.[1] ?? null;
  const component = opts.activity ? `${opts.package}/${opts.activity}` : await launcherComponent(dev, opts.package);
  const dir = path.join(config.out, config.label);
  await mkdir(dir, { recursive: true });
  const restorePath = path.join(config.out, `.ui-critic-android-${chosen.serial.replace(/[^a-z0-9]+/gi, "-")}.restore.json`);
  await restoreLeftover(dev, restorePath);
  const ctx = {
    pkg: opts.package,
    app: { package: opts.package, versionName },
    info,
    coldStart: opts.coldStart,
    scrollFrames: opts.scrollFrames,
    settleTimeoutMs: opts.settleTimeoutMs,
    settleIntervalMs: deps.settleIntervalMs ?? 200,
    waitForTimeoutMs: opts.waitForTimeoutMs,
    sleep: deps.sleep ?? realSleep,
    clock: deps.clock ?? Date.now,
    secrets: await readEnvFile(opts.envFile),
  };
  const original = await prepareDevice(dev, opts, restorePath);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await restoreDevice(dev, original, restorePath, opts);
  };
  const onSignal = () => {
    restore().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const shots = [];
  try {
    ctx.launchErrors = await launchBaseline(dev, ctx, component);
    for (const [viewportName, requested] of Object.entries(config.viewports)) {
      const variant = await applyVariant(dev, requested ?? {}, original, { cleanStatusBar: opts.cleanStatusBar, sleep: ctx.sleep });
      for (const entry of config.routes.map(normalizeRoute)) {
        const shot = await captureNativeScreen(dev, ctx, { route: entry.path, viewportName, variant, dir, component });
        shots.push(shot);
        process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route} (${shot.frames.length} frame${shot.frames.length === 1 ? "" : "s"})\n`);
      }
      for (const scenario of scenariosAt(config.scenarios ?? [], viewportName)) {
        const shot = await captureNativeScreen(dev, ctx, { route: scenario.route ?? "launch", scenario, viewportName, variant, dir, component });
        shots.push(shot);
        const note = shot.stepError ? ` (step failed: ${shot.stepError.slice(0, 100)})` : shot.stepWarnings.length ? ` (${shot.stepWarnings.length} step(s) changed nothing)` : "";
        process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route}${note}\n`);
      }
    }
  } finally {
    await restore();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const manifest = {
    label: config.label,
    platform: "android",
    base: opts.package,
    app: ctx.app,
    device: { serial: chosen.serial, model: info.model, android: info.android, density: info.density, emulator: info.emulator },
    // Errors the app logs on every plain launch, reported once here instead of on every screen.
    launchErrors: (ctx.launchErrors ?? []).slice(0, 10),
    capturedAt: new Date().toISOString(),
    viewports: config.viewports,
    hideSelectors: [],
    shots,
    skipped: [],
    dir,
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
