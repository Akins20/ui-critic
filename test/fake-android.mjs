import { encodePNG } from "../src/png.mjs";

/**
 * A simulated Android device that answers the adb commands the driver sends, so the
 * whole capture (device choice, settings and their restore, launches, deep links,
 * taps, scrolling, logs) can be tested without an emulator. The screen is 360x800 at
 * density 160, so one pixel is one dp.
 */

export const PKG = "com.fake.app";
const W = 360;
const H = 800;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** One hierarchy node as XML; children make it a container. */
export function node(a, children = []) {
  const [x1, y1, x2, y2] = a.b;
  const attrs = [
    `index="0"`,
    `text="${esc(a.text ?? "")}"`,
    `resource-id="${esc(a.id ?? "")}"`,
    `class="${a.cls ?? "android.view.View"}"`,
    `package="${a.pkg ?? PKG}"`,
    `content-desc="${esc(a.desc ?? "")}"`,
    `checkable="${Boolean(a.checkable)}"`,
    `checked="${Boolean(a.checked)}"`,
    `clickable="${Boolean(a.clickable)}"`,
    `enabled="true"`,
    `focusable="${Boolean(a.clickable)}"`,
    `focused="false"`,
    `scrollable="${Boolean(a.scrollable)}"`,
    `long-clickable="false"`,
    `password="false"`,
    `selected="false"`,
    `bounds="[${x1},${y1}][${x2},${y2}]"`,
  ].join(" ");
  return children.length ? `<node ${attrs}>${children.join("")}</node>` : `<node ${attrs} />`;
}

const hierarchy = (children) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ cls: "android.widget.FrameLayout", b: [0, 0, W, H] }, children)}</hierarchy>`;

/** Draws a screen: white, with a glyph-like bar in each text box in its colour. */
function paint(texts, background = [255, 255, 255]) {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) data.set([...background, 255], i * 4);
  for (const t of texts) {
    const [x1, y1, x2, y2] = t.b;
    const color = t.color ?? [17, 17, 17];
    const gy1 = y1 + Math.floor((y2 - y1) * 0.35);
    const gy2 = y1 + Math.floor((y2 - y1) * 0.6);
    for (let y = gy1; y < gy2; y += 1) for (let x = x1 + 2; x < x2 - 2; x += 1) data.set([...color, 255], (y * W + x) * 4);
  }
  return Buffer.from(encodePNG({ width: W, height: H, data }));
}

/** The fake app's screens: hierarchy, pixels, tap targets and scroll frames. */
export function screens() {
  const title = { text: "Fake Home", cls: "android.widget.TextView", b: [16, 40, 200, 80] };
  const lowContrast = (dy) => ({ text: "Low contrast", cls: "android.widget.TextView", b: [16, 320 - dy, 200, 350 - dy], color: [154, 154, 154] });
  const header = (dy) => ({ text: "Header text", cls: "android.widget.TextView", b: [16, 400 - dy, 200, 430 - dy] });
  const home = {
    xml: hierarchy([
      node(title),
      node({ cls: "androidx.recyclerview.widget.RecyclerView", scrollable: true, b: [0, 100, W, H] }, [
        node({ cls: "android.widget.LinearLayout", clickable: true, b: [0, 100, W, 180] }, [node({ text: "Profile", cls: "android.widget.TextView", b: [16, 120, 120, 150] })]),
        node({ cls: "android.widget.LinearLayout", clickable: true, b: [0, 180, W, 260] }, [node({ text: "Settings", cls: "android.widget.TextView", b: [16, 200, 130, 230] })]),
        node({ cls: "android.widget.ImageButton", clickable: true, b: [300, 270, 332, 302] }),
        node(lowContrast(0)),
        node(header(0)),
      ]),
    ]),
    texts: [title, { text: "Profile", b: [16, 120, 120, 150] }, { text: "Settings", b: [16, 200, 130, 230] }, lowContrast(0), header(0)],
    taps: [{ b: [0, 180, W, 260], to: "settings" }],
    next: "home2",
  };
  const home2 = {
    xml: hierarchy([
      node(title),
      node({ cls: "androidx.recyclerview.widget.RecyclerView", scrollable: true, b: [0, 100, W, H] }, [
        node(lowContrast(200)),
        node(header(200)),
        node({ cls: "android.widget.LinearLayout", clickable: true, b: [0, 600, W, 680] }, [node({ text: "Help", cls: "android.widget.TextView", b: [16, 620, 100, 650] })]),
      ]),
    ]),
    texts: [title, lowContrast(200), header(200), { text: "Help", b: [16, 620, 100, 650] }],
    taps: [],
    next: null,
  };
  const settings = {
    xml: hierarchy([node({ text: "Settings", cls: "android.widget.TextView", b: [16, 40, 200, 80] }), node({ desc: "Dark mode", cls: "android.widget.Switch", checkable: true, clickable: true, b: [280, 120, 340, 168] })]),
    texts: [{ text: "Settings", b: [16, 40, 200, 80] }],
    taps: [],
    next: null,
    log: "Settings: failed to load toggle state",
  };
  const promo = {
    xml: hierarchy([node({ text: "Promo", cls: "android.widget.TextView", b: [16, 40, 200, 80] })]),
    texts: [{ text: "Promo", b: [16, 40, 200, 80] }],
    taps: [],
    next: null,
    crash: "java.lang.IllegalStateException: promo exploded",
  };
  for (const s of [home, home2, settings, promo]) s.png = paint(s.texts);
  return { home, home2, settings, promo };
}

/**
 * The device. `calls` records every shell command, for assertions. Settings start
 * at the values a stock emulator reports (animator_duration_scale unset).
 */
export function fakeAndroid({ devices = [["emulator-5554", "device", "Fake_Phone"]], settings, night = "no" } = {}) {
  const all = screens();
  const state = {
    screen: null,
    night,
    settings: settings ?? { "global/window_animation_scale": "1.0", "global/transition_animation_scale": "1.0", "global/sysui_demo_allowed": "0", "system/font_scale": "1.0" },
    clock: 0,
    log: [],
    crash: [],
    demo: [],
    typed: [],
    calls: [],
  };
  const stamp = () => `10-07 10:00:${String(state.clock).padStart(2, "0")}.000`;
  const enter = (name) => {
    state.screen = name;
    state.clock += 1;
    const s = all[name];
    if (s?.log) state.log.push({ t: state.clock, line: `${stamp()}  4242  4242 E ${s.log}` });
    if (s?.crash) {
      state.crash.push({ t: state.clock, line: `${stamp()}  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main` });
      state.crash.push({ t: state.clock, line: `${stamp()}  4242  4242 E AndroidRuntime: Process: ${PKG}, PID: 4242` });
      state.crash.push({ t: state.clock, line: `${stamp()}  4242  4242 E AndroidRuntime: ${s.crash}` });
      state.crash.push({ t: state.clock, line: `${stamp()}  4242  4242 E AndroidRuntime: \tat com.fake.app.Promo.onCreate(Promo.kt:12)` });
    }
  };
  const since = (cmd) => {
    const m = /-T '10-07 10:00:(\d+)\.000'/.exec(cmd);
    return m ? Number(m[1]) : 0;
  };
  const shell = (cmd) => {
    state.calls.push(cmd);
    let m;
    if (cmd === "getprop ro.product.model") return "Fake_Phone";
    if (cmd === "getprop ro.build.version.release") return "15";
    if (cmd === "getprop ro.build.version.sdk") return "35";
    if (cmd === "getprop ro.kernel.qemu") return "1";
    if (cmd === "getprop ro.hardware") return "ranchu";
    if (cmd === "wm size") return `Physical size: ${W}x${H}`;
    if (cmd === "wm density") return "Physical density: 160";
    if (cmd === `pm path ${PKG}`) return "package:/data/app/fake/base.apk";
    if (cmd.startsWith(`dumpsys package ${PKG}`)) return "    versionName=1.2.3";
    if (cmd.startsWith("cmd package resolve-activity")) return `priority=0 preferredOrder=0\n${PKG}/.MainActivity`;
    if ((m = /^settings get (\w+) (\w+)$/.exec(cmd))) return state.settings[`${m[1]}/${m[2]}`] ?? "null";
    if ((m = /^settings put (\w+) (\w+) (\S+)$/.exec(cmd))) {
      state.settings[`${m[1]}/${m[2]}`] = m[3];
      return "";
    }
    if ((m = /^settings delete (\w+) (\w+)$/.exec(cmd))) {
      delete state.settings[`${m[1]}/${m[2]}`];
      return "Deleted 1 rows";
    }
    if (cmd === "cmd uimode night") return `Night mode: ${state.night}`;
    if ((m = /^cmd uimode night (\w+)$/.exec(cmd))) {
      state.night = m[1];
      return `Night mode: ${state.night}`;
    }
    if (cmd.startsWith("am broadcast -a com.android.systemui.demo")) {
      state.demo.push(/-e command (\w+)/.exec(cmd)[1]);
      return "Broadcast completed";
    }
    if (cmd.startsWith("date ")) return stamp();
    if (cmd === `am force-stop ${PKG}`) {
      state.screen = null;
      return "";
    }
    if (cmd === `am start -W -n ${PKG}/.MainActivity`) {
      state.clock += 1;
      state.log.push({ t: state.clock, line: `${stamp()}  4242  4242 E Fake: startup chatter ${state.clock}` });
      enter("home");
      return "Status: ok\nComplete";
    }
    if ((m = /^am start -W -a android\.intent\.action\.VIEW -d '([^']+)' (\S+)$/.exec(cmd))) {
      if (m[1] === "fake://promo") enter("promo");
      else if (m[1] === "fake://settings") enter("settings");
      return "Status: ok\nComplete";
    }
    if (cmd.startsWith("uiautomator dump")) return "UI hierchary dumped to: /sdcard/ui-critic-window.xml";
    if ((m = /^input tap (\d+) (\d+)$/.exec(cmd))) {
      const [x, y] = [Number(m[1]), Number(m[2])];
      const hit = (all[state.screen]?.taps ?? []).find((t) => x >= t.b[0] && x < t.b[2] && y >= t.b[1] && y < t.b[3]);
      if (hit) enter(hit.to);
      return "";
    }
    if (cmd.startsWith("input motionevent DOWN")) {
      const next = all[state.screen]?.next;
      if (next) state.screen = next;
      return "";
    }
    if (cmd.startsWith("input swipe")) return "";
    if (cmd.startsWith("input keyevent")) return "";
    if (cmd.startsWith("input text ")) {
      state.typed.push(cmd.slice("input text ".length));
      return "";
    }
    if (cmd.startsWith("logcat -d -b crash")) return state.crash.filter((e) => e.t > since(cmd)).map((e) => e.line).join("\n");
    if (cmd.startsWith("logcat -d -b events")) return "";
    if (cmd.startsWith("logcat -d")) return state.log.filter((e) => e.t > since(cmd)).map((e) => e.line).join("\n");
    if (cmd === `pidof ${PKG}`) return state.screen === "promo" ? "" : "4242";
    if (cmd.startsWith("dumpsys window")) return `  mCurrentFocus=Window{abc u0 ${PKG}/${PKG}.MainActivity}`;
    if (cmd.startsWith("dumpsys input_method")) return "  mInputShown=false";
    if (cmd.startsWith("dumpsys gfxinfo")) return "";
    throw Object.assign(new Error(`fake adb: unhandled shell command: ${cmd}`), { code: 1 });
  };
  const run = async (_adb, args) => {
    if (args[0] === "devices") return Buffer.from(`List of devices attached\n${devices.map(([s, st, model]) => `${s}\t${st} product:x model:${model} device:x`).join("\n")}\n`);
    const rest = args[0] === "-s" ? args.slice(2) : args;
    if (rest[0] === "exec-out" && rest[1] === "screencap") return all[state.screen ?? "home"].png;
    if (rest[0] === "exec-out" && rest[1] === "cat") return Buffer.from(all[state.screen ?? "home"].xml);
    if (rest[0] === "shell") {
      try {
        return Buffer.from(shell(rest[1]));
      } catch (err) {
        throw err;
      }
    }
    throw new Error(`fake adb: unhandled ${args.join(" ")}`);
  };
  return { run, state };
}
