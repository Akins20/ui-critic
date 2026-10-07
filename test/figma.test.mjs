import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileKey, figmaClient, collectFrames, frameViewport, pairFrames, paintColor, designInventory, inventoryDiff, frameDiff, fidelity } from "../src/figma.mjs";
import { encodePNG, decodePNG } from "../src/png.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

/**
 * The Figma side end to end against a simulated REST API: fetch is replaced by a
 * function answering files, nodes, images and the CDN download, so pairing, the
 * design inventory, the measured diff and the reports all run without a network and
 * without a token. The shapes follow Figma's documented responses.
 */

const solid = (hex, extra = {}) => ({ type: "SOLID", color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 }, ...extra });

const HOME_FRAME = {
  id: "1:2",
  name: "Home / Desktop",
  type: "FRAME",
  absoluteBoundingBox: { width: 1366, height: 900 },
  fills: [solid("#ffffff")],
  itemSpacing: 24,
  paddingTop: 32,
  children: [
    { id: "1:3", name: "Heading", type: "TEXT", style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700, lineHeightPx: 38.4 }, fills: [solid("#1b1a1f")] },
    {
      id: "1:4",
      name: "Buy now",
      type: "FRAME",
      cornerRadius: 8,
      fills: [solid("#6a1b5a")],
      strokes: [solid("#4a1240")],
      strokeWeight: 1,
      effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 2 }, radius: 8 }],
      children: [{ id: "1:5", name: "label", type: "TEXT", style: { fontFamily: "Inter", fontSize: 16, fontWeight: 600, lineHeightPx: 24 }, fills: [solid("#ffffff")] }],
    },
    { id: "1:6", name: "Spec note", type: "TEXT", visible: false, style: { fontFamily: "Comic Sans MS", fontSize: 99 }, fills: [solid("#ff00ff")] },
  ],
};

const FILE_BODY = {
  name: "Store design",
  document: {
    children: [
      { type: "CANVAS", name: "Screens", children: [HOME_FRAME, { id: "9:1", name: "Checkout / Desktop", type: "FRAME", absoluteBoundingBox: { width: 1366, height: 900 }, children: [] }] },
      { type: "CANVAS", name: "Scratch", children: [{ id: "9:9", name: "notes", type: "TEXT" }] },
    ],
  },
};

const BRIEF = `# Brief

## Product
A layaway fashion store where a shopper pays monthly at zero interest and receives the item after the final payment.

## Audience
Nigerian shoppers on Android phones over variable data, wary of scams and hidden charges.
`;

/** A fetch that answers the Figma REST API and the CDN the rendered frames come from. */
function fakeFigma({ framePng, fileBody = FILE_BODY, status = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: opts.headers ?? {} });
    const code = status[Object.keys(status).find((k) => u.includes(k)) ?? ""];
    if (code) return { ok: false, status: code, json: async () => ({}), text: async () => "no" };
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (/\/v1\/files\/[^/?]+(\?|$)/.test(u) && !u.includes("/nodes")) {
      assert.match(u, /depth=2/, "the file index is fetched shallow, not the whole document");
      return ok(fileBody);
    }
    if (u.includes("/nodes?")) {
      // The real endpoint returns the frame's full subtree; the file index above is
      // shallow, so the node comes from whichever frame the file body declared.
      const ids = new URL(u).searchParams.get("ids").split(",");
      const inFile = (fileBody.document.children ?? []).flatMap((p) => p.children ?? []);
      return ok({ nodes: Object.fromEntries(ids.map((id) => [id, { document: inFile.find((f) => f.id === id) ?? { id, name: id, type: "FRAME", children: [] } }])) });
    }
    if (u.includes("/v1/images/")) {
      const ids = new URL(u).searchParams.get("ids").split(",");
      return ok({ images: Object.fromEntries(ids.map((id) => [id, `https://figma-cdn.example/${id}.png`])) });
    }
    if (u.startsWith("https://figma-cdn.example/")) return { ok: true, status: 200, arrayBuffer: async () => framePng.buffer.slice(framePng.byteOffset, framePng.byteOffset + framePng.byteLength) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "unexpected" };
  };
  return { calls, fetchImpl };
}

/** A flat PNG with one differing quadrant, so a pixel locator has something to find. */
function painted(width, height, base, patch = null) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inPatch = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
      const rgb = inPatch ? patch.rgb : base;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return encodePNG({ width, height, data });
}

test("a file key is read from a share link of any kind, or passed through", () => {
  assert.equal(fileKey("https://www.figma.com/file/abc123XYZ/Store?node-id=1-2"), "abc123XYZ");
  assert.equal(fileKey("https://www.figma.com/design/Kq9SlugHere/Store-design"), "Kq9SlugHere");
  assert.equal(fileKey("https://www.figma.com/proto/pRoTo123/Flow"), "pRoTo123");
  assert.equal(fileKey("  abc123XYZ  "), "abc123XYZ");
});

test("the client sends the token as a header and turns Figma's refusals into advice", async () => {
  const { calls, fetchImpl } = fakeFigma({ framePng: painted(2, 2, [0, 0, 0]) });
  const api = figmaClient({ token: "figd_secret", fetch: fetchImpl });
  await api.file("abc");
  assert.equal(calls[0].headers["X-Figma-Token"], "figd_secret", "the token goes in the header, never the URL");
  assert.ok(!calls[0].url.includes("figd_secret"), "the token is never in a URL that could be logged");
  assert.throws(() => figmaClient({ token: "" }), /FIGMA_TOKEN/);
  for (const [code, expected] of [
    [403, /403.*(wrong|expired|no access)/s],
    [404, /404.*file key/s],
    [429, /429|rate limit/i],
  ]) {
    const bad = figmaClient({ token: "t", fetch: fakeFigma({ framePng: painted(2, 2, [0, 0, 0]), status: { "/v1/files/": code } }).fetchImpl });
    await assert.rejects(() => bad.file("abc"), expected, `status ${code} explains itself`);
  }
});

test("top-level frames are collected across pages, and loose nodes are not frames", () => {
  const frames = collectFrames(FILE_BODY.document);
  assert.deepEqual(frames.map((f) => f.name), ["Home / Desktop", "Checkout / Desktop"]);
  assert.equal(frames[0].page, "Screens");
  assert.equal(frames[0].width, 1366);
  assert.deepEqual(collectFrames(undefined), []);
});

test("a frame's viewport comes from its name first and its width second", () => {
  assert.equal(frameViewport({ name: "Home / Mobile", width: 1440 }, null), "mobile", "the name beats the width");
  assert.equal(frameViewport({ name: "Home", width: 1440 }, null), "desktop");
  assert.equal(frameViewport({ name: "Home", width: 390 }, null), "mobile");
  assert.equal(frameViewport({ name: "Home", width: 800 }, null), null, "a tablet width guesses nothing");
  assert.equal(frameViewport({ name: "Home tablet", width: 800 }, { tablet: {} }), "tablet", "a configured viewport name is recognised");
});

test("screens pair with frames by name, by explicit id, and what is left over is reported", () => {
  const frames = collectFrames(FILE_BODY.document);
  const shots = [
    { route: "/", path: "/", viewport: "desktop" },
    { route: "/checkout", path: "/checkout", viewport: "desktop" },
    { route: "/orphan", path: "/orphan", viewport: "desktop" },
  ];
  const { pairs, unpairedFrames } = pairFrames(frames, shots);
  assert.equal(pairs.find((p) => p.route === "/")?.frame.name, "Home / Desktop", '"/" finds the frame called Home');
  assert.equal(pairs.find((p) => p.route === "/checkout")?.frame.id, "9:1");
  assert.ok(!pairs.some((p) => p.route === "/orphan"), "a screen with no frame is simply not paired");
  assert.deepEqual(unpairedFrames.map((f) => f.id), [], "both frames were used");

  const explicit = pairFrames(frames, [{ route: "/", path: "/", viewport: "desktop" }], { "/": "9:1" });
  assert.equal(explicit.pairs[0].frame.id, "9:1", "the config overrides the name match");
  assert.deepEqual(explicit.unpairedFrames.map((f) => f.id), ["1:2"]);

  const wrong = pairFrames(frames, [{ route: "/", path: "/", viewport: "desktop" }], { "/": "4:4" });
  assert.match(wrong.pairs[0].error, /not a top-level frame/);

  const perViewport = pairFrames(
    [{ id: "a", name: "Home desktop", width: 1440 }, { id: "b", name: "Home mobile", width: 390 }],
    [{ route: "/", path: "/", viewport: "mobile" }],
  );
  assert.equal(perViewport.pairs[0].frame.id, "b", "the mobile screen takes the mobile frame");
});

test("a Figma paint becomes the same colour string the browser reports", () => {
  assert.equal(paintColor(solid("#6a1b5a")), "rgb(106, 27, 90)");
  assert.equal(paintColor(solid("#6a1b5a", { opacity: 0.5 })), "rgba(106, 27, 90, 0.5)");
  assert.equal(paintColor(solid("#6a1b5a"), 0.5), "rgba(106, 27, 90, 0.5)", "the node's own opacity counts");
  assert.equal(paintColor(solid("#6a1b5a", { visible: false })), null);
  assert.equal(paintColor({ type: "GRADIENT_LINEAR" }), null, "only flat fills are a colour");
  assert.equal(paintColor(solid("#6a1b5a", { opacity: 0 })), null);
});

test("the design inventory reads the frame's real numbers and skips what is hidden", () => {
  const inv = designInventory([HOME_FRAME]);
  assert.deepEqual(inv.sizes.map((s) => s.value).sort(), ["16px", "32px"], "the hidden 99px note is not counted");
  assert.ok(!inv.families.some((f) => f.value === "Comic Sans MS"));
  assert.deepEqual(inv.families.map((f) => f.value), ["Inter"]);
  assert.ok(inv.colors.some((c) => c.value === "rgb(27, 26, 31)"), "text colour");
  assert.ok(inv.backgrounds.some((c) => c.value === "rgb(106, 27, 90)"), "the button's fill is a background");
  assert.ok(inv.borders.some((c) => c.value === "rgb(74, 18, 64)"), "a stroke is a border");
  assert.deepEqual(inv.radii.map((r) => r.value), ["8px"]);
  assert.deepEqual(inv.spacing.map((s) => s.value).sort(), ["24px", "32px"], "auto-layout gap and padding");
  assert.equal(inv.lineHeights.find((l) => l.value === "1.2")?.count, 1, "38.4 over 32 is a 1.2 ratio");
  assert.ok(inv.shadows[0].value.includes("8px"), "the drop shadow is recorded");
  assert.ok(inv.colors[0].samples[0].includes("text"), "samples say where the value came from");
});

test("the measured diff separates drift from a value never rendered and one never designed", () => {
  const design = designInventory([HOME_FRAME]);
  const built = {
    colors: [{ value: "rgb(27, 26, 31)", count: 9, samples: ["h1"] }, { value: "rgb(255, 255, 255)", count: 2, samples: ["button"] }],
    backgrounds: [{ value: "rgb(255, 255, 255)", count: 4, samples: ["body"] }, { value: "rgb(126, 42, 106)", count: 2, samples: ["button.cta"] }],
    borders: [{ value: "rgb(74, 18, 64)", count: 1, samples: ["button"] }],
    families: [{ value: "Inter", count: 9, samples: ["h1"] }],
    sizes: [{ value: "30px", count: 3, samples: ["h1"] }, { value: "16px", count: 6, samples: ["button"] }],
    weights: [{ value: "700", count: 3, samples: [] }, { value: "600", count: 2, samples: [] }],
    lineHeights: [{ value: "1.2", count: 3, samples: [] }, { value: "1.5", count: 2, samples: [] }],
    radii: [{ value: "8px", count: 2, samples: [] }],
    shadows: [],
    spacing: [{ value: "24px", count: 4, samples: [] }, { value: "18px", count: 2, samples: [] }],
  };
  const diff = inventoryDiff(design, built);

  assert.deepEqual(diff.sizes.drifted.map((d) => [d.built, d.design]), [["30px", "32px"]], "30px where the design says 32px is drift");
  assert.ok(!diff.sizes.missing.some((m) => m.value === "32px"), "the drifted value is not also reported as missing");

  assert.deepEqual(diff.backgrounds.drifted.map((d) => [d.built, d.design]), [["rgb(126, 42, 106)", "rgb(106, 27, 90)"]], "a colour off the design's by a visible amount is drift");

  assert.deepEqual(diff.spacing.extra.map((e) => e.value), ["18px"], "18px is in no design value's neighbourhood");
  assert.deepEqual(diff.spacing.missing.map((m) => m.value), ["32px"], "the design's 32px padding is never rendered");

  assert.ok(diff.shadows.missing.length === 1, "the designed shadow is never rendered");
  assert.ok(!diff.radii, "a property that matches exactly is left out of the report");
  assert.ok(!diff.families, "the same font on both sides is not a difference");
});

test("a colour or length a hair off the design is not called drift", () => {
  const design = { backgrounds: [{ value: "rgb(106, 27, 90)", count: 1, samples: [] }], sizes: [{ value: "32px", count: 1, samples: [] }] };
  const built = { backgrounds: [{ value: "rgb(107, 28, 91)", count: 1, samples: [] }], sizes: [{ value: "32.4px", count: 1, samples: [] }] };
  assert.deepEqual(inventoryDiff(design, built), {}, "an invisible rounding is not a finding");
});

test("one design value is the drift target of at most one built value, the closest", () => {
  const design = { backgrounds: [{ value: "rgb(244, 241, 245)", count: 9, samples: [] }] };
  // All three are too far from the design's colour to be it, and near enough to be
  // a mistyping of it: 4.40, 4.36 and 4.31 apart.
  const built = {
    backgrounds: [
      { value: "rgb(250, 241, 252)", count: 16, samples: [] },
      { value: "rgb(244, 233, 241)", count: 4, samples: [] },
      { value: "rgb(238, 230, 240)", count: 2, samples: [] },
    ],
  };
  const diff = inventoryDiff(design, built);
  assert.equal(diff.backgrounds.drifted.length, 1, "only one built colour can be the drifted one");
  assert.equal(diff.backgrounds.drifted[0].built, "rgb(238, 230, 240)", "and it is the closest of the three");
  assert.deepEqual(diff.backgrounds.extra.map((e) => e.value), ["rgb(250, 241, 252)", "rgb(244, 233, 241)"], "the other two are colours the design does not have");
});

test("values that are not comparable are never paired", () => {
  const translucent = inventoryDiff({ backgrounds: [{ value: "rgb(244, 241, 245)", count: 1, samples: [] }] }, { backgrounds: [{ value: "rgba(255, 255, 255, 0.92)", count: 1, samples: [] }] });
  assert.equal(translucent.backgrounds.drifted.length, 0, "a 92% white panel is not a mistyped opaque pink");
  const units = inventoryDiff({ radii: [{ value: "50px", count: 1, samples: [] }] }, { radii: [{ value: "50%", count: 1, samples: [] }] });
  assert.equal(units.radii.drifted.length, 0, "a 50% radius is not a 50px one");
  assert.equal(units.radii.extra[0].value, "50%");
});

test("the pixel locator finds the block that differs and refuses to score what it cannot compare", () => {
  const design = decodePNG(painted(100, 100, [255, 255, 255]));
  const built = decodePNG(painted(100, 100, [255, 255, 255], { x: 50, y: 0, w: 50, h: 50, rgb: [0, 0, 0] }));
  const diff = frameDiff(design, built, { columns: 2 });
  assert.equal(diff.comparedHeight, 100);
  assert.deepEqual([diff.worst[0].x, diff.worst[0].y], [50, 0], "the changed quadrant is the worst block");
  assert.equal(diff.worst[0].where, "top right", "a block is named where a reader can find it");
  assert.ok(diff.worst[0].difference > 0.9 && diff.blocks.filter((b) => b.difference < 0.01).length === 3, "the other three blocks are identical");
  assert.equal(frameDiff(null, built), null);

  const tall = decodePNG(painted(100, 400, [255, 255, 255]));
  assert.equal(frameDiff(decodePNG(painted(100, 100, [255, 255, 255])), tall, { columns: 2 }).comparedHeight, 25, "a frame shorter than the screen says how much it covered");
});

test("the config takes a Figma file and refuses a token in it", () => {
  assert.doesNotThrow(() => validate(merge(DEFAULTS, { figma: { file: "abc123", frames: { "/": "1:2" }, scale: 2 } })));
  assert.throws(() => validate(merge(DEFAULTS, { figma: { file: "figd_abcdef" } })), /token belongs in FIGMA_TOKEN/);
  assert.throws(() => validate(merge(DEFAULTS, { figma: { file: "abc", frames: [] } })), /figma.frames must map/);
  assert.throws(() => validate(merge(DEFAULTS, { figma: { file: "abc", scale: 9 } })), /figma.scale/);
});

async function captureFor(root) {
  const dir = path.join(root, "before");
  await mkdir(dir, { recursive: true });
  const fold = path.join(dir, "home.desktop.fold.png");
  await writeFile(fold, painted(200, 200, [255, 255, 255], { x: 0, y: 100, w: 200, h: 100, rgb: [130, 45, 110] }));
  const styles = path.join(dir, "home.desktop.styles.json");
  await writeFile(
    styles,
    JSON.stringify({
      colors: [{ value: "rgb(27, 26, 31)", count: 9, samples: ["h1"] }],
      backgrounds: [{ value: "rgb(255, 255, 255)", count: 4, samples: ["body"] }, { value: "rgb(126, 42, 106)", count: 2, samples: ["button.cta"] }],
      borders: [],
      families: [{ value: "Inter", count: 9, samples: ["h1"] }],
      sizes: [{ value: "30px", count: 3, samples: ["h1"] }, { value: "16px", count: 6, samples: ["button"] }],
      weights: [],
      lineHeights: [],
      radii: [{ value: "8px", count: 2, samples: [] }],
      shadows: [],
      spacing: [{ value: "24px", count: 4, samples: [] }],
      tokens: {},
    }),
  );
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      label: "before",
      base: "https://shop.example",
      viewports: { desktop: { width: 1366, height: 900 } },
      shots: [{ route: "/", path: "/", viewport: "desktop", title: "Home", fold, styles }],
      dir,
    }),
  );
  return dir;
}

test("fidelity runs end to end against a simulated Figma: frames downloaded, measured, reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-fid-"));
  const dir = await captureFor(root);
  const { calls, fetchImpl } = fakeFigma({ framePng: painted(400, 400, [255, 255, 255], { x: 0, y: 200, w: 400, h: 200, rgb: [106, 27, 90] }) });
  const config = { ...merge(DEFAULTS, { out: root }), briefText: BRIEF };
  const result = await fidelity({ dir, config, key: "https://www.figma.com/design/abc123/Store", judge: false, fetch: fetchImpl, token: "figd_test" });

  assert.equal(result.figmaFile, "abc123", "the key was read from the link");
  assert.equal(result.fileName, "Store design");
  assert.equal(result.pages.length, 1);
  const page = result.pages[0];
  assert.equal(page.frame.name, "Home / Desktop");
  assert.ok(page.framePng && (await readFile(page.framePng)).length > 0, "the rendered frame was downloaded beside the report");
  assert.deepEqual(page.diff.sizes.drifted.map((d) => [d.built, d.design]), [["30px", "32px"]]);
  assert.deepEqual(page.diff.backgrounds.drifted.map((d) => [d.built, d.design]), [["rgb(126, 42, 106)", "rgb(106, 27, 90)"]]);
  assert.ok(page.pixels.overall >= 0 && page.pixels.worst.length, "the pixel locator ran");
  assert.ok(!page.judgement, "nothing was sent to a model with --no-judge");
  assert.deepEqual(result.unusedFrames.map((f) => f.name), ["Checkout / Desktop"], "a frame with no screen is named");

  const md = await readFile(path.join(dir, "fidelity.md"), "utf8");
  assert.ok(md.includes("`30px` where the design has `32px`"), "the Markdown states the drift");
  assert.ok(md.includes("Frames with no screen"));
  const html = await readFile(path.join(dir, "fidelity.html"), "utf8");
  assert.ok(html.includes("figma/1-2.png") && html.includes("home.desktop.fold.png"), "both pictures are in the HTML");
  assert.ok(html.includes("prefers-color-scheme"), "light first with a dark scheme");
  assert.ok(!html.includes("figd_test"), "the token never reaches a report");
  assert.ok(calls.some((c) => c.url.includes("scale=2")), "frames are rendered at 2x");
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "fidelity.json"), "utf8")).pages[0].frame.id, "1:2");
});

test("a frame thinner than the page it is compared with says so, in the report and to the critic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-thin-"));
  const dir = await captureFor(root);
  // The capture's inventory has 13 values across the counted kinds; HOME_FRAME has 11,
  // so a frame with only a background is well under half and is called out.
  const thin = { name: "F", document: { children: [{ type: "CANVAS", name: "P", children: [{ id: "1:2", name: "Home / Desktop", type: "FRAME", absoluteBoundingBox: { width: 1366, height: 900 }, fills: [solid("#ffffff")], children: [] }] }] } };
  const { fetchImpl } = fakeFigma({ framePng: painted(40, 40, [255, 255, 255]), fileBody: thin });
  const config = { ...merge(DEFAULTS, { out: root }), briefText: BRIEF };
  const result = await fidelity({ dir, config, key: "abc", judge: false, fetch: fetchImpl, token: "t" });
  assert.ok(result.pages[0].thinDesign, "the thin frame is flagged");
  assert.ok(result.pages[0].thinDesign.designed < result.pages[0].thinDesign.rendered);
  const md = await readFile(path.join(dir, "fidelity.md"), "utf8");
  assert.match(md, /probably partial or out of date/, "the reader is warned before the long list");
  assert.match(await readFile(path.join(dir, "fidelity.html"), "utf8"), /class="thin"/);
});

test("fidelity judged: the measured facts reach the critic and the verdict is kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-fidj-"));
  const dir = await captureFor(root);
  const { fetchImpl } = fakeFigma({ framePng: painted(400, 400, [255, 255, 255]) });
  const prompts = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url).includes(":countTokens")) return { ok: true, status: 200, json: async () => ({ totalTokens: 10 }) };
    if (String(url).includes(":generateContent")) {
      prompts.push({ schema: body.generationConfig.responseSchema, text: JSON.stringify(body.contents) });
      const data = { standing: "close", differences: [{ what: "The heading is 30px, the design says 32px", kind: "type", severity: "medium", fix: "Set the heading to 32px" }], not_a_concern: ["Real product names in place of the design's placeholder"], summary: "Close to the design. One type size drifted." };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "no" };
  };
  process.env.GEMINI_API_KEY = "test-key-not-real";
  try {
    const config = { ...merge(DEFAULTS, { out: root }), briefText: BRIEF, brief: "brief.md" };
    const result = await fidelity({ dir, config, key: "abc123", judge: true, fetch: fetchImpl, token: "figd_test" });
    assert.equal(result.pages[0].judgement.standing, "close");
    assert.equal(result.pages[0].judgement.differences.length, 1);
    assert.equal(prompts.length, 1, "one call per paired screen");
    assert.deepEqual(prompts[0].schema.properties.standing.enum, ["faithful", "close", "diverged"]);
    assert.ok(prompts[0].text.includes("30px where the design has 32px"), "the measured drift is given to the critic as a fact");
    assert.ok(prompts[0].text.includes("layaway fashion store"), "the brief is given too");
    assert.ok(/real content|placeholder/i.test(prompts[0].text), "the critic is told what does not count as a failure");
    const md = await readFile(path.join(dir, "fidelity.md"), "utf8");
    assert.ok(md.includes("**close.**") && md.includes("Set the heading to 32px"));
    assert.ok(md.includes("Not a concern:"));
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = realKey;
  }
});

test("fidelity says what to do when nothing matches or there is no file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uic-fid0-"));
  const dir = await captureFor(root);
  const config = { ...merge(DEFAULTS, { out: root }), briefText: BRIEF };
  await assert.rejects(() => fidelity({ dir, config, judge: false, token: "t", fetch: fakeFigma({ framePng: painted(2, 2, [0, 0, 0]) }).fetchImpl }), /no Figma file/);

  const noMatch = fakeFigma({ framePng: painted(2, 2, [0, 0, 0]), fileBody: { name: "F", document: { children: [{ type: "CANVAS", name: "P", children: [{ id: "7:7", name: "Untitled", type: "FRAME", absoluteBoundingBox: { width: 100, height: 100 }, children: [] }] }] } } });
  await assert.rejects(
    () => fidelity({ dir, config, key: "abc", judge: false, token: "t", fetch: noMatch.fetchImpl }),
    /no frame matched.*Untitled \(7:7\).*figma/s,
    "it names the frames it found and how to map them",
  );
});
