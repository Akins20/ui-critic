import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brandColors, storeTemplate, socialTemplate, storeShots, renderAssets, paletteFromShots, socialTitle, STORE_SIZES } from "../src/assets.mjs";
import { loadPlaywright } from "../src/capture.mjs";
import { encodePNG, decodePNG, imageSize } from "../src/png.mjs";
import { DEFAULTS } from "../src/config.mjs";

let playwright = null;
try {
  playwright = await loadPlaywright();
} catch {
  playwright = null;
}

test("the brand colour comes from a brand token, else the palette, and the caption colour reads on it", () => {
  assert.deepEqual(brandColors({ "--plum": "#6a1b5a", "--ink": "#111111" }), { bg: "#6a1b5a", ink: "#ffffff" });
  assert.deepEqual(brandColors({ "--brand": "#f5d76e" }), { bg: "#f5d76e", ink: "#141418" }, "dark text on a light brand colour");
  assert.equal(brandColors({}, [{ color: "#ffffff" }, { color: "#2a7d4f" }]).bg, "#2a7d4f", "the first colourful palette entry, not white");
  assert.equal(brandColors({}).bg, "#1c1b1f");
});

test("the brand colour is read off the screens when there are no tokens, colourful over grey, near-duplicates merged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uic-palette-"));
  // Two bands: mostly off-white, a strong plum stripe, a thin blue stripe.
  const paint = (w, h) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let rgb = [248, 246, 249]; // off-white paper
        if (y >= h * 0.5 && y < h * 0.82) rgb = x % 2 ? [106, 27, 90] : [108, 29, 92]; // plum, two near-duplicate shades
        else if (y >= h * 0.82) rgb = [40, 52, 90]; // a thinner blue band
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
    return encodePNG({ width: w, height: h, data });
  };
  await writeFile(path.join(dir, "a.png"), paint(200, 400));
  const palette = await paletteFromShots([path.join(dir, "a.png"), path.join(dir, "missing.png")]);
  assert.ok(palette.length >= 1, "a colourful palette was found");
  assert.ok(!palette.some((p) => p.color === "#f8f6f9"), "the off-white paper is not in the palette");
  assert.deepEqual(brandColors({}, palette).bg.match(/^#6[0-9a-f]/) ? "plum" : palette[0].color, "plum", "the plum wins over the thinner blue band");
});

test("the social headline drops a trailing site suffix and a leading product name", () => {
  assert.equal(socialTitle("Pay in Style, Buy original. Pay small small.", "Pay in Style"), "Buy original. Pay small small.");
  assert.equal(socialTitle("Shop all products | Pay in Style", "Pay in Style"), "Shop all products");
  assert.equal(socialTitle("Just a headline", "Acme"), "Just a headline");
});

test("templates escape captions and titles", () => {
  const store = storeTemplate({ width: 100, height: 200, caption: "<script>x</script> & more", image: "data:image/png;base64,AA==", bg: "#000", ink: "#fff" });
  assert.ok(store.includes("&lt;script&gt;x&lt;/script&gt; &amp; more") && !store.includes("<script>x"));
  const social = socialTemplate({ width: 100, height: 50, title: "<b>t</b>", subtitle: "s", image: "data:,", bg: "#000", ink: "#fff" });
  assert.ok(social.includes("&lt;b&gt;t&lt;/b&gt;"));
});

test("store screens are the phone-sized first screens, one per screen, never variants or blocked pages", () => {
  const manifest = {
    viewports: { desktop: {}, mobile: { isMobile: true }, "reflow-320": { isMobile: true, a11yPreset: true } },
    shots: [
      { route: "/", viewport: "desktop" },
      { route: "/", viewport: "mobile" },
      { route: "/", viewport: "reflow-320" },
      { route: "/shop", viewport: "mobile", blocked: "bot check" },
      { route: "/plans", viewport: "mobile" },
    ],
  };
  assert.deepEqual(storeShots(manifest).map((s) => `${s.route}@${s.viewport}`), ["/@mobile", "/plans@mobile"]);
  assert.equal(storeShots({ platform: "android", viewports: { phone: {} }, shots: [{ route: "launch", viewport: "phone" }] }).length, 1);
});

test("store screenshots and social cards render at the exact store sizes, in the brand colour", { skip: playwright ? false : "Playwright is not installed", timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "uic-assets-"));
  const screen = (w, h, rgb) => encodePNG({ width: w, height: h, data: new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])) });
  await writeFile(path.join(dir, "home.mobile.fold.png"), screen(390, 844, [240, 240, 240]));
  await writeFile(path.join(dir, "home.desktop.fold.png"), screen(1366, 900, [250, 250, 250]));
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      label: "t",
      base: "https://shop.example",
      viewports: { desktop: { width: 1366, height: 900 }, mobile: { width: 390, height: 844, isMobile: true } },
      shots: [
        { route: "/", path: "/", viewport: "mobile", title: "Home | Shop", fold: path.join(dir, "home.mobile.fold.png") },
        { route: "/", path: "/", viewport: "desktop", title: "Home | Shop", fold: path.join(dir, "home.desktop.fold.png") },
      ],
    }),
  );
  const result = await renderAssets({ dir, config: { ...DEFAULTS, assets: { background: "#6a1b5a" } }, captions: { "/": "Pay small small" } });
  const sizes = Object.fromEntries(result.files.map((f) => [path.relative(result.dir, f.file).split(path.sep).join("/"), `${f.width}x${f.height}`]));
  assert.deepEqual(sizes, { "play/01-home.png": "1080x1920", "appstore/01-home.png": "1290x2796", "social/home.png": "1200x630" });
  for (const f of result.files) assert.deepEqual(imageSize(await readFile(f.file)), { width: f.width, height: f.height }, "the PNG really has the store size");
  const play = decodePNG(await readFile(path.join(result.dir, "play", "01-home.png")));
  assert.deepEqual(Array.from(play.data.subarray(0, 3)), [106, 27, 90], "the corner is the brand colour");
  assert.equal(result.colors.ink, "#ffffff");
  assert.equal(JSON.parse(await readFile(path.join(result.dir, "assets.json"), "utf8")).captions["/"], "Pay small small");
  assert.ok(STORE_SIZES.play.width === 1080);
});
