import { isVisible, isInteractive, labelOf, shortClass, shortId, findNodes, maybeClipped } from "./hierarchy.mjs";

/**
 * What is on a device's screen right now, as a list a scenario can be written from:
 * every element a person can act on or read, with a selector that names it uniquely,
 * its size in dp, and what the audit would say about it. Read-only: nothing is
 * tapped or changed.
 */

const quoted = (value) => (/>>|^["']|["']$/.test(value) ? `'${value.replace(/'/g, "")}'` : value);

/** A selector that names this node and no other visible one, in the most readable form available. */
export function suggestSelector(nodes, node) {
  const uniqueFor = (selector, target) => {
    const matches = findNodes(nodes, selector);
    return matches.length === 1 && matches[0] === target;
  };
  const unique = (selector) => uniqueFor(selector, node);
  const text = node.text.trim();
  const desc = node.desc.trim();
  if (text && unique(`text=${quoted(text)}`)) return `text=${quoted(text)}`;
  if (desc && unique(`desc=${quoted(desc)}`)) return `desc=${quoted(desc)}`;
  if (node.id && unique(`id=${shortId(node.id)}`)) return `id=${shortId(node.id)}`;
  if (node.hint.trim() && unique(`hint=${quoted(node.hint.trim())}`)) return `hint=${quoted(node.hint.trim())}`;
  // A row labelled by a child: a tap on the child's text lands on the row.
  if (!text && !desc) {
    const walk = (n) => {
      for (const c of n.children) {
        const child = nodes[c];
        const t = child.text.trim();
        if (t && uniqueFor(`text=${quoted(t)}`, child)) return `text=${quoted(t)}`;
        const deeper = walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    const viaChild = walk(node);
    if (viaChild) return viaChild;
  }
  // The same label twice (one product in two carousels): its label with a position
  // reads better and survives layout changes better than a class index.
  for (const [by, value] of [["text", text], ["desc", desc]]) {
    if (!value) continue;
    const nthOf = findNodes(nodes, `${by}=${quoted(value)}`).indexOf(node);
    if (nthOf >= 0) return `${by}=${quoted(value)} >> nth=${nthOf}`;
  }
  const short = shortClass(node.cls);
  const nth = findNodes(nodes, `class=${short}`).indexOf(node);
  return `class=${short} >> nth=${Math.max(0, nth)}`;
}

/** The rows of an inspection: interactive elements and visible text, in screen order. */
export function inspectScreen(nodes, info) {
  const dp = (px) => Math.round((px / info.pxPerDp) * 10) / 10;
  const rows = [];
  for (const n of nodes) {
    if (!isVisible(n)) continue;
    const interactive = isInteractive(n);
    if (!interactive && !(n.text || n.desc).trim()) continue;
    const label = labelOf(nodes, n);
    const w = dp(n.bounds.width);
    const h = dp(n.bounds.height);
    const clipped = maybeClipped(nodes, n, info.screen);
    rows.push({
      selector: suggestSelector(nodes, n),
      kind: shortClass(n.cls),
      label,
      w,
      h,
      tap: interactive,
      unlabeled: interactive && !label,
      small: interactive && !clipped && (w < 48 || h < 48),
      clipped,
      disabled: !n.enabled,
    });
  }
  return rows;
}

/** The inspection as an aligned table for a terminal. */
export function renderInspect(rows, header) {
  const lines = [header, ""];
  const pad = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}~` : s.padEnd(n));
  lines.push(`${pad("selector", 44)} ${pad("kind", 14)} ${pad("label", 34)} ${pad("size dp", 12)} notes`);
  for (const r of rows) {
    const notes = [r.tap ? "tap" : "", r.unlabeled ? "UNLABELLED" : "", r.small ? "under 48dp" : "", r.clipped ? "clipped" : "", r.disabled ? "disabled" : ""].filter(Boolean).join(", ");
    lines.push(`${pad(r.selector, 44)} ${pad(r.kind, 14)} ${pad(r.label || "", 34)} ${pad(`${r.w}x${r.h}`, 12)} ${notes}`);
  }
  const unlabeled = rows.filter((r) => r.unlabeled).length;
  const small = rows.filter((r) => r.small).length;
  lines.push("", `${rows.filter((r) => r.tap).length} interactive elements, ${unlabeled} unlabelled, ${small} under 48dp`);
  return lines.join("\n");
}
