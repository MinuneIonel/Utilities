import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { createPathSet } from "../electron/path-set.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "toolbox-paths-"));
const abs = (...p: string[]) => path.resolve("/", ...p);

test("knows the paths it was given, and only absolute ones", () => {
  const s = createPathSet(null);
  s.add(abs("a", "b.png"), "relative.png", "", 42);
  assert.equal(s.has(abs("a", "b.png")), true);
  assert.equal(s.has(abs("a", ".", "b.png")), true, "the same file spelled differently");
  assert.equal(s.has("relative.png"), false);
  assert.equal(s.has(abs("a", "c.png")), false);
  assert.equal(s.size, 1);
});

test("drops the oldest past the cap, and re-adding makes a path new again", () => {
  const s = createPathSet(null, 3);
  s.add(abs("1"), abs("2"), abs("3"));
  s.add(abs("1"));
  s.add(abs("4"));
  assert.deepEqual([abs("1"), abs("2"), abs("3"), abs("4")].map((p) => s.has(p)), [true, false, true, true]);
});

test("survives a restart through its file", () => {
  const file = path.join(tmp(), "deep", "paths.json");
  const s = createPathSet(file);
  s.add(abs("x.png"));
  s.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [abs("x.png")]);
  assert.equal(createPathSet(file).has(abs("x.png")), true);
});

test("a broken file starts empty instead of failing", () => {
  const file = path.join(tmp(), "paths.json");
  writeFileSync(file, "{not json");
  assert.equal(createPathSet(file).size, 0);
  writeFileSync(file, JSON.stringify([abs("ok"), 5, null]));
  assert.equal(createPathSet(file).size, 1);
});
