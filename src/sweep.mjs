/**
 * The interaction sweep: what a screenshot of a resting page cannot show about
 * feedback, measured in the browser without clicking anything.
 *
 * Hover: each control is hovered and its look compared with its look at rest (the
 * control, three levels of its ancestors, its first descendants and its ::before and
 * ::after, with transitions finished), so a control that gives no hover feedback is
 * found.
 *
 * Keyboard: the page is walked with Tab the way a keyboard user does. Each stop is
 * checked for a visible focus indicator against its look at rest (WCAG 2.4.7), for
 * landing on something invisible, and for jumping back up the page against the
 * visual order (WCAG 2.4.3); the walk also notes a skip link, a keyboard trap and
 * positive tabindex values.
 *
 * Every "no feedback" verdict is then confirmed by pixels: the control's area is
 * photographed hovered or focused and again at rest, and only an identical pair
 * stands. A ring drawn by a wrapper, an underline from a pseudo-element, any
 * technique at all that changes what a person sees, clears the control.
 *
 * Elements are tagged with a data attribute for the duration and untagged after.
 * The helpers are installed through the automation channel rather than eval, so a
 * page with a strict Content-Security-Policy is swept like any other.
 */

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Installs window.__uicLook: the look of an element and its surroundings, as hover and focus styles change them. */
function installHelpers() {
  const props = ["color", "backgroundColor", "borderTopColor", "borderBottomColor", "boxShadow", "outlineStyle", "outlineWidth", "outlineColor", "textDecorationLine", "opacity", "transform", "filter", "backgroundImage"];
  const one = (node, pseudo) => {
    if (!node || node.nodeType !== 1) return "";
    const s = getComputedStyle(node, pseudo);
    return props.map((p) => s[p]).join("|");
  };
  window.__uicLook = (el) => {
    for (const a of el.getAnimations({ subtree: true })) {
      try {
        a.finish();
      } catch (e) {
        // an infinite animation cannot finish; its current frame stands
      }
    }
    const parts = [one(el), one(el, "::before"), one(el, "::after")];
    // Focus rings and hover lifts are often drawn by a wrapper (:focus-within on a card).
    let up = el.parentElement;
    for (let k = 0; k < 3 && up && up !== document.body; k += 1, up = up.parentElement) parts.push(one(up));
    Array.from(el.querySelectorAll("*"))
      .slice(0, 10)
      .forEach((d) => parts.push(one(d)));
    return parts.join("#");
  };
}

/** Tags the page's focusable elements and records each one's look at rest. */
function tagAndRest({ selector, limit }) {
  document.activeElement?.blur?.();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.05;
  };
  const name = (el) => {
    const label = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].textContent) || el.textContent || el.getAttribute("placeholder") || el.value || el.tagName.toLowerCase();
    return `${el.tagName.toLowerCase()} "${String(label).trim().replace(/\s+/g, " ").slice(0, 32)}"`;
  };
  return Array.from(document.querySelectorAll(selector))
    .slice(0, limit)
    .map((el, i) => {
      el.setAttribute("data-uic-i", String(i));
      return { i, name: name(el), visible: visible(el), rest: window.__uicLook(el), hoverable: visible(el) && !el.disabled, positiveTabindex: el.tabIndex > 0 };
    });
}

function lookOf(i) {
  const el = document.querySelector(`[data-uic-i="${i}"]`);
  return el ? window.__uicLook(el) : null;
}

function activeStop() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  const i = el.getAttribute("data-uic-i");
  return { i: i === null ? null : Number(i), top: r.top + window.scrollY, left: r.left + window.scrollX, w: r.width, h: r.height, look: window.__uicLook(el), skip: /skip/i.test(el.textContent || "") };
}

/**
 * Puts the keyboard at the top of the page, where a visitor's first Tab begins.
 * blur() alone does not: the browser remembers where focus last was and the next
 * Tab continues from there. A focused, untabbable marker at the start of the body
 * resets that point; it is removed with the tags.
 */
function focusStart() {
  document.activeElement?.blur?.();
  let start = document.querySelector("[data-uic-start]");
  if (!start) {
    start = document.createElement("span");
    start.setAttribute("tabindex", "-1");
    start.setAttribute("data-uic-start", "");
    start.style.cssText = "position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;";
    document.body.prepend(start);
  }
  start.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function untagAll() {
  for (const el of document.querySelectorAll("[data-uic-i]")) {
    el.removeAttribute("data-uic-i");
    if (el.dataset.uicCaret !== undefined) {
      el.style.caretColor = el.dataset.uicCaret;
      delete el.dataset.uicCaret;
    }
  }
  for (const el of document.querySelectorAll("[data-uic-start]")) el.remove();
  document.activeElement?.blur?.();
  delete window.__uicLook;
}

/** The viewport box around a tagged element, with room for an outline or a ring, scrolled into view. */
function boxAround(i) {
  const el = document.querySelector(`[data-uic-i="${i}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  // A blinking caret would make two photographs differ for no reason.
  if (el.dataset.uicCaret === undefined) el.dataset.uicCaret = el.style.caretColor || "";
  el.style.caretColor = "transparent";
  const r = el.getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left - 10));
  const y = Math.max(0, Math.floor(r.top - 10));
  const width = Math.min(window.innerWidth - x, Math.ceil(r.width + 20));
  const height = Math.min(window.innerHeight - y, Math.ceil(r.height + 20));
  return width > 2 && height > 2 ? { x, y, width, height } : null;
}

function finishAnimations() {
  for (const a of document.getAnimations()) {
    try {
      a.finish();
    } catch (e) {
      // an infinite animation keeps its current frame
    }
  }
}

/**
 * Whether a control looks different hovered (mode "hover") or focused (mode
 * "focus") than at rest, judged from two photographs of its area. Returns null when
 * it cannot be photographed.
 */
export async function pixelsDiffer(page, i, mode) {
  const box = await page.evaluate(boxAround, i);
  if (!box) return null;
  if (mode === "focus") await page.evaluate((n) => document.querySelector(`[data-uic-i="${n}"]`)?.focus({ preventScroll: true }), i);
  else await page.hover(`[data-uic-i="${i}"]`, { timeout: 1500 });
  await page.evaluate(finishAnimations);
  const active = await page.screenshot({ clip: box });
  if (mode === "focus") await page.evaluate(() => document.querySelector("[data-uic-start]")?.focus({ preventScroll: true }));
  else await page.mouse.move(0, 0);
  await page.evaluate(finishAnimations);
  const rest = await page.screenshot({ clip: box });
  return !active.equals(rest);
}

/**
 * Hovers up to `maxHover` controls and lists those whose look does not change,
 * each confirmed by pixels. Only run on a viewport with a mouse.
 */
export async function sweepHover(page, items, maxHover = 20, maxConfirm = 10) {
  let checked = 0;
  const suspects = [];
  for (const item of items.filter((x) => x.hoverable).slice(0, maxHover)) {
    try {
      await page.mouse.move(0, 0);
      await page.hover(`[data-uic-i="${item.i}"]`, { timeout: 1500 });
      const look = await page.evaluate(lookOf, item.i);
      checked += 1;
      if (look === item.rest) suspects.push(item);
    } catch {
      // covered by something else, or detached: not measurable, not counted
    }
  }
  await page.mouse.move(0, 0);
  const unchanged = [];
  for (const item of suspects.slice(0, maxConfirm)) {
    try {
      if ((await pixelsDiffer(page, item.i, "hover")) === false) unchanged.push(item.name);
    } catch {
      // not photographable: no verdict
    }
  }
  await page.mouse.move(0, 0);
  return { checked, unchanged: unchanged.length, examples: unchanged.slice(0, 8) };
}

/** Walks the page with Tab and judges every stop, confirming missing focus by pixels. */
export async function sweepFocus(page, items, maxTabs = 60, maxConfirm = 12) {
  await page.evaluate(focusStart);
  const byIndex = new Map(items.map((x) => [x.i, x]));
  const stops = [];
  const seen = new Set();
  let trap = false;
  for (let n = 0; n < maxTabs; n += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(activeStop);
    if (!stop) {
      if (stops.length) break;
      continue;
    }
    if (stop.i !== null && seen.has(stop.i)) {
      // Back at a stop already visited: the walk has come round. A short loop that
      // never reached most of the page is a trap.
      trap = seen.size < Math.max(2, Math.floor(items.filter((x) => x.visible).length * 0.3));
      break;
    }
    if (stop.i !== null) seen.add(stop.i);
    stops.push(stop);
  }
  const suspects = [];
  const hidden = [];
  let backwardJumps = 0;
  stops.forEach((s, k) => {
    const item = s.i !== null ? byIndex.get(s.i) : null;
    if (!(s.w > 1 && s.h > 1)) hidden.push(item?.name ?? "an untagged element");
    else if (item && s.look === item.rest) suspects.push(item);
    // Back up the page by more than a fragment without moving right: the reading order
    // broke. Moving up to the next column of a grid is not a jump. A skip link at the
    // top is expected to jump.
    const prev = stops[k - 1];
    if (prev && !(k === 1 && stops[0].skip) && s.top < prev.top - 200 && s.left <= prev.left + 8) backwardJumps += 1;
  });
  const notVisible = [];
  for (const item of suspects.slice(0, maxConfirm)) {
    try {
      if ((await pixelsDiffer(page, item.i, "focus")) === false) notVisible.push(item.name);
    } catch {
      // not photographable: no verdict
    }
  }
  return {
    focusable: items.filter((x) => x.visible).length,
    reached: stops.length,
    notVisible: notVisible.length,
    notVisibleExamples: notVisible.slice(0, 8),
    hiddenStops: hidden.slice(0, 8),
    backwardJumps,
    // A positive tabindex pulls an element ahead of the page's own order (WCAG 2.4.3);
    // it is read from the markup, since the walk starts from the top of the source.
    positiveTabindex: items.filter((x) => x.positiveTabindex).map((x) => x.name).slice(0, 8),
    skipLink: Boolean(stops[0]?.skip),
    trap,
  };
}

/**
 * The whole sweep for one page: hover where there is a mouse, then the keyboard
 * walk. Returns the facts, or an error message when the page would not cooperate.
 */
export async function sweepPage(page, { hover = true, maxHover = 20, maxTabs = 60, maxElements = 150 } = {}) {
  try {
    await page.evaluate(installHelpers);
    const items = await page.evaluate(tagAndRest, { selector: FOCUSABLE, limit: maxElements });
    const out = {};
    if (hover) out.hover = await sweepHover(page, items, maxHover);
    out.focus = await sweepFocus(page, items, maxTabs);
    await page.evaluate(untagAll);
    return out;
  } catch (err) {
    await page.evaluate(untagAll).catch(() => {});
    return { error: err.message.slice(0, 200) };
  }
}
