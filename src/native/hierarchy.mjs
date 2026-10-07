import { createHash } from "node:crypto";

/**
 * The window hierarchy a device reports (Android's uiautomator dump), parsed into a
 * flat list of nodes with parent links, plus the questions the capture asks of it:
 * which element a selector names, what an element is called, whether the screen
 * changed, and which element scrolls.
 *
 * Bounds are the element's visible part on screen, already clipped by its parents:
 * a row half under the app bar reports only its visible half, and a row scrolled
 * fully out of view reports an empty or inverted box.
 */

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** "[x1,y1][x2,y2]" into a box with its width and height. */
export function parseBounds(text) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(text ?? "");
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

/** Yields the tags of an XML document; attribute values may hold any character. */
function* xmlTags(xml) {
  let i = 0;
  const n = xml.length;
  const space = (c) => c === " " || c === "\n" || c === "\r" || c === "\t";
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) return;
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const gt = xml.indexOf(">", lt);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    if (xml.startsWith("</", lt)) {
      const gt = xml.indexOf(">", lt);
      yield { close: true, name: xml.slice(lt + 2, gt === -1 ? n : gt).trim() };
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !space(xml[j]) && xml[j] !== ">" && xml[j] !== "/") j += 1;
    const name = xml.slice(lt + 1, j);
    const attrs = {};
    let selfClosing = false;
    while (j < n) {
      while (j < n && space(xml[j])) j += 1;
      if (xml[j] === "/" && xml[j + 1] === ">") {
        selfClosing = true;
        j += 2;
        break;
      }
      if (xml[j] === ">") {
        j += 1;
        break;
      }
      let k = j;
      while (k < n && xml[k] !== "=" && !space(xml[k]) && xml[k] !== ">" && xml[k] !== "/") k += 1;
      const key = xml.slice(j, k);
      if (!key) {
        j = k + 1;
        continue;
      }
      j = k;
      while (j < n && space(xml[j])) j += 1;
      if (xml[j] !== "=") {
        attrs[key] = "";
        continue;
      }
      j += 1;
      while (j < n && space(xml[j])) j += 1;
      const quote = xml[j];
      if (quote === '"' || quote === "'") {
        const end = xml.indexOf(quote, j + 1);
        attrs[key] = decodeEntities(xml.slice(j + 1, end === -1 ? n : end));
        j = end === -1 ? n : end + 1;
      } else {
        let end = j;
        while (end < n && !space(xml[end]) && xml[end] !== ">") end += 1;
        attrs[key] = decodeEntities(xml.slice(j, end));
        j = end;
      }
    }
    yield { name, attrs, selfClosing };
    i = j;
  }
}

const bool = (v) => v === "true";

/**
 * Parses a uiautomator dump into { rotation, nodes }. Each node keeps its document
 * order (index), depth, parent and children indexes, its text, content description,
 * resource id, class, package, hint, state flags and visible bounds.
 */
export function parseHierarchy(xml) {
  const nodes = [];
  const stack = [];
  let rotation = 0;
  for (const tag of xmlTags(String(xml ?? ""))) {
    if (tag.close) {
      if (tag.name === "node") stack.pop();
      continue;
    }
    if (tag.name === "hierarchy") {
      rotation = Number(tag.attrs.rotation ?? 0) || 0;
      continue;
    }
    if (tag.name !== "node") continue;
    const a = tag.attrs;
    const parent = stack.length ? stack[stack.length - 1] : -1;
    const node = {
      index: nodes.length,
      depth: stack.length,
      parent,
      children: [],
      text: a.text ?? "",
      desc: a["content-desc"] ?? "",
      id: a["resource-id"] ?? "",
      cls: a.class ?? "",
      pkg: a.package ?? "",
      hint: a.hint ?? "",
      clickable: bool(a.clickable),
      longClickable: bool(a["long-clickable"]),
      checkable: bool(a.checkable),
      checked: bool(a.checked),
      enabled: a.enabled === undefined ? true : bool(a.enabled),
      focusable: bool(a.focusable),
      focused: bool(a.focused),
      scrollable: bool(a.scrollable),
      selected: bool(a.selected),
      password: bool(a.password),
      bounds: parseBounds(a.bounds),
    };
    nodes.push(node);
    if (parent >= 0) nodes[parent].children.push(node.index);
    if (!tag.selfClosing) stack.push(node.index);
  }
  return { rotation, nodes };
}

/** Whether a node occupies any of the screen. */
export function isVisible(node) {
  return Boolean(node?.bounds) && node.bounds.width > 0 && node.bounds.height > 0;
}

/** Whether a node is something a person can act on. */
export function isInteractive(node) {
  return node.clickable || node.longClickable || node.checkable;
}

/** The short form of a class name or a resource id: TextView, save_button. */
export const shortClass = (cls) => String(cls ?? "").split(".").pop();
export const shortId = (id) => String(id ?? "").split(":id/").pop();

/**
 * What an element is called: its own text, description or hint, or failing that the
 * text of its first few descendants, the way a screen reader announces a row whose
 * label lives in a child.
 */
export function labelOf(nodes, node, limit = 3) {
  const own = (node.text || node.desc || node.hint || "").trim();
  if (own) return own.replace(/\s+/g, " ").slice(0, 80);
  const parts = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (parts.length >= limit) return;
      const child = nodes[c];
      const t = (child.text || child.desc || "").trim();
      if (t) parts.push(t.replace(/\s+/g, " "));
      walk(child);
    }
  };
  walk(node);
  return parts.join(" ").slice(0, 80);
}

/**
 * Parses a selector: "text=Save", "desc=Open menu", "id=save_button",
 * "class=Switch", "hint=Email", or a bare string that matches text, description or
 * hint. A quoted value ("text='Save'") must match exactly; an unquoted one matches
 * exactly first and then as a case-insensitive substring. A trailing ">> nth=N"
 * picks the Nth match, counting from zero.
 */
export function parseSelector(selector) {
  let s = String(selector ?? "").trim();
  let nth = 0;
  const nthMatch = /\s*>>\s*nth=(\d+)\s*$/.exec(s);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    s = s.slice(0, nthMatch.index).trim();
  }
  let by = "any";
  let value = s;
  const kv = /^(text|desc|id|class|hint)\s*=\s*([\s\S]*)$/.exec(s);
  if (kv) {
    by = kv[1];
    value = kv[2];
  }
  let exact = false;
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1);
    exact = true;
  }
  return { by, value: value.trim(), nth, exact };
}

function fieldsFor(node, by) {
  switch (by) {
    case "text":
      return [node.text];
    case "desc":
      return [node.desc];
    case "hint":
      return [node.hint];
    case "id":
      return [node.id, shortId(node.id)];
    case "class":
      return [node.cls, shortClass(node.cls)];
    default:
      return [node.text, node.desc, node.hint];
  }
}

/** Every visible node a selector names, in document order. */
export function findNodes(nodes, selector) {
  const sel = typeof selector === "string" ? parseSelector(selector) : selector;
  if (!sel.value) return [];
  const visible = nodes.filter(isVisible);
  const exact = visible.filter((n) => fieldsFor(n, sel.by).some((f) => f && f.trim() === sel.value));
  if (exact.length || sel.exact || sel.by === "id" || sel.by === "class") return exact;
  const needle = sel.value.toLowerCase();
  return visible.filter((n) => fieldsFor(n, sel.by).some((f) => f && f.toLowerCase().includes(needle)));
}

/** The node a selector names (its nth match), or null. */
export function findNode(nodes, selector) {
  const sel = typeof selector === "string" ? parseSelector(selector) : selector;
  return findNodes(nodes, sel)[sel.nth] ?? null;
}

/** The point to touch for a node: the centre of its visible box. */
export function tapPoint(node) {
  const b = node.bounds;
  return { x: Math.round(b.x1 + b.width / 2), y: Math.round(b.y1 + b.height / 2) };
}

/**
 * A fingerprint of what the screen shows: every visible element's class, text,
 * description, state and position. Two equal fingerprints mean the step in between
 * changed nothing a hierarchy can see.
 */
export function signature(nodes) {
  const h = createHash("sha1");
  for (const n of nodes) {
    if (!isVisible(n)) continue;
    const b = n.bounds;
    h.update(`${n.cls}|${n.text}|${n.desc}|${n.checked}|${n.selected}|${n.focused}|${n.enabled}|${b.x1},${b.y1},${b.x2},${b.y2}\n`);
  }
  return h.digest("hex");
}

/** The element that scrolls the screen: the largest visible scrollable one, innermost on a tie. */
export function mainScrollable(nodes) {
  let best = null;
  for (const n of nodes) {
    if (!n.scrollable || !isVisible(n)) continue;
    const area = n.bounds.width * n.bounds.height;
    const bestArea = best ? best.bounds.width * best.bounds.height : -1;
    if (area > bestArea || (area === bestArea && n.depth > best.depth)) best = n;
  }
  return best;
}

/** The nearest scrollable ancestor of a node, or null. */
export function scrollableAncestor(nodes, node) {
  let p = node.parent;
  while (p >= 0) {
    if (nodes[p].scrollable) return nodes[p];
    p = nodes[p].parent;
  }
  return null;
}

/**
 * The direction a scrollable element scrolls: "x" when its visible children sit side
 * by side on one row, otherwise "y".
 */
export function scrollAxis(nodes, scroller) {
  const kids = scroller.children.map((c) => nodes[c]).filter(isVisible);
  if (kids.length < 2) return /Horizontal/i.test(scroller.cls) ? "x" : "y";
  const sameRow = kids.every((k) => Math.abs(k.bounds.y1 - kids[0].bounds.y1) <= 4);
  const spreadX = new Set(kids.map((k) => k.bounds.x1)).size > 1;
  return sameRow && spreadX ? "x" : "y";
}

/**
 * Whether a node may be cut off, so its true size is unknown and a target-size
 * check would report the visible sliver as a small target. A list clips along its
 * scroll axis only: at the trailing edge always, and at the leading edge once it has
 * been scrolled (pass leading: true for any frame after the first). The bottom of
 * the screen clips too, behind the navigation bar.
 */
export function maybeClipped(nodes, node, screen, { leading = false } = {}) {
  const b = node.bounds;
  const anc = scrollableAncestor(nodes, node);
  if (anc?.bounds) {
    const e = anc.bounds;
    if (scrollAxis(nodes, anc) === "x") {
      if (b.x2 >= e.x2 - 1 || (leading && b.x1 <= e.x1 + 1)) return true;
    } else if (b.y2 >= e.y2 - 1 || (leading && b.y1 <= e.y1 + 1)) return true;
  }
  return Boolean(screen) && b.y2 >= screen.height - 1;
}

/** Whether `node` lies inside `ancestor`'s subtree (or is it). */
export function within(nodes, node, ancestor) {
  for (let p = node.index; p >= 0; p = nodes[p].parent) if (p === ancestor.index) return true;
  return false;
}

const overlapArea = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));

/**
 * The elements that float over a scrolling list: a bottom bar, a floating button, a
 * sticky header drawn over the content. They sit outside the list, are not its
 * containers, cover part of its area and are small next to the screen (a full-screen
 * wrapper or a background is not an overlay). Document order cannot say what is on
 * top (a bar's vector shape may come before the list it covers), so this is decided
 * by geometry alone.
 */
export function overlaysOver(nodes, scroller, screen) {
  const screenArea = screen.width * screen.height;
  const out = [];
  for (const n of nodes) {
    if (!isVisible(n) || n === scroller) continue;
    if (within(nodes, n, scroller) || within(nodes, scroller, n)) continue;
    const area = n.bounds.width * n.bounds.height;
    if (area >= screenArea * 0.4) continue;
    if (overlapArea(n.bounds, scroller.bounds) > 0) out.push(n);
  }
  return out;
}

/**
 * Whether a node inside a scrolling list is covered by something floating over the
 * list (a third of its box or more), so its pixels show the overlay, not the node.
 */
export function coveredByOverlay(nodes, node, screen, cache = new Map()) {
  const scroller = scrollableAncestor(nodes, node);
  if (!scroller) return false;
  if (!cache.has(scroller.index)) cache.set(scroller.index, overlaysOver(nodes, scroller, screen));
  const area = node.bounds.width * node.bounds.height;
  return cache.get(scroller.index).some((o) => overlapArea(o.bounds, node.bounds) >= area / 3);
}

/** The package that owns the top window, read from the root node. */
export function foregroundPackage(nodes) {
  const root = nodes.find((n) => n.pkg);
  return root?.pkg ?? null;
}
