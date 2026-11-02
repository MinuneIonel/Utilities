import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS, composite, finishMask, guidedRefine, maskFromOutput, maskImage, parseHex, resizeMask, toTensor, type Rgba } from "../src/nodes/remove-bg-core.ts";

/** A w×h picture: a red square in the middle (side w/2) on blue. */
function square(w: number, h = w): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inside = Math.abs(x + 0.5 - w / 2) < w / 4 && Math.abs(y + 0.5 - h / 2) < h / 4;
      data.set(inside ? [220, 30, 30, 255] : [20, 40, 200, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

/** An n×n mask that is 1 inside the same square. */
function squareMask(n: number) {
  const m = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) m[y * n + x] = Math.abs(x + 0.5 - n / 2) < n / 4 && Math.abs(y + 0.5 - n / 2) < n / 4 ? 1 : 0;
  return m;
}

test("the model input is planar RGB at the model's size, normalised", () => {
  const spec = MODELS.fast;
  const t = toTensor(square(2000, 1200), spec);
  const n = spec.size;
  assert.equal(t.length, 3 * n * n);
  const centre = (n / 2) * n + n / 2;
  // Red channel in the middle: (220/255 - mean) / std.
  assert.ok(Math.abs(t[centre] - (220 / 255 - 0.485) / 0.229) < 0.02);
  // Blue channel in a corner.
  assert.ok(Math.abs(t[2 * n * n] - (200 / 255 - 0.406) / 0.225) < 0.02);
});

test("transparent pixels reach the model as black", () => {
  const img = square(64);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0;
  const t = toTensor(img, MODELS.best);
  assert.ok(Math.abs(t[0] - -0.485) < 1e-6);
});

test("a prediction is stretched to 0–1, a flat one is not", () => {
  const spec = { ...MODELS.fast, size: 2 };
  assert.deepEqual([...maskFromOutput([0.2, 0.6, 0.4, 0.2], spec)].map((v) => +v.toFixed(2)), [0, 1, 0.5, 0]);
  assert.deepEqual([...maskFromOutput([0.01, 0.02, 0.01, 0.01], spec)].map((v) => +v.toFixed(2)), [0.01, 0.02, 0.01, 0.01]);
});

test("a small mask stretches over a bigger picture", () => {
  const m = resizeMask(squareMask(8), 8, 32, 32);
  assert.equal(m[16 * 32 + 16], 1);
  assert.equal(m[0], 0);
});

test("refining pulls a blurry edge onto the picture's own edge", () => {
  const img = square(200);
  // The model's mask at 16 px, stretched to 200: a 6 px wide ramp across the edge.
  const rough = resizeMask(squareMask(16), 16, 200, 200);
  const fine = guidedRefine(img, rough, 8);
  const row = (m: Float32Array, x: number) => m[100 * 200 + x];
  // The model's ramp climbs ~0.08 per pixel; refined, the step sits on the square's edge (x = 50).
  assert.ok(row(rough, 50) - row(rough, 49) < 0.1);
  assert.ok(row(fine, 50) - row(fine, 49) > 0.4, `${row(fine, 49)} → ${row(fine, 50)}`);
  // Far from the edge nothing moves.
  assert.equal(row(fine, 10), 0);
  assert.equal(row(fine, 100), 1);
});

test("hardness 100 makes a hard cut, invert swaps it, shift grows it", () => {
  const img = square(40);
  const small = resizeMask(squareMask(10), 10, 10, 10);
  const opts = { refine: false, hardness: 100, shift: 0, invert: false };
  const a = finishMask(img, small, 10, opts);
  assert.ok([...a].every((v) => v === 0 || v === 255));
  const inv = finishMask(img, small, 10, { ...opts, invert: true });
  assert.ok(a.every((v, i) => v + inv[i] === 255));
  const grown = finishMask(img, small, 10, { ...opts, shift: 3 });
  const count = (m: Uint8ClampedArray) => m.filter((v) => v > 127).length;
  assert.ok(count(grown) > count(a));
});

test("cut-out keeps colours with the mask as alpha; colour and picture fills are opaque", () => {
  const img = square(4);
  const alpha = new Uint8ClampedArray([255, 0, 128, 255, ...new Array(12).fill(0)]);
  const cut = composite(img, alpha, { type: "transparent" });
  assert.deepEqual([...cut.slice(0, 4)], [20, 40, 200, 255]);
  assert.equal(cut[7], 0);
  assert.equal(cut[11], 128);
  const white = composite(img, alpha, { type: "color", rgb: [255, 255, 255] });
  assert.deepEqual([...white.slice(4, 8)], [255, 255, 255, 255]);
  const green: Rgba = { width: 1, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255]) };
  const swapped = composite(img, alpha, { type: "image", image: green });
  assert.deepEqual([...swapped.slice(4, 8)], [0, 255, 0, 255]);
  assert.deepEqual([...swapped.slice(0, 4)], [20, 40, 200, 255]);
});

test("the mask output is grey and opaque; colours parse", () => {
  assert.deepEqual([...maskImage(new Uint8ClampedArray([7]), 1, 1)], [7, 7, 7, 255]);
  assert.deepEqual(parseHex("#0f8", [0, 0, 0]), [0, 255, 136]);
  assert.deepEqual(parseHex("nope", [1, 2, 3]), [1, 2, 3]);
});
