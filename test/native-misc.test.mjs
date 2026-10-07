import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeStepProblems, nativeRouteProblems, isLaunchRoute } from "../src/native/steps.mjs";
import { DEFAULTS, merge, validate, loadConfig, init, NATIVE_DISCIPLINES, DEFAULT_DISCIPLINES } from "../src/config.mjs";
import { parseImageName, viewportFromSize, captureFromImages } from "../src/images.mjs";
import { parseSimulators, pickSimulator, captureIOS } from "../src/native/ios.mjs";
import { suggestSelector, inspectScreen, renderInspect } from "../src/native/inspect.mjs";
import { parseHierarchy } from "../src/native/hierarchy.mjs";
import { pageTask, siteTask, rulesFor, disciplinesFor, followablePages, preamble } from "../src/critique.mjs";
import { detailImages, allImages, nouns, isNative } from "../src/shots.mjs";
import { auditSummary } from "../src/audit.mjs";
import { renderCritique } from "../src/report.mjs";
import { encodePNG } from "../src/png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("native steps: the touch vocabulary is accepted and web-only steps are refused with the reason", () => {
  assert.deepEqual(
    nativeStepProblems([
      { goto: "fake://promo" },
      { click: "text=Settings" },
      { tap: "desc=Menu" },
      { longPress: "id=row" },
      { fill: { selector: "hint=Email", value: "a@b.co" } },
      { fill: { selector: "id=password", envVar: "APP_PASS" } },
      { press: "Back" },
      { hideKeyboard: true },
      { wait: 300 },
      { waitFor: "text=Done" },
      { scroll: 400 },
      { scroll: -200 },
      { swipe: "left" },
    ]),
    [],
  );
  assert.match(nativeStepProblems([{ hover: ".card" }])[0], /hover is a web step: a touch screen has no hover/);
  assert.match(nativeStepProblems([{ waitForURL: "**/x" }])[0], /an app has no URL/);
  assert.match(nativeStepProblems([{ goto: "/plans" }])[0], /must be a deep link/);
  assert.match(nativeStepProblems([{ swipe: "sideways" }])[0], /swipe must be one of/);
  assert.match(nativeStepProblems([{ fill: { selector: "x", value: "caf\u00e9" } }])[0], /plain ASCII/);
  assert.match(nativeStepProblems([{ scroll: 0 }])[0], /non-zero/);
  assert.match(nativeStepProblems([{ click: "x" }], "s", "ios")[0], /not available on ios yet/);
  assert.deepEqual(nativeStepProblems([{ goto: "app://x" }, { wait: 10 }], "s", "ios"), []);
});

test("native routes are the launch screen or a deep link", () => {
  assert.ok(isLaunchRoute("launch") && isLaunchRoute("/"));
  assert.deepEqual(nativeRouteProblems("myapp://plans/12"), []);
  assert.match(nativeRouteProblems("/plans")[0], /must be "launch"/);
});

test("an android config validates variants and routes, and gets native defaults when the file is silent", async () => {
  const base = (over) => ({ ...merge(DEFAULTS, { platform: "android", android: { package: "com.x.app" } }), viewports: { phone: {} }, routes: ["launch"], ...over });
  assert.doesNotThrow(() => validate(base({ viewports: { phone: {}, dark: { night: true, fontScale: 1.3 } } })));
  assert.throws(() => validate(base({ viewports: { big: { fontScale: 9 } } })), /fontScale must be a number from 0.5 to 3/);
  assert.throws(() => validate(base({ viewports: { odd: { night: "yes" } } })), /night must be true or false/);
  assert.throws(() => validate(base({ routes: ["/shop"] })), /must be "launch"/);
  assert.throws(() => validate(base({ android: { ...DEFAULTS.android, package: "not a package" } })), /not an application id/);
  assert.throws(() => validate(base({ scenarios: [{ name: "h", steps: [{ hover: "x" }] }] })), /web step/);
  assert.throws(() => validate({ ...base({}), platform: "desktop" }), /platform must be one of web, android, ios/);

  const dir = await mkdtemp(path.join(tmpdir(), "uic-native-cfg-"));
  const file = path.join(dir, "ui-critic.config.json");
  await writeFile(file, JSON.stringify({ platform: "android", android: { package: "com.x.app" } }));
  const cfg = await loadConfig({ config: file }, {});
  assert.deepEqual(cfg.viewports, { phone: {} });
  assert.deepEqual(cfg.routes, ["launch"]);
  assert.equal(cfg.disciplines, NATIVE_DISCIPLINES);
  assert.equal(cfg.android.scrollFrames, 3, "the android defaults merge under the file's block");
  const flagged = await loadConfig({ config: path.join(dir, "missing.json"), platform: "android", package: "com.y.app", serial: "emulator-5556" }, {}).catch((e) => e);
  assert.ok(flagged instanceof Error, "a missing --config file is still an error");
});

test("init writes a native starter without web-only keys and without the web viewports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uic-native-init-"));
  await init({ platform: "android", pkg: "com.otesc.rooster", cwd: dir });
  const cfg = JSON.parse(await readFile(path.join(dir, "ui-critic.config.json"), "utf8"));
  assert.equal(cfg.platform, "android");
  assert.equal(cfg.android.package, "com.otesc.rooster");
  assert.deepEqual(Object.keys(cfg.viewports), ["phone", "phone-dark"]);
  assert.deepEqual(cfg.routes, ["launch"]);
  for (const k of ["base", "hideSelectors", "auth", "followRequests", "ios", "fromImages", "label"]) assert.ok(!(k in cfg), `${k} is not in a native starter`);
  const web = await mkdtemp(path.join(tmpdir(), "uic-web-init-"));
  await init({ cwd: web });
  const wcfg = JSON.parse(await readFile(path.join(web, "ui-critic.config.json"), "utf8"));
  assert.ok(!("android" in wcfg) && !("ios" in wcfg), "a web starter carries no app blocks");
  assert.equal(wcfg.platform, "web");
});

test("screenshot names give the screen, the viewport and the frame; shape gives a fallback viewport", () => {
  assert.deepEqual(parseImageName("checkout.png"), { screen: "checkout", viewport: null, frame: 1 });
  assert.deepEqual(parseImageName("checkout.phone.png"), { screen: "checkout", viewport: "phone", frame: 1 });
  assert.deepEqual(parseImageName("checkout.phone.2.png"), { screen: "checkout", viewport: "phone", frame: 2 });
  assert.deepEqual(parseImageName("plan.v2.tablet.3.webp"), { screen: "plan.v2", viewport: "tablet", frame: 3 });
  assert.equal(viewportFromSize({ width: 1170, height: 2532 }), "phone");
  assert.equal(viewportFromSize({ width: 1440, height: 900 }), "desktop");
  assert.equal(viewportFromSize({ width: 1668, height: 2388 }), "tablet");
});

test("a folder of screenshots becomes a capture with frames, facts and a manifest", async () => {
  const src = await mkdtemp(path.join(tmpdir(), "uic-images-"));
  const img = (w, h, rgb) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i += 1) data.set([...rgb, 255], i * 4);
    return encodePNG({ width: w, height: h, data });
  };
  await writeFile(path.join(src, "home.png"), img(60, 130, [250, 250, 250]));
  await writeFile(path.join(src, "home.2.png"), img(60, 130, [240, 240, 240]));
  await writeFile(path.join(src, "checkout.desktop.png"), img(144, 90, [10, 20, 30]));
  await writeFile(path.join(src, "notes.txt"), "ignored");
  const out = await mkdtemp(path.join(tmpdir(), "uic-images-out-"));
  const manifest = await captureFromImages({ from: src, out, label: "before" });
  assert.equal(manifest.platform, "images");
  assert.deepEqual(manifest.shots.map((s) => `${s.route}@${s.viewport}:${s.frames.length}`), ["checkout@desktop:1", "home@phone:2"]);
  const facts = JSON.parse(await readFile(manifest.shots[1].audit, "utf8"));
  assert.deepEqual(facts.image, { width: 60, height: 130 });
  assert.equal(facts.palette[0].color, "#fafafa");
  const onDisk = JSON.parse(await readFile(path.join(out, "before", "manifest.json"), "utf8"));
  assert.equal(onDisk.shots.length, 2);
  await assert.rejects(() => captureFromImages({ from: path.join(src, "nope"), out, label: "x" }), /could not read the screenshots folder/);
  const empty = await mkdtemp(path.join(tmpdir(), "uic-images-empty-"));
  await assert.rejects(() => captureFromImages({ from: empty, out, label: "x" }), /no PNG, JPEG or WebP/);
});

test("iOS: booted simulators are parsed and chosen like devices, never guessed among several", () => {
  const json = { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "A1", name: "iPhone 16", state: "Booted" }, { udid: "B2", name: "iPad", state: "Shutdown" }] } };
  const sims = parseSimulators(json);
  assert.deepEqual(sims, [{ udid: "A1", name: "iPhone 16", runtime: "iOS 18.2" }]);
  assert.equal(pickSimulator(sims).udid, "A1");
  assert.throws(() => pickSimulator([...sims, { udid: "C3", name: "iPhone SE", runtime: "iOS 18.2" }]), /more than one simulator is booted/);
  assert.throws(() => pickSimulator([]), /no iOS simulator is booted/);
});

test("iOS capture drives simctl: status bar, appearance and content size per variant, restored afterwards", async () => {
  const calls = [];
  const sim = { appearance: "light", contentSize: "large" };
  const png = encodePNG({ width: 4, height: 8, data: new Uint8Array(4 * 8 * 4).fill(255) });
  const run = async (file, args) => {
    assert.equal(file, "xcrun");
    const [, verb, ...rest] = args;
    calls.push(args.slice(1).join(" "));
    if (verb === "list") return Buffer.from(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "U1", name: "iPhone 16", state: "Booted" }] } }));
    if (verb === "ui" && rest[1] === "appearance") return Buffer.from(rest[2] ? (sim.appearance = rest[2]) : sim.appearance);
    if (verb === "ui" && rest[1] === "content_size") return Buffer.from(rest[2] ? (sim.contentSize = rest[2]) : sim.contentSize);
    if (verb === "io") {
      await writeFile(rest[rest.length - 1], png);
      return Buffer.from("");
    }
    return Buffer.from("");
  };
  const out = await mkdtemp(path.join(tmpdir(), "uic-ios-"));
  const manifest = await captureIOS(
    { out, label: "before", ios: { bundleId: "com.x.app", settleMs: 0 }, routes: ["launch", "x://plans"], viewports: { phone: {}, big: { appearance: "dark", contentSize: "accessibility-large" } }, scenarios: [{ name: "deep", route: "launch", steps: [{ goto: "x://more" }, { wait: 0 }] }] },
    { run, sleep: async () => {} },
  );
  assert.equal(manifest.platform, "ios");
  assert.deepEqual(manifest.shots.map((s) => `${s.viewport}:${s.route}`), ["phone:launch", "phone:x://plans", "phone:launch [deep]", "big:launch", "big:x://plans", "big:launch [deep]"]);
  assert.deepEqual(manifest.shots[2].steps, ["goto x://more", "wait 0ms"]);
  assert.ok(calls.some((c) => c.startsWith("status_bar U1 override --time 9:41")));
  assert.ok(calls.includes("ui U1 appearance dark") && calls.includes("ui U1 content_size accessibility-large"));
  assert.ok(calls.includes("openurl U1 x://plans") && calls.includes("launch U1 com.x.app"));
  assert.equal(sim.appearance, "light", "appearance restored");
  assert.equal(sim.contentSize, "large", "content size restored");
  assert.equal(calls[calls.length - 1], "status_bar U1 clear");
  const facts = JSON.parse(await readFile(manifest.shots[3].audit, "utf8"));
  assert.deepEqual(facts.variant, { appearance: "dark", contentSize: "accessibility-large" });
});

test("iOS capture explains itself off macOS instead of failing obscurely", async () => {
  if (process.platform === "darwin") return;
  await assert.rejects(() => captureIOS({ out: tmpdir(), label: "x", ios: { bundleId: "com.x" }, routes: ["launch"], viewports: { phone: {} } }), /needs macOS/);
});

test("inspect suggests unique, readable selectors and flags what the audit would", () => {
  const { nodes } = parseHierarchy(readFileSync(path.join(here, "fixtures", "android", "settings-home.xml"), "utf8"));
  const info = { screen: { width: 1080, height: 2400 }, pxPerDp: 2.625 };
  const rows = inspectScreen(nodes, info);
  const row = rows.find((r) => r.tap && r.label.startsWith("Network"));
  assert.equal(row.selector, "text=Network & internet", "a row is reached through its title");
  assert.equal(rows.find((r) => r.label === "Search Settings" && r.tap).selector, "id=search_action_bar");
  assert.ok(rows.every((r) => !r.unlabeled), "every Settings row has a name");
  const table = renderInspect(rows, "header");
  assert.match(table, /interactive elements, 0 unlabelled/);
  const tiny = parseHierarchy(`<hierarchy><node class="android.widget.ImageButton" clickable="true" bounds="[0,0][40,40]"/><node class="android.widget.ImageButton" clickable="true" bounds="[100,0][140,40]"/></hierarchy>`).nodes;
  assert.equal(suggestSelector(tiny, tiny[1]), "class=ImageButton >> nth=1");
});

test("the critic's wording follows the capture: pages of a site, screens of an app", () => {
  assert.deepEqual(nouns("web"), { item: "page", items: "pages", whole: "site" });
  assert.deepEqual(nouns("android"), { item: "screen", items: "screens", whole: "app" });
  assert.ok(isNative("images") && !isNative("web") && !isNative(undefined));
  assert.match(rulesFor("android"), /native Android app/);
  assert.match(rulesFor("android"), /48dp/);
  assert.match(rulesFor("ios"), /Human Interface Guidelines/);
  assert.match(rulesFor("images"), /supplied, not a live capture|the team supplied/);
  assert.doesNotMatch(rulesFor("android"), /console errors/);
  assert.match(preamble(["a: b"], [], "android"), /sweep on every screen/);
  const cfg = { disciplines: DEFAULT_DISCIPLINES };
  assert.equal(disciplinesFor(cfg, "android"), NATIVE_DISCIPLINES);
  assert.equal(disciplinesFor(cfg, "web"), DEFAULT_DISCIPLINES);
  const custom = { disciplines: ["mine"] };
  assert.deepEqual(disciplinesFor(custom, "android"), ["mine"], "a custom list is never replaced");
});

test("a native screen's task offers its frames, says when it does not scroll, and warns about dead steps", () => {
  const scrolled = [{ path: "launch", title: "Home", frames: ["a.png", "b.png"], viewport: "phone" }];
  const flat = [{ path: "launch", title: "Home", frames: ["a.png"], viewport: "phone" }];
  assert.match(pageTask("launch", scrolled, "android"), /further scroll frames/);
  assert.match(pageTask("launch", flat, "android"), /does not scroll, so that is all of it/);
  const dead = [{ path: "launch", title: "Home", frames: ["a.png"], viewport: "phone", scenario: "swatch", steps: ["click desc=Teal"], stepWarnings: ["step 1: click desc=Teal changed nothing on screen"] }];
  const task = pageTask("launch [swatch]", dead, "android");
  assert.match(task, /Some steps had no visible effect \(step 1: click desc=Teal changed nothing on screen\)/);
  assert.match(task, /say plainly in a finding that the intended state was not reached/);
  const web = pageTask("/", [{ path: "/", title: "Home", full: "f.jpg", auth: true }], "web");
  assert.match(web, /full-page capture per viewport/);
  assert.match(web, /The visitor is signed in\. You already have/, "one full stop, not two");
  assert.match(siteTask("android", "x", ["Fake: chatter"]), /judge the whole app.*Errors the app logs on every plain launch/s);
  assert.doesNotMatch(siteTask("web", "x"), /every plain launch/);
});

test("frames and full pages are offered in the right order, labelled", () => {
  assert.deepEqual(detailImages({ frames: ["1.png", "2.png", "3.png"] }).map((i) => i.label), ["scrolled down, frame 2 of 3", "scrolled down, frame 3 of 3"]);
  assert.deepEqual(detailImages({ fold: "f.png", full: "full.jpg" }), [{ file: "full.jpg", label: "full page" }]);
  assert.deepEqual(allImages({ fold: "f.png", frames: ["f.png", "g.png"] }).map((i) => i.file), ["f.png", "g.png"]);
  assert.deepEqual(followablePages([{ kind: "page", target: "/x" }], { platform: "android", base: "com.x", shots: [] }, 3), [], "an app screen has no address to follow");
});

test("the report summarises native facts and shows dead steps and launch errors", () => {
  const audit = {
    platform: "android",
    device: { model: "Pixel 9" },
    variant: { night: true, fontScale: 1.3 },
    interactive: { total: 12, under48dpCount: 2, under24dpCount: 1, unlabeledCount: 1 },
    textContrast: { sampled: 20, below4_5: 3 },
    images: { withoutDescription: 2 },
    runtime: { crashes: ["fatal exception: boom"], errors: [], anr: false, foreground: null, frameStats: { jankyPercent: 12.5 } },
  };
  assert.equal(
    auditSummary(audit),
    "Pixel 9, dark, font 1.3x, 2 of 12 targets under 48dp (1 under 24dp), 1 unlabelled controls, 3/20 text samples below 4.5:1, 2 images without a description, 1 crashes, 0 new error log lines, 12.5% janky frames",
  );
  const md = renderCritique({
    platform: "android",
    label: "before",
    base: "com.x",
    model: "m",
    reviewedAt: "t",
    usage: null,
    launchErrors: ["Fake: startup chatter #"],
    overall: { score: 60, revamp_needed: false, verdict: "v", top_priorities: [], consistency_findings: [{ id: "site-1", severity: "low", category: "consistency", viewport: "all", effort: "small", defect_kind: "ui", observation: "o", evidence: "e", recommendation: "r" }] },
    pages: [{ route: "launch [swatch]", score: 50, summary: "s", strengths: [], findings: [], coverage: [], audits: {}, stepWarnings: ["step 1: click desc=Teal changed nothing on screen"] }],
    requests: [],
    followed: { routes: [] },
  });
  assert.match(md, /### Cross-screen findings/);
  assert.match(md, /### Errors the app logs on every launch\n- Fake: startup chatter #/);
  assert.match(md, /Steps that changed nothing on screen: step 1: click desc=Teal changed nothing on screen/);
});
