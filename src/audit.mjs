/**
 * Measured facts about a rendered page, gathered in the browser during capture so
 * the critic judges from evidence as well as pixels: fonts and the base size, the
 * heading outline, landmarks, image alt coverage, interactive targets under 24px
 * (the WCAG 2.5.8 minimum), and the lowest-contrast visible text with its WCAG AA
 * result. The function is serialised into the page, so it must be self-contained.
 */
export function auditScript() {
  const cs = (el) => getComputedStyle(el);
  // Rendered and perceivable: laid out, not hidden, not faded out (an inactive
  // carousel slide), and not inside an inert or aria-hidden subtree.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const s = cs(el);
    if (s.visibility === "hidden" || parseFloat(s.opacity) < 0.05) return false;
    return !el.closest("[inert],[aria-hidden='true']");
  };
  const family = (el) => cs(el).fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const hiddenVisually = (el) => {
    const s = cs(el);
    return el.classList.contains("sr") || el.classList.contains("sr-only") || (s.position === "absolute" && s.clip !== "auto" && s.clip !== "");
  };
  const parseColor = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // The solid colour behind an element, or null when the text sits on an image
  // or a gradient before any solid colour is reached: that contrast cannot be
  // measured from styles, and a guess would be a false failure.
  const backgroundOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const st = cs(n);
      const b = parseColor(st.backgroundColor);
      if (b && b.a > 0.05) return b.rgb;
      if (st.backgroundImage && st.backgroundImage !== "none") return null;
      if (n.tagName === "IMG" || n.tagName === "VIDEO" || n.tagName === "CANVAS") return null;
      n = n.parentElement;
    }
    const b = parseColor(cs(document.body).backgroundColor);
    return b && b.a > 0 ? b.rgb : [255, 255, 255];
  };
  // Text drawn on top of a positioned image (a hero caption) has no solid
  // ancestor either; detect an image sibling underneath the text's box.
  const overImage = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(8, r.width / 2);
    const y = r.top + Math.min(8, r.height / 2);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const stack = document.elementsFromPoint(x, y);
    const idx = stack.indexOf(el);
    return stack.slice(idx + 1).some((n) => n.tagName === "IMG" || n.tagName === "VIDEO" || n.tagName === "CANVAS" || (cs(n).backgroundImage !== "none" && cs(n).backgroundImage));
  };

  const h1 = document.querySelector("h1");
  const h2 = document.querySelector("h2");
  const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
    .slice(0, 24)
    .map((h) => `${h.tagName}: ${h.textContent.trim().replace(/\s+/g, " ").slice(0, 60)}${hiddenVisually(h) ? " (visually hidden)" : ""}`);
  // Only rendered landmarks count: a responsive page keeps a hidden duplicate
  // (a desktop and a mobile header, say) that assistive tech never exposes.
  const landmarks = ["header", "nav", "main", "footer", "aside", "form[role=search]"]
    .map((s) => `${s}=${Array.from(document.querySelectorAll(s)).filter(visible).length}`)
    .join(" ");
  const imgs = Array.from(document.images);
  const interactive = Array.from(document.querySelectorAll("a,button,[role=button],input,select,textarea"))
    .filter(visible)
    .map((e) => {
      const r = e.getBoundingClientRect();
      const label = e.labels && e.labels[0] ? e.labels[0].textContent : "";
      const name = (e.getAttribute("aria-label") || label || e.textContent || e.getAttribute("placeholder") || e.value || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 32);
      return { name, w: Math.round(r.width), h: Math.round(r.height) };
    });
  const textElements = Array.from(document.querySelectorAll("p,span,a,button,li,h1,h2,h3,label,small,b,strong,td,th,dd,dt"))
    .filter((e) => e.children.length === 0 && e.textContent.trim().length > 1)
    .filter(visible)
    .filter((e) => !hiddenVisually(e))
    .slice(0, 500);
  const pairs = [];
  const sizeHistogram = {};
  let unmeasured = 0;
  for (const e of textElements) {
    const c = parseColor(cs(e).color);
    if (!c) continue;
    const bg = backgroundOf(e);
    if (!bg || overImage(e)) {
      unmeasured += 1;
      continue;
    }
    const l1 = luminance(c.rgb);
    const l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs(e).fontSize);
    const weight = parseInt(cs(e).fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const key = String(Math.round(size));
    sizeHistogram[key] = (sizeHistogram[key] || 0) + 1;
    pairs.push({
      text: e.textContent.trim().replace(/\s+/g, " ").slice(0, 32),
      ratio: Math.round(ratio * 100) / 100,
      size: Math.round(size * 10) / 10,
      passesAA: ratio >= (large ? 3 : 4.5),
    });
  }
  const lowContrast = pairs.filter((p) => !p.passesAA).sort((a, b) => a.ratio - b.ratio).slice(0, 8);
  return {
    title: document.title,
    lang: document.documentElement.lang || null,
    theme: document.documentElement.getAttribute("data-theme"),
    viewport: { width: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight },
    fonts: { body: family(document.body), h1: h1 ? family(h1) : null, h2: h2 ? family(h2) : null },
    baseFontSize: cs(document.body).fontSize,
    textSizeHistogram: sizeHistogram,
    headings,
    landmarks,
    images: {
      total: imgs.length,
      missingAlt: imgs.filter((i) => !i.hasAttribute("alt")).length,
      decorative: imgs.filter((i) => i.getAttribute("alt") === "").length,
    },
    interactive: {
      total: interactive.length,
      under24px: interactive.filter((t) => t.w < 24 || t.h < 24).slice(0, 10),
    },
    textContrast: { sampled: pairs.length, failingAA: pairs.filter((p) => !p.passesAA).length, lowest: lowContrast, overImage: unmeasured },
  };
}

/** One line per page for the report: the facts a reader most wants at a glance. */
export function auditSummary(audit) {
  if (!audit || audit.error) return audit?.error ? `audit failed: ${audit.error}` : "";
  const parts = [
    `base ${audit.baseFontSize}`,
    `${audit.fonts.body} body${audit.fonts.h2 && audit.fonts.h2 !== audit.fonts.body ? `, ${audit.fonts.h2} headings` : ""}`,
    `${audit.interactive.under24px.length} targets under 24px`,
    `${audit.textContrast.failingAA}/${audit.textContrast.sampled} text samples fail AA contrast`,
    `${audit.images.missingAlt} images missing alt`,
  ];
  return parts.join(", ");
}

/** The compact form handed to the critic inside a page prompt. */
export function auditForPrompt(audit, limit = 4000) {
  if (!audit) return "";
  const s = JSON.stringify(audit);
  return s.length > limit ? s.slice(0, limit) + "...}" : s;
}
