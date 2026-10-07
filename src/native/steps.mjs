/**
 * The step vocabulary for native scenarios. It mirrors the web one where the idea
 * carries over, so a config reads the same on both, and names the gestures only a
 * touch screen has. Each step is an object with exactly one of these keys:
 *   { goto: "myapp://plans" }                open a deep link in the app
 *   { click: "text=Settings" }               tap an element (tap is an alias)
 *   { longPress: "desc=Message" }            press and hold an element
 *   { fill: { selector, value } }            tap a field, clear it, type a literal value
 *   { fill: { selector, envVar } }           the same with a secret read from the environment
 *   { press: "Back" }                        press a key (Back, Enter, Tab, KEYCODE_..., or a number)
 *   { hideKeyboard: true }                   close the on-screen keyboard if it is open
 *   { wait: 500 }                            wait milliseconds
 *   { waitFor: "text=Welcome" }              wait until an element is on screen
 *   { scroll: 600 }                          scroll the screen's list by that many dp (negative scrolls back)
 *   { swipe: "left" }                        swipe the screen (left, right, up, down), for pagers and carousels
 * Selectors: text=, desc= (content description), id= (resource id, with or without
 * the package prefix), class=, hint=, or a bare string matching text, description or
 * hint; quoted values match exactly; a trailing ">> nth=N" picks the Nth match.
 */
export const NATIVE_STEP_KEYS = ["goto", "click", "tap", "longPress", "fill", "press", "hideKeyboard", "wait", "waitFor", "scroll", "swipe"];

/** What iOS can do without a tap driver: open deep links and wait. */
export const IOS_STEP_KEYS = ["goto", "wait"];

const WEB_ONLY = {
  hover: "a touch screen has no hover",
  focus: "keyboard focus on a phone is not driven by the tool yet",
  waitForURL: "an app has no URL; use waitFor with an element on the next screen",
};

const SWIPES = ["left", "right", "up", "down"];

/** Validates native steps, returning a list of problems (empty when valid). */
export function nativeStepProblems(steps, where = "steps", platform = "android") {
  if (!Array.isArray(steps)) return [`${where} must be a list`];
  const allowed = platform === "ios" ? IOS_STEP_KEYS : NATIVE_STEP_KEYS;
  const problems = [];
  steps.forEach((step, i) => {
    const at = `${where}[${i}]`;
    const keys = Object.keys(step ?? {});
    const webOnly = keys.find((k) => WEB_ONLY[k]);
    if (webOnly) {
      problems.push(`${at}.${webOnly} is a web step: ${WEB_ONLY[webOnly]}`);
      return;
    }
    const known = keys.filter((k) => NATIVE_STEP_KEYS.includes(k));
    if (known.length !== 1) {
      problems.push(`${at} must have exactly one of ${allowed.join(", ")}`);
      return;
    }
    const key = known[0];
    if (!allowed.includes(key)) {
      problems.push(`${at}.${key} is not available on ${platform} yet (available: ${allowed.join(", ")}); use deep links, or capture screenshots yourself and use --from-images`);
      return;
    }
    const value = step[key];
    if (key === "fill") {
      if (!value || typeof value.selector !== "string" || !value.selector) problems.push(`${at}.fill needs a selector`);
      if (!(typeof value?.value === "string" || typeof value?.envVar === "string")) problems.push(`${at}.fill needs value or envVar`);
      if (typeof value?.value === "string" && /[^\x20-\x7e]/.test(value.value)) problems.push(`${at}.fill value must be plain ASCII: Android's input command cannot type other characters`);
    } else if (key === "wait") {
      if (!(Number.isFinite(value) && value >= 0)) problems.push(`${at}.wait must be a non-negative number`);
    } else if (key === "scroll") {
      if (!(Number.isFinite(value) && value !== 0)) problems.push(`${at}.scroll must be a non-zero number of dp`);
    } else if (key === "swipe") {
      if (!SWIPES.includes(value)) problems.push(`${at}.swipe must be one of ${SWIPES.join(", ")}`);
    } else if (key === "hideKeyboard") {
      if (value !== true) problems.push(`${at}.hideKeyboard must be true`);
    } else if (key === "goto") {
      if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) problems.push(`${at}.goto must be a deep link such as myapp://plans`);
    } else if (typeof value !== "string" || !value.trim()) {
      problems.push(`${at}.${key} must be a non-empty string`);
    }
  });
  return problems;
}

/** Whether a native route opens the app's launch screen rather than a deep link. */
export function isLaunchRoute(route) {
  return route === "/" || route === "launch";
}

/** Problems with a native route: the launch screen ("/" or "launch") or a deep link. */
export function nativeRouteProblems(route, where = "route") {
  if (typeof route !== "string" || !route) return [`${where} needs a value`];
  if (isLaunchRoute(route) || /^[a-z][a-z0-9+.-]*:\/\//i.test(route)) return [];
  return [`${where} ${route} must be "launch" (or "/") for the app's first screen, or a deep link such as myapp://plans`];
}
