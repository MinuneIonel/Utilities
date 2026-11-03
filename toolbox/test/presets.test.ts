import assert from "node:assert/strict";
import { test } from "node:test";
import { matchingPreset, PRESET_STORE, presetParams, readPresets, withoutPreset, withPreset } from "../src/presets.ts";

const dither = {
  params: [
    { key: "recipe", label: "Recipe", kind: "custom" as const },
    { key: "size", label: "Size", kind: "select" as const, options: [] },
  ],
};

test("a preset keeps the node's settings, not the files it was given", () => {
  const p = presetParams(dither, { recipe: { name: "A", steps: [] }, size: "source", assetId: "a1", path: "/x.png" });
  assert.deepEqual(p, { recipe: { name: "A", steps: [] }, size: "source" });
  const save = presetParams({ params: [{ key: "name", label: "Name", kind: "text" }], saves: true }, { name: "out", folder: "/tmp", assetId: "x" });
  assert.deepEqual(save, { name: "out", folder: "/tmp" });
});

test("saving a name again replaces it, and the list stays sorted", () => {
  let book = withPreset({}, "dither.recipe", { name: "b", params: { size: "1" } });
  book = withPreset(book, "dither.recipe", { name: "a", params: { size: "2" } });
  book = withPreset(book, "dither.recipe", { name: "b", params: { size: "3" } });
  assert.deepEqual(book["dither.recipe"].map((p) => [p.name, p.params.size]), [["a", "2"], ["b", "3"]]);
  book = withoutPreset(book, "dither.recipe", "a");
  book = withoutPreset(book, "dither.recipe", "b");
  assert.equal("dither.recipe" in book, false);
});

test("the current settings are recognised as a saved preset whatever the key order", () => {
  const list = [{ name: "GB", params: { recipe: { name: "GB", pixelSize: 2 }, size: "source" } }];
  assert.equal(matchingPreset(list, { size: "source", recipe: { pixelSize: 2, name: "GB" }, assetId: "z" })?.name, "GB");
  assert.equal(matchingPreset(list, { size: "source", recipe: { pixelSize: 3, name: "GB" } }), undefined);
});

test("broken storage reads as no presets", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === PRESET_STORE ? v : null) });
  assert.deepEqual(readPresets(store("not json")), {});
  assert.deepEqual(readPresets(store("[1,2]")), {});
  assert.deepEqual(readPresets(store('{"x":[{"name":"ok","params":{}},{"name":3},null],"y":"no"}')), { x: [{ name: "ok", params: {} }] });
  assert.deepEqual(readPresets(undefined), {});
});

test("a dither preset still matches after its steps get new ids (edit, then put the value back)", () => {
  const step = (id: string, strength: number) => ({ id, type: "dither", enabled: true, params: { strength } });
  const saved = { name: "Look", params: { recipe: { name: "Look", pixelSize: 2, steps: [step("s1", 0.5)] } } };
  assert.equal(matchingPreset([saved], { recipe: { name: "Look", pixelSize: 2, steps: [step("s9", 0.5)] } })?.name, "Look");
  assert.equal(matchingPreset([saved], { recipe: { name: "Look", pixelSize: 2, steps: [step("s9", 0.6)] } }), undefined);
});
