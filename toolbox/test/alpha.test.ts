import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { flattenOnBlack, gifFrame as toGif, hasTransparency, type Quantizer } from "../src/nodes/alpha.ts";

const gifenc = createRequire(import.meta.url)("gifenc") as Quantizer;
const gifFrame = (rgba: Uint8ClampedArray) => toGif(rgba, gifenc);

/** w × 1 pixels from [r, g, b, a] tuples. */
const px = (...p: number[][]) => new Uint8ClampedArray(p.flat());

test("hasTransparency looks at alpha only", () => {
  assert.equal(hasTransparency(px([0, 0, 0, 255], [255, 255, 255, 255])), false);
  assert.equal(hasTransparency(px([0, 0, 0, 255], [255, 255, 255, 254])), true);
});

test("flattenOnBlack composites onto black and leaves opaque frames alone", () => {
  const opaque = px([10, 20, 30, 255]);
  assert.equal(flattenOnBlack(opaque), opaque);
  assert.deepEqual([...flattenOnBlack(px([200, 100, 50, 0], [200, 100, 50, 128], [200, 100, 50, 255]))], [0, 0, 0, 255, 100, 50, 25, 255, 200, 100, 50, 255]);
});

test("gifFrame without transparency uses a plain palette", () => {
  const f = gifFrame(px([255, 0, 0, 255], [0, 0, 255, 255]));
  assert.equal(f.transparentIndex, undefined);
  assert.deepEqual(f.index.length, 2);
});

test("gifFrame gives transparent pixels their own see-through entry", () => {
  // The hidden colour under alpha 0 (green, as Dither leaves it) must not take a palette slot.
  const f = gifFrame(px([255, 0, 0, 255], [0, 255, 0, 0], [0, 0, 255, 200], [0, 255, 0, 100]));
  assert.ok(f.transparentIndex !== undefined);
  assert.equal(f.index[1], f.transparentIndex);
  assert.equal(f.index[3], f.transparentIndex);
  assert.notEqual(f.index[0], f.transparentIndex);
  assert.notEqual(f.index[2], f.transparentIndex);
  assert.deepEqual(f.palette[f.index[0]], [255, 0, 0]);
  assert.deepEqual(f.palette[f.index[2]], [0, 0, 255]);
  assert.ok(!f.palette.slice(0, f.transparentIndex).some((c) => c[1] === 255));
  assert.ok(f.palette.length <= 256);
});

test("gifFrame handles a fully transparent frame and a frame that is a view into a bigger buffer", () => {
  const clear = gifFrame(px([1, 2, 3, 0], [4, 5, 6, 0]));
  assert.deepEqual([...clear.index], [clear.transparentIndex, clear.transparentIndex]);
  const big = px([9, 9, 9, 9], [255, 0, 0, 255], [0, 0, 0, 0]);
  const f = gifFrame(big.subarray(4));
  assert.equal(f.index.length, 2);
  assert.deepEqual(f.palette[f.index[0]], [255, 0, 0]);
  assert.equal(f.index[1], f.transparentIndex);
});

test("gifFrame keeps 255 colours plus the transparent one on a busy frame", () => {
  const n = 64 * 64;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set([i % 256, (i * 7) % 256, (i * 13) % 256, i % 3 ? 255 : 0], i * 4);
  const f = gifFrame(data);
  assert.equal(f.palette.length, 256);
  assert.equal(f.transparentIndex, 255);
});
