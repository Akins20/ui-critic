import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePNG, encodePNG, isPNG, imageSize } from "../src/png.mjs";
import { contrastRatio, estimateTextContrast, dominantColors, regionColors, hex } from "../src/pixels.mjs";

/** A solid RGBA image with optional filled rectangles drawn on top. */
function canvas(width, height, bg, rects = []) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...bg, 255], i * 4);
  for (const { x, y, w, h, color } of rects) {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) data.set([...color, 255], (yy * width + xx) * 4);
  }
  return { width, height, data };
}

test("a PNG survives an encode and decode round trip, pixel for pixel", () => {
  const img = canvas(37, 23, [250, 248, 245], [{ x: 3, y: 4, w: 10, h: 6, color: [20, 30, 40] }]);
  img.data[7] = 128; // one translucent pixel
  const png = encodePNG(img);
  assert.ok(isPNG(png));
  assert.deepEqual(imageSize(png), { width: 37, height: 23 });
  const back = decodePNG(png);
  assert.equal(back.width, 37);
  assert.equal(back.height, 23);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data));
});

/** Hand-assembles a PNG with one filter type on every row, to exercise the decoder. */
function pngWith({ width, height, colorType, depth, rows, filter = 0, palette }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([filter, ...r])));
  const parts = [sig, chunk("IHDR", ihdr)];
  if (palette) parts.push(chunk("PLTE", Buffer.from(palette)));
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test("the decoder handles grey, RGB, palette and sub-byte images and every filter", () => {
  const grey = decodePNG(pngWith({ width: 2, height: 1, colorType: 0, depth: 8, rows: [[0, 255]] }));
  assert.deepEqual(Array.from(grey.data), [0, 0, 0, 255, 255, 255, 255, 255]);
  // Sub filter: the second pixel is stored as a difference from the first.
  const rgb = decodePNG(pngWith({ width: 2, height: 1, colorType: 2, depth: 8, filter: 1, rows: [[10, 20, 30, 5, 5, 5]] }));
  assert.deepEqual(Array.from(rgb.data), [10, 20, 30, 255, 15, 25, 35, 255]);
  // Up filter on the second row.
  const up = Buffer.concat([
    Buffer.from([0, 100]),
    Buffer.from([2, 7]),
  ]);
  const upPng = (() => {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(up)), chunk("IEND", Buffer.alloc(0))]);
  })();
  assert.deepEqual(Array.from(decodePNG(upPng).data), [100, 100, 100, 255, 107, 107, 107, 255]);
  // 2-bit palette: four pixels packed into one byte (indices 0, 1, 2, 3).
  const pal = decodePNG(pngWith({ width: 4, height: 1, colorType: 3, depth: 2, rows: [[0b00011011]], palette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9] }));
  assert.deepEqual(Array.from(pal.data), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  assert.throws(() => decodePNG(Buffer.from("not a png at all")), /not a PNG/);
});

test("contrast ratios match the WCAG reference values", () => {
  assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21);
  assert.equal(Math.round(contrastRatio([118, 118, 118], [255, 255, 255]) * 100) / 100, 4.54);
  assert.equal(contrastRatio([10, 10, 10], [10, 10, 10]), 1);
  assert.equal(hex([255, 0, 128]), "#ff0080");
});

test("text contrast reads the glyph colour, not the anti-aliased blend around it", () => {
  // Grey text (#777) on white: a thin core of glyph pixels surrounded by more
  // numerous blend pixels, as small type renders.
  const img = canvas(60, 20, [255, 255, 255], [
    { x: 4, y: 4, w: 40, h: 12, color: [200, 200, 200] }, // blend halo, the most common non-background colour
    { x: 6, y: 7, w: 30, h: 3, color: [119, 119, 119] }, // the glyph core
  ]);
  const est = estimateTextContrast(img, { x: 0, y: 0, width: 60, height: 20 });
  assert.equal(est.fg, "#777777");
  assert.equal(est.bg, "#ffffff");
  assert.ok(Math.abs(est.ratio - 4.48) < 0.05, `ratio ${est.ratio}`);
  assert.equal(est.complex, false);
});

test("a box with one colour has nothing to measure, and a busy background is flagged", () => {
  assert.equal(estimateTextContrast(canvas(30, 30, [40, 40, 40]), { x: 0, y: 0, width: 30, height: 30 }), null);
  // Four equal colour bands and dark text: no dominant background.
  const busy = canvas(40, 40, [200, 50, 50], [
    { x: 0, y: 10, w: 40, h: 10, color: [50, 200, 50] },
    { x: 0, y: 20, w: 40, h: 10, color: [50, 50, 200] },
    { x: 0, y: 30, w: 40, h: 10, color: [220, 220, 50] },
    { x: 5, y: 5, w: 30, h: 2, color: [0, 0, 0] },
  ]);
  const est = estimateTextContrast(busy, { x: 0, y: 0, width: 40, height: 40 });
  assert.equal(est.complex, true);
});

test("regions are clamped to the image and large regions are sampled", () => {
  const img = canvas(10, 10, [0, 0, 0]);
  assert.equal(regionColors(img, { x: -5, y: -5, width: 8, height: 8 }).total, 9);
  assert.equal(regionColors(img, { x: 20, y: 20, width: 5, height: 5 }).total, 0);
  const big = canvas(400, 400, [255, 255, 255]);
  assert.ok(regionColors(big, { x: 0, y: 0, width: 400, height: 400 }, 1000).total <= 1100);
  assert.deepEqual(dominantColors(canvas(4, 4, [1, 2, 3])), [{ color: "#010203", share: 1 }]);
});
