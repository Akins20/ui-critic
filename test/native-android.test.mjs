import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeAndroid, PKG } from "./fake-android.mjs";
import {
  captureAndroid,
  parseErrorLines,
  parseCrashes,
  parseFrameStats,
  parseActivity,
  frameOffsets,
  normalizeError,
  guessTitle,
} from "../src/native/android.mjs";
import { parseDevices, pickDevice, keyCode, inputTextArg, shq, findAdb, deviceInfo, androidDevice } from "../src/native/adb.mjs";
import { parseHierarchy } from "../src/native/hierarchy.mjs";

const fast = { adb: "adb", sleep: async () => {}, settleIntervalMs: 0 };
const exists = (p) => access(p).then(() => true, () => false);

async function run(overrides = {}, device = fakeAndroid()) {
  const out = await mkdtemp(path.join(tmpdir(), "uic-android-"));
  const config = {
    out,
    label: "before",
    android: { package: PKG, scrollFrames: 3, ...(overrides.android ?? {}) },
    routes: overrides.routes ?? ["launch", "fake://promo"],
    viewports: overrides.viewports ?? { phone: {} },
    scenarios: overrides.scenarios ?? [],
  };
  const manifest = await captureAndroid(config, { ...fast, run: device.run });
  return { manifest, device, out };
}

test("a capture cold starts each screen, follows deep links, scrolls to the end and writes the manifest", async () => {
  const { manifest, device } = await run();
  assert.equal(manifest.platform, "android");
  assert.equal(manifest.base, PKG);
  assert.equal(manifest.app.versionName, "1.2.3");
  assert.deepEqual(manifest.shots.map((s) => s.route), ["launch", "fake://promo"]);
  const home = manifest.shots[0];
  // Two frames: the first screen and one scrolled; the next drag moved nothing.
  assert.equal(home.frames.length, 2);
  assert.match(home.fold, /launch\.phone\.fold\.png$/);
  assert.match(home.frames[1], /launch\.phone\.frame2\.png$/);
  assert.equal(home.title, "Fake Home");
  assert.ok(device.state.calls.filter((c) => c === `am force-stop ${PKG}`).length >= 3, "cold start before the baseline and each screen");
});

test("the audit measures targets in dp, unlabelled controls, and contrast from pixels, once across frames", async () => {
  const { manifest } = await run({ routes: ["launch"] });
  const audit = JSON.parse(await readFile(manifest.shots[0].audit, "utf8"));
  assert.equal(audit.platform, "android");
  assert.deepEqual(audit.device.screenDp, { width: 360, height: 800 });
  assert.equal(audit.interactive.unlabeledCount, 1, "the bare ImageButton has no name");
  assert.deepEqual(audit.interactive.unlabeled[0], { kind: "ImageButton", id: null, w: 32, h: 32, at: "300,270 dp", frame: 1 });
  assert.ok(audit.interactive.under48dp.some((t) => t.kind === "ImageButton" && t.w === 32));
  const low = audit.textContrast.lowest[0];
  assert.equal(low.text, "Low contrast");
  assert.ok(low.ratio < 3, `ratio ${low.ratio}`);
  assert.equal(audit.textContrast.lowest.filter((s) => s.text === "Low contrast").length, 1, "seen in both frames, counted once");
  assert.deepEqual(audit.frameOffsetsPx, [0, 200]);
  assert.ok(audit.text.shown.includes("Help"), "text from the second frame is listed");
  assert.equal(audit.screen.scroll, "captured to the end of its scroll");
  assert.match(audit.interactive.note, /hitSlop/);
});

test("runtime facts: a crash on a deep-linked screen is caught, and launch chatter is filtered as a baseline", async () => {
  const { manifest } = await run({ routes: ["launch", "fake://promo", "fake://settings"] });
  const [home, promo, settings] = await Promise.all(manifest.shots.map(async (s) => JSON.parse(await readFile(s.audit, "utf8"))));
  assert.deepEqual(promo.runtime.crashes, ["fatal exception: java.lang.IllegalStateException: promo exploded"]);
  assert.equal(promo.runtime.appRunning, false);
  assert.deepEqual(home.runtime.errors, [], "startup chatter appears on every launch and is not this screen's problem");
  assert.deepEqual(settings.runtime.errors, ["Settings: failed to load toggle state"]);
  assert.ok(manifest.launchErrors.some((e) => e.startsWith("Fake: startup chatter")));
});

test("the device is put back exactly: animations, demo mode, font scale and night mode, and the restore file is removed", async () => {
  const { device, out } = await run({ routes: ["launch"], viewports: { phone: {}, "phone-dark": { night: true, fontScale: 1.3 } } });
  const s = device.state;
  assert.deepEqual(s.settings, { "global/window_animation_scale": "1.0", "global/transition_animation_scale": "1.0", "global/sysui_demo_allowed": "0", "system/font_scale": "1.0" });
  assert.ok(!("global/animator_duration_scale" in s.settings), "an unset setting is deleted, not written as null");
  assert.equal(s.night, "no");
  assert.ok(s.calls.includes("cmd uimode night yes"), "the dark variant was applied");
  assert.ok(s.calls.includes("settings put system font_scale 1.3"), "the large-text variant was applied");
  // The status bar is frozen at the start and again after the variant restarted it.
  assert.equal(s.demo.filter((c) => c === "clock").length, 2);
  assert.equal(s.demo[s.demo.length - 1], "exit");
  assert.equal(await exists(path.join(out, ".ui-critic-android-emulator-5554.restore.json")), false);
});

test("a step that changes nothing is flagged, and a step whose target is missing fails naming what is on screen", async () => {
  const { manifest } = await run({
    routes: ["launch"],
    scenarios: [
      { name: "open-settings", route: "launch", steps: [{ click: "text=Settings" }] },
      { name: "dead-tap", route: "launch", steps: [{ click: "text=Header text" }] },
      { name: "missing", route: "launch", steps: [{ click: "text=Nowhere" }] },
    ],
  });
  const [, open, dead, missing] = manifest.shots;
  assert.equal(open.title, "Settings");
  assert.deepEqual(open.stepWarnings, []);
  assert.deepEqual(dead.stepWarnings, ["step 1: click text=Header text changed nothing on screen"]);
  assert.match(missing.stepError, /^step 1: nothing on screen matches text=Nowhere \(on screen: "Fake Home", "Profile", "Settings"/);
  assert.equal(missing.route, "launch [missing]");
});

test("a run killed mid-capture is cleaned up by the next one from its restore file", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "uic-leftover-"));
  // The crashed run left animations off; its restore file holds the real values.
  const device = fakeAndroid({ settings: { "global/window_animation_scale": "0", "global/transition_animation_scale": "0", "global/animator_duration_scale": "0", "global/sysui_demo_allowed": "1", "system/font_scale": "1.0" } });
  await writeFile(
    path.join(out, ".ui-critic-android-emulator-5554.restore.json"),
    JSON.stringify({ serial: "emulator-5554", savedAt: "2026-10-07T09:00:00Z", cleanStatusBar: true, original: { night: "no", font_scale: "1.0", sysui_demo_allowed: "0", window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: null } }),
  );
  await captureAndroid({ out, label: "x", android: { package: PKG }, routes: ["launch"], viewports: { phone: {} }, scenarios: [] }, { ...fast, run: device.run });
  assert.equal(device.state.settings["global/window_animation_scale"], "1.0");
  assert.equal(device.state.settings["global/sysui_demo_allowed"], "0");
  assert.ok(!("global/animator_duration_scale" in device.state.settings));
});

test("two connected devices and no serial: the capture refuses instead of picking one", async () => {
  const device = fakeAndroid({ devices: [["29555f15", "device", "Personal_Phone"], ["emulator-5554", "device", "sdk_gphone"]] });
  await assert.rejects(() => run({}, device), /more than one Android device is connected: 29555f15 \(Personal_Phone\), emulator-5554/);
  assert.equal(device.state.calls.length, 0, "nothing at all was sent to either device");
  const chosen = await run({ android: { serial: "emulator-5554" } }, fakeAndroid({ devices: [["29555f15", "device", "P"], ["emulator-5554", "device", "E"]] }));
  assert.equal(chosen.manifest.device.serial, "emulator-5554");
});

test("device parsing and choice", () => {
  const list = parseDevices("List of devices attached\nemulator-5554\tdevice product:sdk model:sdk_gphone device:emu64\nR58M\tunauthorized usb:1\n");
  assert.deepEqual(list[0], { serial: "emulator-5554", state: "device", model: "sdk_gphone", emulator: true });
  assert.equal(list[1].state, "unauthorized");
  assert.equal(pickDevice(list).serial, "emulator-5554");
  assert.throws(() => pickDevice(list, "R58M"), /is unauthorized, not ready/);
  assert.throws(() => pickDevice([], undefined), /no Android device/);
  assert.throws(() => pickDevice(list, "nope"), /is not connected/);
});

test("adb is found in the SDK before the PATH, and an explicit path must exist", async () => {
  const have = new Set([path.join("C:/sdk", "platform-tools", "adb.exe")]);
  const exists2 = async (p) => have.has(p);
  assert.equal(await findAdb({ env: { ANDROID_HOME: "C:/sdk" }, platform: "win32", exists: exists2 }), path.join("C:/sdk", "platform-tools", "adb.exe"));
  assert.equal(await findAdb({ env: {}, platform: "linux", exists: async () => false }), "adb");
  await assert.rejects(() => findAdb({ configured: "/nope/adb", exists: async () => false }), /adb not found at \/nope\/adb/);
});

test("keys, typed text and shell quoting are safe for the device shell", () => {
  assert.equal(keyCode("Back"), 4);
  assert.equal(keyCode("enter"), 66);
  assert.equal(keyCode("KEYCODE_VOLUME_UP"), "KEYCODE_VOLUME_UP");
  assert.equal(keyCode(24), 24);
  assert.throws(() => keyCode("Hyper"), /unknown key/);
  assert.equal(inputTextArg("a b&c;d"), "a%sb\\&c\\;d");
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test("device info reads the override size and density and spots an emulator", async () => {
  const answers = {
    "getprop ro.product.model": "Pixel 9",
    "getprop ro.build.version.release": "16",
    "getprop ro.build.version.sdk": "36",
    "wm size": "Physical size: 1080x2424\nOverride size: 720x1616",
    "wm density": "Physical density: 420\nOverride density: 280",
    "getprop ro.kernel.qemu": "",
    "getprop ro.hardware": "tensor",
  };
  const dev = androidDevice({ adb: "adb", serial: "x", run: async (_a, args) => Buffer.from(answers[args[3]] ?? "") });
  const info = await deviceInfo(dev);
  assert.deepEqual(info.screen, { width: 720, height: 1616 });
  assert.equal(info.density, 280);
  assert.equal(info.pxPerDp, 1.75);
  assert.equal(info.emulator, false);
});

test("log parsing: error lines without stack frames, crashes by package, frame stats, the focused activity", () => {
  const log = [
    "10-07 10:11:50.129  3389  3399 E Ads: request failed: 503",
    "10-07 10:11:50.129  3389  3399 E Ads: \tat com.x.Y.z(Y.java:1)",
    "10-07 10:11:50.130  3389  3399 E Ads: request failed: 503",
    "10-07 10:11:51.000  3389  3399 E ReactNativeJS: TypeError: undefined is not an object",
  ].join("\n");
  assert.deepEqual(parseErrorLines(log), ["Ads: request failed: 503", "ReactNativeJS: TypeError: undefined is not an object"]);
  const crash = [
    "10-07 10:00:01.000  1  1 E AndroidRuntime: FATAL EXCEPTION: main",
    "10-07 10:00:01.000  1  1 E AndroidRuntime: Process: com.other, PID: 1",
    "10-07 10:00:01.000  1  1 E AndroidRuntime: java.lang.Error: not ours",
    "10-07 10:00:02.000  2  2 F DEBUG: pid: 2, tid: 2, name: main  >>> com.mine <<<",
    "10-07 10:00:02.000  2  2 F DEBUG: signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0",
  ].join("\n");
  assert.deepEqual(parseCrashes(crash, "com.mine"), ["native crash: signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0"]);
  assert.deepEqual(parseFrameStats("Total frames rendered: 120\nJanky frames: 18 (15.00%)\n90th percentile: 21ms"), { frames: 120, jankyPercent: 15, p90Ms: 21 });
  assert.equal(parseFrameStats("Total frames rendered: 4"), null);
  assert.equal(parseActivity("  mCurrentFocus=Window{6fb4494 u0 com.android.settings/com.android.settings.Settings}"), "com.android.settings/com.android.settings.Settings");
  assert.equal(normalizeError("Fake: startup chatter 12 at 0x7f00"), normalizeError("Fake: startup chatter 13 at 0x8a11"));
});

test("frame offsets follow the rows that moved and ignore the bars that did not", () => {
  const frame = (rows) => parseHierarchy(`<hierarchy>${rows.map(([t, y]) => `<node text="${t}" bounds="[16,${y}][200,${y + 30}]"/>`).join("")}</hierarchy>`).nodes;
  const a = frame([["Title", 40], ["Row one", 320], ["Row two", 400]]);
  const b = frame([["Title", 40], ["Row one", 120], ["Row two", 200], ["Row three", 600]]);
  assert.deepEqual(frameOffsets([a, b]), [0, 200]);
  assert.deepEqual(frameOffsets([a]), [0]);
});

test("the title is the tallest text near the top, else the activity name", () => {
  const nodes = parseHierarchy(`<hierarchy><node text="9:41" bounds="[0,0][100,30]"/><node text="Display &amp; touch" bounds="[50,300][800,460]"/><node text="Brightness" bounds="[50,600][400,650]"/></hierarchy>`).nodes;
  const info = { screen: { width: 1080, height: 2400 }, pxPerDp: 2.625 };
  assert.equal(guessTitle(nodes, info, "com.x/.Main"), "Display & touch");
  assert.equal(guessTitle([], info, "com.x/com.x.SubSettings"), "SubSettings");
});
