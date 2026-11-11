import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { numberedOwn, saveAction } from "../electron/save-policy.js";

test("a new file is just written, whatever the policy", () => {
  for (const p of ["replace-own", "number", "skip"]) assert.equal(saveAction(false, p, false), "write");
});

test("replace-own replaces only what this Save node wrote", () => {
  assert.equal(saveAction(true, "replace-own", true), "replace");
  assert.equal(saveAction(true, "replace-own", false), "number");
});

test("an unknown or missing policy acts like replace-own", () => {
  assert.equal(saveAction(true, undefined, true), "replace");
  assert.equal(saveAction(true, "nonsense", false), "number");
});

test("number keeps both, skip keeps the old one", () => {
  assert.equal(saveAction(true, "number", true), "number");
  assert.equal(saveAction(true, "skip", true), "skip");
  assert.equal(saveAction(true, "skip", false), "skip");
});

test("finds the numbered file a Save node wrote when its name was taken", () => {
  const dir = path.resolve("/", "out");
  const own = [path.join(dir, "other.png"), path.join(dir, "qr (2).png")];
  assert.equal(numberedOwn(own, dir, "qr.png"), path.join(dir, "qr (2).png"));
  assert.equal(numberedOwn(own, dir, "qr.jpg"), undefined, "another extension");
  assert.equal(numberedOwn(own, path.resolve("/", "elsewhere"), "qr.png"), undefined, "another folder");
  assert.equal(numberedOwn([path.join(dir, "qr (x).png")], dir, "qr.png"), undefined);
  assert.equal(numberedOwn([path.join(dir, "a+b (3).png")], dir, "a+b.png"), path.join(dir, "a+b (3).png"), "names with regex characters");
});
