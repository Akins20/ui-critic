import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The thin layer between the tool and a device: finding adb the way Android Studio
 * does (not only on PATH), running it without a shell on the host, and the handful
 * of device commands the capture needs. Every call goes through one runner function,
 * so the whole driver can be exercised against a simulated device in tests.
 */

/** Where an Android SDK usually lives, per host system. */
export function sdkCandidates(env = process.env, platform = process.platform) {
  const out = [];
  if (env.ANDROID_HOME) out.push(env.ANDROID_HOME);
  if (env.ANDROID_SDK_ROOT) out.push(env.ANDROID_SDK_ROOT);
  if (platform === "win32" && env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "Android", "Sdk"));
  if (platform === "darwin") out.push(path.join(homedir(), "Library", "Android", "sdk"));
  if (platform === "linux") out.push(path.join(homedir(), "Android", "Sdk"));
  return out;
}

/**
 * The adb to run: an explicit path (config or ADB env) first, then the SDK's
 * platform-tools in the usual places, then plain "adb" for the PATH to resolve.
 */
export async function findAdb({ configured, env = process.env, platform = process.platform, exists } = {}) {
  const has = exists ?? ((p) => access(p).then(() => true, () => false));
  const exe = platform === "win32" ? "adb.exe" : "adb";
  const explicit = configured ?? env.ADB;
  if (explicit) {
    if (await has(explicit)) return explicit;
    throw new Error(`adb not found at ${explicit}`);
  }
  for (const sdk of sdkCandidates(env, platform)) {
    const candidate = path.join(sdk, "platform-tools", exe);
    if (await has(candidate)) return candidate;
  }
  return "adb";
}

/**
 * Runs a program without a host shell and resolves with its output as a Buffer, so
 * binary output (a screenshot) survives. A non-zero exit rejects with the command's
 * own error text.
 */
export function createRunner({ timeoutMs = 60_000 } = {}) {
  return (file, args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr?.toString() || stdout?.toString() || err.message).trim().split("\n").slice(-3).join(" ");
            const wrapped = new Error(`${path.basename(file)} ${args.filter((a) => a !== "-s").slice(0, 4).join(" ")}: ${detail}`);
            wrapped.code = err.code;
            wrapped.stdout = stdout;
            return reject(wrapped);
          }
          resolve(stdout);
        },
      );
    });
}

/** Quotes a string for the device's shell. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Parses `adb devices -l` into { serial, state, model, emulator }. */
export function parseDevices(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3])?.[1] ?? null;
    out.push({ serial: m[1], state: m[2], model, emulator: m[1].startsWith("emulator-") });
  }
  return out;
}

/**
 * The device to use. A configured serial must be online. Without one, a single
 * online device is used, and more than one is refused: the tool changes settings
 * and takes screenshots, and must never pick someone's personal phone by accident.
 */
export function pickDevice(devices, serial) {
  const online = devices.filter((d) => d.state === "device");
  if (serial) {
    const d = devices.find((x) => x.serial === serial);
    if (!d) throw new Error(`device ${serial} is not connected (connected: ${devices.map((x) => x.serial).join(", ") || "none"})`);
    if (d.state !== "device") throw new Error(`device ${serial} is ${d.state}, not ready`);
    return d;
  }
  if (online.length === 0) throw new Error("no Android device or emulator is connected and ready (adb devices lists none)");
  if (online.length > 1) {
    const list = online.map((d) => `${d.serial}${d.model ? ` (${d.model}${d.emulator ? ", emulator" : ""})` : ""}`).join(", ");
    throw new Error(`more than one Android device is connected: ${list}. Choose one with android.serial in the config or --serial`);
  }
  return online[0];
}

/** Key names a scenario may press, mapped to Android key codes. */
export const KEYS = {
  back: 4,
  home: 3,
  enter: 66,
  tab: 61,
  escape: 111,
  search: 84,
  menu: 82,
  backspace: 67,
  delete: 67,
  forwarddelete: 112,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  space: 62,
  moveend: 123,
  movehome: 122,
};

/** The key code for a key name ("Back"), a KEYCODE_ name, or a number. */
export function keyCode(name) {
  if (typeof name === "number" && Number.isInteger(name)) return name;
  const s = String(name ?? "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^KEYCODE_[A-Z0-9_]+$/.test(s)) return s;
  const code = KEYS[s.toLowerCase().replace(/[^a-z]/g, "")];
  if (code === undefined) throw new Error(`unknown key ${name}; use Back, Home, Enter, Tab, Escape, Search, Menu, Backspace, Up, Down, Left, Right, Space, a KEYCODE_ name or a number`);
  return code;
}

/**
 * Escapes text for `input text`: the device shell sees it, spaces must be written
 * as %s, and shell metacharacters need a backslash. Only printable ASCII is
 * reliable through this route.
 */
export function inputTextArg(text) {
  return String(text)
    .replace(/[\\"'`$&|;<>()*?#~!{}[\]^]/g, (c) => `\\${c}`)
    .replace(/ /g, "%s");
}

/**
 * One device, bound to a serial. Every method is a device command; nothing here
 * decides what to capture.
 */
export function androidDevice({ adb, serial, run }) {
  const base = serial ? ["-s", serial] : [];
  const exec = (args, opts) => run(adb, [...base, ...args], opts);
  const shell = async (cmd, opts) => (await exec(["shell", cmd], opts)).toString("utf8").replace(/\r\n/g, "\n").trimEnd();
  const shellQuiet = async (cmd, opts) => {
    try {
      return { ok: true, out: await shell(cmd, opts) };
    } catch (err) {
      return { ok: false, out: err.message };
    }
  };
  return {
    serial,
    shell,
    shellQuiet,
    /** A PNG of the screen. Identical screens give byte-identical PNGs. */
    screencap: () => exec(["exec-out", "screencap", "-p"], { timeoutMs: 30_000 }),
    /** The window hierarchy as XML; retried, since a screen still animating cannot be dumped. */
    async dump() {
      let last = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const r = await shellQuiet("uiautomator dump /sdcard/ui-critic-window.xml", { timeoutMs: 30_000 });
        if (r.ok && /dumped to/i.test(r.out)) {
          const xml = (await exec(["exec-out", "cat", "/sdcard/ui-critic-window.xml"])).toString("utf8");
          if (xml.includes("<hierarchy")) return xml;
        }
        last = r.out;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      throw new Error(`the window hierarchy could not be read (${last.slice(0, 160)})`);
    },
    tap: (x, y) => shell(`input tap ${Math.round(x)} ${Math.round(y)}`),
    longPress: (x, y, ms = 800) => shell(`input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y)} ${ms}`),
    /**
     * Drags without a fling: press, move in small steps, hold still, release. The
     * pause zeroes the release velocity, so a list moves by the drag and no further,
     * and consecutive frames overlap instead of skipping content.
     */
    drag(x1, y1, x2, y2, { steps = 6, holdMs = 400 } = {}) {
      const pts = [];
      // A short first move gets past the touch slop without wasting the drag.
      const slop = Math.sign(y2 - y1 || x2 - x1) * 30;
      pts.push(y1 === y2 ? [x1 + slop, y1] : [x1, y1 + slop]);
      for (let i = 1; i <= steps; i += 1) pts.push([x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps]);
      const r = (v) => Math.round(v);
      const moves = pts.map(([x, y]) => `input motionevent MOVE ${r(x)} ${r(y)}`).join(" && ");
      return shell(`input motionevent DOWN ${r(x1)} ${r(y1)} && ${moves} && sleep ${holdMs / 1000} && input motionevent UP ${r(x2)} ${r(y2)}`);
    },
    swipe: (x1, y1, x2, y2, ms = 250) => shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${ms}`),
    key: (code) => shell(`input keyevent ${code}`),
    keys: (codes) => shell(`input keyevent ${codes.join(" ")}`),
    text: (value) => shell(`input text ${inputTextArg(value)}`),
    forceStop: (pkg) => shell(`am force-stop ${pkg}`),
    launch: (component) => shell(`am start -W -n ${component}`, { timeoutMs: 60_000 }),
    openUri: (uri, pkg) => shell(`am start -W -a android.intent.action.VIEW -d ${shq(uri)}${pkg ? ` ${pkg}` : ""}`, { timeoutMs: 60_000 }),
    getprop: (name) => shell(`getprop ${name}`),
    async setting(namespace, key) {
      const v = (await shell(`settings get ${namespace} ${key}`)).trim();
      return v === "null" || v === "" ? null : v;
    },
    putSetting: (namespace, key, value) => (value === null ? shell(`settings delete ${namespace} ${key}`) : shell(`settings put ${namespace} ${key} ${value}`)),
    async nightMode() {
      const out = await shell("cmd uimode night");
      return /:\s*(\w+)/.exec(out)?.[1] ?? "no";
    },
    setNightMode: (mode) => shell(`cmd uimode night ${mode}`),
    demo: (command, extras = {}) =>
      shell(`am broadcast -a com.android.systemui.demo -e command ${command}${Object.entries(extras).map(([k, v]) => ` -e ${k} ${v}`).join("")}`),
    /** The device clock in logcat's -T format, so logs can be read from a moment on without clearing them. */
    logTime: async () => (await shell("date +'%m-%d %H:%M:%S.000'")).trim(),
    logcat: async (args) => (await shellQuiet(`logcat -d ${args}`, { timeoutMs: 30_000 })).out,
    pidof: async (pkg) => {
      const r = await shellQuiet(`pidof ${pkg}`);
      return r.ok ? r.out.trim().split(/\s+/)[0] || null : null;
    },
    focusedWindow: async () => {
      const r = await shellQuiet("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
      return r.ok ? r.out : "";
    },
    keyboardShown: async () => {
      const r = await shellQuiet("dumpsys input_method | grep -E 'mInputShown|isInputViewShown|mDecorViewVisible'");
      return r.ok && /(mInputShown|isInputViewShown)=true/.test(r.out);
    },
  };
}

/**
 * What the capture needs to know about a device: model, Android version, screen
 * size and density, and whether it is an emulator (frame timing is not reported from
 * an emulator, whose software rendering makes any device look janky).
 */
export async function deviceInfo(dev) {
  const [model, release, sdk, size, density, qemu, hardware] = await Promise.all([
    dev.getprop("ro.product.model"),
    dev.getprop("ro.build.version.release"),
    dev.getprop("ro.build.version.sdk"),
    dev.shell("wm size"),
    dev.shell("wm density"),
    dev.getprop("ro.kernel.qemu"),
    dev.getprop("ro.hardware"),
  ]);
  const pick = (text, label) => {
    const override = new RegExp(`Override ${label}:\\s*(\\S+)`).exec(text);
    const physical = new RegExp(`Physical ${label}:\\s*(\\S+)`).exec(text);
    return (override ?? physical)?.[1] ?? null;
  };
  const [w, h] = (pick(size, "size") ?? "0x0").split("x").map(Number);
  const dpi = Number(pick(density, "density")) || 160;
  return {
    model: model.trim(),
    android: release.trim(),
    sdk: Number(sdk.trim()) || null,
    screen: { width: w, height: h },
    density: dpi,
    pxPerDp: Math.round((dpi / 160) * 1000) / 1000,
    emulator: qemu.trim() === "1" || /ranchu|goldfish/.test(hardware),
  };
}
