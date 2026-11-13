import assert from "node:assert/strict";
import { test } from "node:test";
import { findNode, nodeLabel, prepareRun, progressStep, RunError, type NodeInfo, type RunInput } from "../src/headless-plan.ts";

const INFO: Record<string, NodeInfo> = {
  "input.file": { title: "Image file", category: "input", defaults: { assetId: "", name: "" } },
  "input.images": { title: "Several images", category: "input", defaults: { assetIds: [], names: [], at: 1 } },
  "input.qr": { title: "QR code", category: "input", defaults: { text: "", size: 256 } },
  "input.webcam": { title: "Webcam", category: "input", defaults: { resolution: "640x480" } },
  "dither.recipe": { title: "Dither", category: "image", defaults: { size: "source" } },
  "output.save-file": { title: "Save", category: "output", saves: true, defaults: { name: "", folder: "", exists: "replace-own", lastSaved: [] } },
};
const info = (t: string) => INFO[t];
const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params: { ...INFO[type]?.defaults, ...params }, position: { x: 0, y: 0 } });
const graph = (...nodes: ReturnType<typeof node>[]) => ({
  version: 1 as const,
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, sourceHandle: "out", target: n.id, targetHandle: "in" })),
});
const file = (nodeName: string, p: string): RunInput => ({ node: nodeName, path: p, dir: false, files: [p] });
const folder = (nodeName: string, p: string, files: string[]): RunInput => ({ node: nodeName, path: p, dir: true, files });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RunError, String(e));
    return { code: e.code, message: e.message };
  }
  assert.fail("expected a RunError");
};

test("nodes are named by id, or by a title only one node has", () => {
  const g = graph(node("a", "input.file"), node("d1", "dither.recipe"), node("d2", "dither.recipe"), node("s", "output.save-file"));
  assert.equal(findNode(g, "a", info).id, "a");
  assert.equal(findNode(g, "image FILE", info).id, "a");
  assert.equal(findNode(g, "d2", info).id, "d2");
  assert.match(code(() => findNode(g, "Dither", info)).message, /2 nodes are called "Dither".*d1, d2/);
  assert.match(code(() => findNode(g, "Blur", info)).message, /no node called "Blur".*Image file, Dither, Save/);
  assert.equal(nodeLabel(g, "a", info), "Image file");
  assert.equal(nodeLabel(g, "d1", info), "Dither (d1)");
});

test("settings, inputs and the out folder go into the graph, leaving the original alone", () => {
  const g = graph(node("a", "input.file"), node("d", "dither.recipe"), node("s", "output.save-file"));
  const out = prepareRun(g, { sets: [{ node: "Dither", param: "size", value: "pixels" }], inputs: [file("Image file", "/in/pic.png")], out: "/out" }, info);
  assert.equal(out.nodes[1].params.size, "pixels");
  assert.deepEqual([out.nodes[0].params.path, out.nodes[0].params.name], ["/in/pic.png", "pic.png"]);
  assert.equal(out.nodes[2].params.folder, "/out");
  assert.equal(g.nodes[1].params.size, "source");
  assert.equal(g.nodes[2].params.folder, "");
});

test("a Save node's own folder wins over --out; with neither, it's a bad argument", () => {
  const g = graph(node("q", "input.qr"), node("s", "output.save-file", { folder: "/mine" }));
  assert.equal(prepareRun(g, { sets: [], inputs: [], out: "/out" }, info).nodes[1].params.folder, "/mine");
  const bare = graph(node("q", "input.qr"), node("s", "output.save-file"));
  assert.deepEqual(code(() => prepareRun(bare, { sets: [], inputs: [], out: "" }, info)).code, 2);
});

test("Several images takes every --input, and folders give their images", () => {
  const g = graph(node("i", "input.images"), node("s", "output.save-file", { folder: "/o" }));
  const out = prepareRun(g, { sets: [], inputs: [folder("Several images", "/in", ["/in/a.png", "/in/b.png"]), file("i", "/x/c.jpg")], out: "" }, info);
  assert.deepEqual(out.nodes[0].params.paths, ["/in/a.png", "/in/b.png", "/x/c.jpg"]);
  assert.deepEqual(out.nodes[0].params.names, ["a.png", "b.png", "c.jpg"]);
  assert.equal(out.nodes[0].params.name, "3 images");
  assert.equal(code(() => prepareRun(g, { sets: [], inputs: [folder("i", "/empty", [])], out: "" }, info)).code, 2);
});

test("a folder input (C6) gets its folder from --input", () => {
  // input.folder isn't known here: it's recognised by its type name.
  const g = graph(node("f", "input.folder", { folder: "" }), node("s", "output.save-file", { folder: "/o" }));
  const out = prepareRun(g, { sets: [], inputs: [folder("f", "/in", [])], out: "" }, info);
  assert.equal(out.nodes[0].params.folder, "/in");
  assert.equal(code(() => prepareRun(g, { sets: [], inputs: [file("f", "/in/a.png")], out: "" }, info)).code, 2);
});

test("what can't run without the window, and mistakes on the command line", () => {
  const cam = graph(node("w", "input.webcam"), node("s", "output.save-file", { folder: "/o" }));
  assert.deepEqual(code(() => prepareRun(cam, { sets: [], inputs: [], out: "" }, info)), { code: 1, message: "A webcam graph needs the window" });
  const g = graph(node("a", "input.file"), node("s", "output.save-file", { folder: "/o" }));
  const missing = code(() => prepareRun(g, { sets: [], inputs: [], out: "" }, info));
  assert.equal(missing.code, 1);
  assert.match(missing.message, /Image file has no file.*--input "Image file=<file>"/);
  assert.match(code(() => prepareRun(g, { sets: [{ node: "a", param: "nope", value: 1 }], inputs: [], out: "" }, info)).message, /no setting "nope"/);
  assert.equal(code(() => prepareRun(g, { sets: [], inputs: [folder("a", "/in", ["/in/x.png"])], out: "" }, info)).code, 2);
  assert.equal(code(() => prepareRun(g, { sets: [], inputs: [file("a", "/1.png"), file("a", "/2.png")], out: "" }, info)).code, 2);
  assert.equal(code(() => prepareRun(g, { sets: [], inputs: [file("Save", "/1.png")], out: "" }, info)).code, 2);
});

test("progress lines: the first, then every 10%", () => {
  assert.equal(progressStep(0.03, undefined), 3);
  assert.equal(progressStep(0.1, 3), undefined);
  assert.equal(progressStep(0.13, 3), 13);
  assert.equal(progressStep(-1, undefined), -1);
  assert.equal(progressStep(-1, -1), undefined);
  assert.equal(progressStep(1, 95), 100);
});
