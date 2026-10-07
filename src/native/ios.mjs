import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createRunner } from "./adb.mjs";
import { isLaunchRoute } from "./steps.mjs";
import { IOS_DEFAULTS } from "../config.mjs";
import { decodePNG, imageSize } from "../png.mjs";
import { dominantColors } from "../pixels.mjs";
import { normalizeRoute } from "../steps.mjs";
import { routeSlug, scenarioLabel, scenariosAt } from "../capture.mjs";

/**
 * iOS Simulator capture (experimental) over `xcrun simctl`, on macOS with Xcode's
 * command line tools. A screen is the app's launch screen or a deep link, optionally
 * followed by more deep links and waits; tapping needs a UI driver the tool does not
 * ship yet. Viewports are variants of the simulator: appearance (light or dark) and
 * Dynamic Type content size. The status bar is frozen at 9:41 with full bars, and
 * every changed setting is put back afterwards.
 *
 * It has been exercised against a simulated simctl only, not a real simulator.
 */

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The booted simulators in `simctl list devices booted -j` output. */
export function parseSimulators(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const out = [];
  for (const [runtime, devices] of Object.entries(data?.devices ?? {})) {
    for (const d of devices ?? []) {
      if (d.state !== "Booted") continue;
      out.push({ udid: d.udid, name: d.name, runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "").replace(/-/g, ".").replace(/^(iOS|tvOS|watchOS|xrOS)\./, "$1 ") });
    }
  }
  return out;
}

/** The simulator to use: the configured udid, or the only booted one; several are refused. */
export function pickSimulator(sims, udid) {
  if (udid) {
    const s = sims.find((x) => x.udid === udid);
    if (!s) throw new Error(`simulator ${udid} is not booted (booted: ${sims.map((x) => `${x.name} ${x.udid}`).join(", ") || "none"})`);
    return s;
  }
  if (!sims.length) throw new Error("no iOS simulator is booted (boot one in Xcode or with xcrun simctl boot)");
  if (sims.length > 1) throw new Error(`more than one simulator is booted: ${sims.map((s) => `${s.name} (${s.udid})`).join(", ")}. Choose one with ios.udid or --udid`);
  return sims[0];
}

/** A booted simulator, bound to its udid. */
export function simulator({ udid, run }) {
  const simctl = async (args, opts) => (await run("xcrun", ["simctl", ...args], opts)).toString("utf8").trim();
  const quiet = async (args) => {
    try {
      return await simctl(args);
    } catch {
      return null;
    }
  };
  return {
    udid,
    launch: (bundleId) => simctl(["launch", udid, bundleId]),
    terminate: (bundleId) => quiet(["terminate", udid, bundleId]),
    openUrl: (url) => simctl(["openurl", udid, url]),
    appearance: () => quiet(["ui", udid, "appearance"]),
    setAppearance: (value) => simctl(["ui", udid, "appearance", value]),
    contentSize: () => quiet(["ui", udid, "content_size"]),
    setContentSize: (value) => simctl(["ui", udid, "content_size", value]),
    freezeStatusBar: () =>
      simctl(["status_bar", udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"]),
    clearStatusBar: () => quiet(["status_bar", udid, "clear"]),
    async screenshot(file) {
      await simctl(["io", udid, "screenshot", "--type=png", file]);
      return readFile(file);
    },
  };
}

/** Waits until two consecutive screenshots are identical, or the attempts run out. */
async function settledShot(sim, file, { sleep, attempts = 6, intervalMs = 400 }) {
  let prev = await sim.screenshot(file);
  for (let i = 0; i < attempts; i += 1) {
    await sleep(intervalMs);
    const next = await sim.screenshot(file);
    if (next.equals(prev)) return { png: next, settled: true };
    prev = next;
  }
  return { png: prev, settled: false };
}

/** Captures every route and scenario at every viewport and writes the manifest. */
export async function captureIOS(config, deps = {}) {
  if (process.platform !== "darwin" && !deps.run) {
    throw new Error("iOS capture needs macOS with Xcode's command line tools (xcrun simctl). On another system, take the screenshots another way and use --from-images");
  }
  const opts = { ...IOS_DEFAULTS, ...(config.ios ?? {}) };
  if (!opts.bundleId) throw new Error("ios.bundleId is required: the bundle identifier of the app to capture, such as com.example.app");
  const run = deps.run ?? createRunner();
  const sleep = deps.sleep ?? realSleep;
  const sims = parseSimulators((await run("xcrun", ["simctl", "list", "devices", "booted", "-j"])).toString("utf8"));
  const sim = simulator({ udid: pickSimulator(sims, opts.udid).udid, run });
  const info = sims.find((s) => s.udid === sim.udid);
  const dir = path.join(config.out, config.label);
  await mkdir(dir, { recursive: true });
  const original = { appearance: await sim.appearance(), contentSize: await sim.contentSize() };
  if (opts.cleanStatusBar) await sim.freezeStatusBar();
  const shots = [];
  const capture = async ({ route, scenario, viewportName, variant }) => {
    await sim.terminate(opts.bundleId);
    if (isLaunchRoute(route)) await sim.launch(opts.bundleId);
    else await sim.openUrl(route);
    await sleep(opts.settleMs);
    const steps = [];
    let stepError = null;
    for (const [i, step] of (scenario?.steps ?? []).entries()) {
      try {
        if (step.goto) {
          await sim.openUrl(step.goto);
          await sleep(opts.settleMs);
          steps.push(`goto ${step.goto}`);
        } else if (step.wait !== undefined) {
          await sleep(step.wait);
          steps.push(`wait ${step.wait}ms`);
        }
      } catch (err) {
        stepError = `step ${i + 1}: ${err.message}`;
        break;
      }
    }
    const slug = scenario ? `${routeSlug(route)}.${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : routeSlug(route);
    const file = path.join(dir, `${slug}.${viewportName}.fold.png`);
    const { png, settled } = await settledShot(sim, file, { sleep });
    const facts = {
      platform: "ios",
      device: { model: info?.name ?? "simulator", os: info?.runtime ?? null, emulator: true },
      app: { bundleId: opts.bundleId },
      variant,
      image: imageSize(png),
    };
    try {
      facts.palette = dominantColors(decodePNG(png));
    } catch {
      // a screenshot the decoder cannot read simply has no palette fact
    }
    const audit = path.join(dir, `${slug}.${viewportName}.audit.json`);
    await writeFile(audit, JSON.stringify(facts, null, 2));
    return {
      platform: "ios",
      route: scenario ? scenarioLabel(route, scenario.name) : route,
      path: route,
      url: isLaunchRoute(route) ? `ios-app://${opts.bundleId}` : route,
      viewport: viewportName,
      title: scenario ? `${route} [${scenario.name}]` : route,
      fold: file,
      frames: [file],
      audit,
      scenario: scenario?.name,
      steps,
      stepError,
      stepWarnings: [],
      settled,
      auth: false,
    };
  };
  try {
    for (const [viewportName, requested] of Object.entries(config.viewports)) {
      const variant = { appearance: requested?.appearance ?? original.appearance ?? "light", contentSize: requested?.contentSize ?? original.contentSize ?? "large" };
      if (variant.appearance && variant.appearance !== (await sim.appearance())) await sim.setAppearance(variant.appearance);
      if (requested?.contentSize || original.contentSize) {
        if (variant.contentSize !== (await sim.contentSize())) await sim.setContentSize(variant.contentSize);
      }
      for (const entry of config.routes.map(normalizeRoute)) {
        shots.push(await capture({ route: entry.path, viewportName, variant }));
        process.stderr.write(`  ${viewportName.padEnd(8)} ${entry.path}\n`);
      }
      for (const scenario of scenariosAt(config.scenarios ?? [], viewportName)) {
        const shot = await capture({ route: scenario.route ?? "launch", scenario, viewportName, variant });
        shots.push(shot);
        process.stderr.write(`  ${viewportName.padEnd(8)} ${shot.route}${shot.stepError ? ` (step failed: ${shot.stepError.slice(0, 100)})` : ""}\n`);
      }
    }
  } finally {
    if (original.appearance && /^(light|dark)$/.test(original.appearance)) await sim.setAppearance(original.appearance).catch(() => {});
    if (original.contentSize) await sim.setContentSize(original.contentSize).catch(() => {});
    if (opts.cleanStatusBar) await sim.clearStatusBar();
  }
  const manifest = {
    label: config.label,
    platform: "ios",
    base: opts.bundleId,
    app: { bundleId: opts.bundleId },
    device: { udid: sim.udid, model: info?.name ?? null, os: info?.runtime ?? null, emulator: true },
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
