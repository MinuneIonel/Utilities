// The inspector's number settings: label hints, proportional sliders, fitted ranges, pickers, times.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NumberParam } from "../src/runtime/types.ts";
import { fromLog, labelParts, LOG_STOPS, pctToSeconds, pickIndex, secondsToPct, sliderRange, snap, toLog } from "../src/ui/number-scale.ts";

test("a hint in brackets comes off the label", () => {
  assert.deepEqual(labelParts("Bitrate kbps (0 = default)"), { main: "Bitrate kbps", hint: "0 = default" });
  assert.deepEqual(labelParts("Margin (squares)"), { main: "Margin", hint: "squares" });
  assert.deepEqual(labelParts("Quality"), { main: "Quality" });
  assert.deepEqual(labelParts("Refine edges (hair, fur)"), { main: "Refine edges", hint: "hair, fur" });
});

test("snap keeps to the step grid without float noise", () => {
  assert.equal(snap(0.30000000000000004, 0, 1, 0.1), 0.3);
  assert.equal(snap(17, 16, 8192, 16), 16);
  assert.equal(snap(9000, 16, 8192, 16), 8192);
});

test("a proportional slider: 0 is its first stop, both ends reach, the middle is the geometric middle", () => {
  const [min, max, step] = [0, 10000, 10];
  assert.equal(toLog(0, min, max, step), 0);
  assert.equal(fromLog(0, min, max, step), 0);
  assert.equal(fromLog(LOG_STOPS, min, max, step), 10000);
  assert.equal(toLog(10000, min, max, step), LOG_STOPS);
  // 10 → 10000 is three decades: 100 KB a third of the way, 1 MB two thirds.
  assert.equal(fromLog(LOG_STOPS / 3, min, max, step), 100);
  assert.equal(fromLog((2 * LOG_STOPS) / 3, min, max, step), 1000);
  // Values in between come out round, and go back to about the same place (near 10 KB the 10 KB step is coarser).
  for (const pos of [333, 512, 777, 999]) {
    const v = fromLog(pos, min, max, step);
    assert.equal(v % step, 0, `${v} on the step grid`);
    assert.ok(Math.abs(toLog(v, min, max, step) - pos) <= 20, `${v} sits near ${pos}`);
  }
});

test("a proportional bitrate slider stays on 8 kbps steps", () => {
  for (const pos of [100, 400, 700, 900]) assert.equal(fromLog(pos, 0, 320, 8) % 8, 0);
  assert.equal(fromLog(LOG_STOPS, 0, 320, 8), 320);
});

const longEdge: NumberParam = {
  key: "size",
  label: "Long edge px",
  kind: "number",
  min: 16,
  max: 8192,
  step: 16,
  fit: (f, p) => (f.width ? { min: 16, max: p.upscale ? f.width * 2 : f.width } : undefined),
};

test("the slider spans what the node has seen, and its setting's range before that", () => {
  assert.deepEqual(sliderRange(longEdge, 1080, undefined, {}), { min: 16, max: 8192, fit: undefined });
  assert.equal(sliderRange(longEdge, 1080, { width: 1920 }, {}).max, 1920);
  assert.equal(sliderRange(longEdge, 1080, { width: 1920 }, { upscale: true }).max, 3840);
});

test("a value typed past the fitted range stretches the slider to it, within the setting's own range", () => {
  assert.equal(sliderRange(longEdge, 4000, { width: 1920 }, {}).max, 4000);
  assert.equal(sliderRange(longEdge, 99999, { width: 1920 }, {}).max, 8192);
});

test("a fit that makes no sense (or throws) falls back to the setting's range", () => {
  const broken: NumberParam = { ...longEdge, fit: () => ({ max: 4 }) };
  assert.equal(sliderRange(broken, 16, { width: 10 }, {}).max, 8192);
  const throws: NumberParam = { ...longEdge, fit: () => { throw new Error("no"); } };
  assert.equal(sliderRange(throws, 16, { width: 10 }, {}).max, 8192);
});

test("a pick stays within the items there are", () => {
  assert.equal(pickIndex(700, 15), 15);
  assert.equal(pickIndex(0, 15), 1);
  assert.equal(pickIndex("3", 15), 3);
  assert.equal(pickIndex(undefined, 0), 1);
});

test("a % position reads as a time and a typed time goes back to a %", () => {
  assert.equal(pctToSeconds(25, 200), 50);
  assert.equal(secondsToPct(42, 192, { min: 0, max: 100 }), 21.875);
  assert.equal(secondsToPct(5000, 192, { min: 0, max: 100 }), 100);
  assert.equal(secondsToPct(10, 0, { min: 0, max: 100 }), 0);
});
