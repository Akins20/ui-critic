/**
 * The style inventory of a rendered page, gathered in the browser during capture:
 * every value the page actually uses for colour, type, spacing, radius and shadow,
 * with how often and a few samples of where, and the CSS custom properties it
 * defines (its tokens). The design-system lint compares the two. Only rendered,
 * perceivable elements count. The function is serialised into the page, so it must
 * be self-contained.
 */
export function stylesScript() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || parseFloat(s.opacity) < 0.05) return false;
    return !el.closest("[inert],[aria-hidden='true']");
  };
  const describe = (el) => {
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    const cls = el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}${t ? ` "${t}"` : ""}`;
  };
  const tallies = {};
  const add = (kind, value, el) => {
    if (!value) return;
    const map = (tallies[kind] = tallies[kind] || new Map());
    const entry = map.get(value) || { value, count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < 3) entry.samples.push(describe(el));
    map.set(value, entry);
  };
  const transparent = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  const longLines = [];
  const elements = Array.from(document.querySelectorAll("body *")).filter(visible).slice(0, 5000);
  for (const el of elements) {
    const s = getComputedStyle(el);
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) {
      const size = parseFloat(s.fontSize);
      add("colors", s.color, el);
      add("families", s.fontFamily.split(",")[0].replace(/["']/g, "").trim(), el);
      add("sizes", s.fontSize, el);
      add("weights", s.fontWeight, el);
      if (s.lineHeight !== "normal") add("lineHeights", String(Math.round((parseFloat(s.lineHeight) / size) * 100) / 100), el);
      if (s.letterSpacing !== "normal" && s.letterSpacing !== "0px") add("letterSpacing", s.letterSpacing, el);
      const text = el.textContent.trim();
      // Characters per line, from the box width and an average glyph of half the size.
      if (text.length > 120 && /^(block|list-item|flow-root)$/.test(s.display)) {
        const perLine = Math.round(el.clientWidth / (size * 0.5));
        if (perLine > 90) longLines.push({ sample: describe(el), charsPerLine: perLine, widthPx: el.clientWidth, fontSize: s.fontSize });
      }
      if (s.lineHeight !== "normal" && size <= 20 && parseFloat(s.lineHeight) / size < 1.3 && text.length > 60) {
        add("tightBodyText", `${s.fontSize} at ${Math.round((parseFloat(s.lineHeight) / size) * 100) / 100}`, el);
      }
    }
    if (!transparent(s.backgroundColor)) add("backgrounds", s.backgroundColor, el);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      if (parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== "none" && !transparent(s[`border${side}Color`])) {
        add("borders", s[`border${side}Color`], el);
        break;
      }
    }
    if (s.borderTopLeftRadius !== "0px") add("radii", s.borderTopLeftRadius, el);
    if (s.boxShadow !== "none") add("shadows", s.boxShadow, el);
    for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginBottom", "rowGap", "columnGap"]) {
      const v = s[p];
      if (v && v !== "0px" && v !== "normal" && v !== "auto") add("spacing", v, el);
    }
  }
  // Custom properties declared on the root (and theme variants of it) in stylesheets
  // the page can read, with the value they resolve to now.
  const tokens = {};
  const root = getComputedStyle(document.documentElement);
  const walk = (rules) => {
    for (const rule of Array.from(rules)) {
      if (rule.cssRules) walk(rule.cssRules);
      if (!rule.style || !rule.selectorText) continue;
      if (!/^(:root|html)\b|^\[data-theme|^:root\[/.test(rule.selectorText.trim())) continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith("--")) tokens[name] = root.getPropertyValue(name).trim() || rule.style.getPropertyValue(name).trim();
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch (e) {
      // a cross-origin stylesheet cannot be read; its tokens are simply not listed
    }
  }
  const list = (kind, cap = 50) => Array.from((tallies[kind] || new Map()).values()).sort((a, b) => b.count - a.count).slice(0, cap);
  const out = { elements: elements.length, tokens, longLines: longLines.slice(0, 10) };
  for (const kind of ["colors", "backgrounds", "borders", "families", "sizes", "weights", "lineHeights", "letterSpacing", "radii", "shadows", "spacing", "tightBodyText"]) out[kind] = list(kind, kind === "spacing" ? 80 : 50);
  return out;
}
