import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formProblems,
  inputProblem,
  previewNode,
  readSettings,
  settingsOf,
  settingsPatches,
  startMode,
  validValue,
  type FormNodeDef,
  type WorkflowForm,
} from "../src/simple-form.ts";
import type { ParamDef } from "../src/runtime/types.ts";

// A few node types shaped like the real ones (see src/nodes): a file input, an encoder, Dither, Save.
const DEFS: Record<string, FormNodeDef> = {
  "input.file": { kind: "frame", params: [], defaults: () => ({ assetId: "", name: "", path: "" }) },
  "input.images": { kind: "frame", params: [{ key: "at", label: "Preview image", kind: "number", min: 1, max: 500, step: 1 }], defaults: () => ({ assetIds: [], at: 1 }) },
  "input.download": { kind: "frame", params: [{ key: "url", label: "Link", kind: "text" }], defaults: () => ({ url: "" }) },
  "input.webcam": { kind: "frame", params: [{ key: "sound", label: "Record sound", kind: "toggle" }], defaults: () => ({ sound: true }) },
  "media.encode": {
    kind: "job",
    params: [
      { key: "format", label: "Format", kind: "select", options: [{ value: "jpeg", label: "JPEG" }, { value: "png", label: "PNG" }] },
      { key: "quality", label: "Quality", kind: "number", min: 1, max: 100, step: 1 },
    ],
    defaults: () => ({ format: "jpeg", quality: 80 }),
  },
  "dither.recipe": { kind: "frame", params: [{ key: "recipe", label: "Effect stack", kind: "custom" }], defaults: () => ({ recipe: {} }) },
  "ascii.convert": { kind: "frame", params: [{ key: "settings", label: "Settings", kind: "custom" }], defaults: () => ({ settings: {} }) },
  "output.save-file": { kind: "job", saves: true, params: [{ key: "name", label: "File name", kind: "text" }], defaults: () => ({ name: "", folder: "" }) },
};
const defOf = (t: string) => DEFS[t];
const chain = ["input.file", "media.encode", "output.save-file"];
const compress: WorkflowForm = {
  input: { node: 0, kind: "file" },
  fields: [
    { node: 1, param: "format" },
    { node: 1, param: "quality", label: "Quality" },
  ],
  action: "Compress",
  topic: "image",
};

test("a form that fits its chain has no problems", () => {
  assert.deepEqual(formProblems(compress, chain, defOf), []);
  const look: WorkflowForm = { ...compress, fields: [{ node: 1, param: "recipe" }] };
  assert.deepEqual(formProblems(look, ["input.file", "dither.recipe", "output.save-file"], defOf), [], "Dither's look is the one custom setting a form shows");
});

test("node indexes and params that don't exist are reported", () => {
  const p = formProblems({ ...compress, input: { node: 5, kind: "file" }, fields: [{ node: 1, param: "speed" }, { node: 9, param: "x" }], preview: -1 }, chain, defOf);
  assert.equal(p.length, 4, p.join("\n"));
  assert.match(p.join(" "), /input points at node 5/);
  assert.match(p.join(" "), /media\.encode has no setting speed/);
  assert.match(p.join(" "), /field x points at node 9/);
  assert.match(p.join(" "), /preview points at node -1/);
});

test("the input kind has to match its node", () => {
  assert.match(formProblems({ ...compress, input: { node: 0, kind: "files" } }, chain, defOf).join(" "), /needs input\.file to have assetIds/);
  assert.match(formProblems({ ...compress, input: { node: 0, kind: "link" } }, chain, defOf).join(" "), /to have url/);
  assert.match(formProblems({ ...compress, input: { node: 0, kind: "camera" } }, chain, defOf).join(" "), /must be a Webcam/);
  assert.deepEqual(formProblems({ ...compress, input: { node: 0, kind: "camera" }, fields: [{ node: 0, param: "sound" }] }, ["input.webcam", "output.save-file"], defOf), []);
});

test("other rules: at most four fields, no repeats, no panels, one Save node, a button text", () => {
  const five = Array.from({ length: 5 }, () => ({ node: 1, param: "quality" }));
  const p = formProblems({ ...compress, fields: five, action: " " }, chain, defOf).join(" ");
  assert.match(p, /5 fields; a form shows at most 4/);
  assert.match(p, /there twice/);
  assert.match(p, /no text/);
  assert.match(formProblems({ ...compress, fields: [{ node: 1, param: "settings" }] }, ["input.file", "ascii.convert", "output.save-file"], defOf).join(" "), /own panel/);
  assert.match(formProblems(compress, ["input.file", "media.encode"], defOf).join(" "), /exactly one Save node; this chain has 0/);
  assert.match(formProblems(compress, ["input.file", "nope", "output.save-file"], defOf).join(" "), /nope, which isn't a node type/);
});

test("the preview is the form's pick, or the last node that runs live", () => {
  assert.equal(previewNode(compress, chain, defOf), 0);
  assert.equal(previewNode(compress, ["input.file", "dither.recipe", "media.encode", "output.save-file"], defOf), 1);
  assert.equal(previewNode({ ...compress, preview: 2 }, chain, defOf), 2);
  assert.equal(previewNode(compress, ["media.encode", "output.save-file"], defOf), undefined);
});

test("the button says what's missing in plain words", () => {
  assert.equal(inputProblem("file", { assetId: "" }), "Choose a file first.");
  assert.equal(inputProblem("file", { assetId: "a1" }), undefined);
  assert.equal(inputProblem("files", { assetIds: [] }), "Choose your files first.");
  assert.equal(inputProblem("files", { assetIds: ["a"] }), undefined);
  assert.equal(inputProblem("text", { text: "  " }), "Type or paste some text first.");
  assert.equal(inputProblem("text", { text: "salut" }), undefined);
  assert.equal(inputProblem("link", {}, ""), "Paste a link first.");
  assert.match(inputProblem("link", {}, "youtube video") ?? "", /doesn't look like a link/);
  assert.equal(inputProblem("link", {}, " https://youtu.be/x "), undefined);
  assert.equal(inputProblem("camera", undefined), undefined);
});

test("remembered settings: only the form's fields, only values their param can take", () => {
  const params = [{ assetId: "a1", name: "photo.png" }, { format: "png", quality: 60 }, { name: "", folder: "/x" }];
  const saved = settingsOf(compress, (i) => params[i], "/Users/me/Pictures");
  // Never the files.
  assert.deepEqual(saved, { fields: { "1.format": "png", "1.quality": 60 }, folder: "/Users/me/Pictures" });
  const back = readSettings(JSON.stringify(saved));
  assert.deepEqual(back, saved);
  const def = (node: number, key: string) => defOf(chain[node]).params.find((d) => d.key === key);
  assert.deepEqual([...settingsPatches(compress, back, def)], [[1, { format: "png", quality: 60 }]]);
  // A value out of range, an option that's gone and a field the form no longer has are dropped.
  const stale = { fields: { "1.format": "gif", "1.quality": 500, "0.assetId": "a9", "2.name": "x" } };
  assert.deepEqual([...settingsPatches(compress, stale, def)], []);
});

test("broken or missing settings read as none", () => {
  assert.deepEqual(readSettings(null), { fields: {} });
  assert.deepEqual(readSettings("{ nope"), { fields: {} });
  assert.deepEqual(readSettings('{"fields":[1],"folder":3}'), { fields: {} });
  assert.deepEqual(readSettings('{"fields":{"1.quality":5},"folder":""}'), { fields: { "1.quality": 5 } });
});

test("values are checked against their ParamDef", () => {
  const num: ParamDef = { key: "q", label: "Q", kind: "number", min: 0, max: 10, step: 1 };
  assert.equal(validValue(num, 5), true);
  assert.equal(validValue(num, 11), false);
  assert.equal(validValue(num, "5"), false);
  assert.equal(validValue(num, Number.NaN), false);
  assert.equal(validValue({ key: "t", label: "T", kind: "toggle" }, "yes"), false);
  assert.equal(validValue({ key: "t", label: "T", kind: "text" }, "hi"), true);
  // A time is seconds as a number, with no upper limit.
  assert.equal(validValue({ key: "s", label: "S", kind: "time" }, 90000), true);
  assert.equal(validValue({ key: "s", label: "S", kind: "time" }, -1), false);
  assert.equal(validValue({ key: "s", label: "S", kind: "time" }, "1:05"), false);
  assert.equal(validValue({ key: "c", label: "C", kind: "custom" }, { name: "Game Boy" }), true);
  assert.equal(validValue({ key: "c", label: "C", kind: "custom" }, null), false);
});

test("new people start in Simple view; people with a graph stay in Graph view; then the last view wins", () => {
  assert.equal(startMode(null, false), "simple");
  assert.equal(startMode(null, true), "graph");
  assert.equal(startMode("simple", true), "simple");
  assert.equal(startMode("graph", false), "graph");
  assert.equal(startMode("bogus", false), "simple");
});
