import assert from "node:assert/strict";
import { test } from "node:test";
// The module touches HTMLInputElement at load; give Node a stand-in.
(globalThis as any).HTMLInputElement ??= class { set value(_: string) {} };
const { nudgeValue } = await import("../src/ui/wheel-nudge.ts");

const pixel = { min: 1, max: 16, step: 1 };
const columns = { min: 20, max: 400, step: 1 };
const unit = { min: -1, max: 1, step: 0.01 };

test("a notch moves about 1% of the range, never less than one step", () => {
  assert.equal(nudgeValue(4, 1, pixel), 5);
  assert.equal(nudgeValue(100, 1, columns), 104);
  assert.equal(nudgeValue(0, 1, unit), 0.02);
  assert.equal(nudgeValue(0, -3, unit), -0.06);
});

test("Shift is one step, Ctrl/Cmd is about 10%", () => {
  assert.equal(nudgeValue(100, 1, columns, "fine"), 101);
  assert.equal(nudgeValue(100, 1, columns, "coarse"), 138);
  assert.equal(nudgeValue(0.5, 1, unit, "coarse"), 0.7);
});

test("clamps to the ends and snaps onto the step grid", () => {
  assert.equal(nudgeValue(15, 5, pixel), 16);
  assert.equal(nudgeValue(1, -1, pixel), 1);
  assert.equal(nudgeValue(0.333, 1, unit, "fine"), 0.34);
  assert.equal(nudgeValue(0.1, 2, { min: 0, max: 1, step: 0.1 }, "fine"), 0.3);
});

test("number boxes with no max still nudge", () => {
  assert.equal(nudgeValue(10, 1, { min: 0, max: Infinity, step: 1 }), 11);
  assert.equal(nudgeValue(10, -20, { min: 0, max: Infinity, step: 1 }), 0);
});
