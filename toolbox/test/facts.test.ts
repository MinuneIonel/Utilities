// What a node found (NodeFacts): read off its input, or its own output for a source node, plus its own names.
import assert from "node:assert/strict";
import { test } from "node:test";
import { factsOfValue, nodeFacts } from "../src/runtime/facts.ts";
import type { NodeDef, RunContext, Value } from "../src/runtime/types.ts";

const ctx: RunContext = { mode: "preview", assets: new Map() };
const image = (width: number, height: number, scale?: number): Value => ({ kind: "image", width, height, data: new Uint8ClampedArray(width * height * 4), scale });
const video = (duration: number, fps: number): Value => ({
  kind: "video",
  of: "image",
  width: 1920,
  height: 1080,
  duration,
  fps,
  poster: image(4, 4),
  async *frames() {},
});

const def = (over: Partial<NodeDef>): NodeDef => ({
  type: "t",
  title: "T",
  category: "image",
  description: "",
  inputs: [],
  outputs: [],
  params: [],
  defaults: () => ({}),
  kind: "frame",
  run: async () => ({}),
  ...over,
});

test("a preview frame reports the full-size picture", () => {
  assert.deepEqual(factsOfValue(image(480, 320, 0.25)), { width: 1920, height: 1280 });
  assert.deepEqual(factsOfValue(image(640, 480)), { width: 640, height: 480 });
});

test("a video reports its length and frames; sound its length; a PDF its pages", () => {
  assert.deepEqual(factsOfValue(video(10, 30)), { width: 1920, height: 1080, duration: 10, frames: 300 });
  assert.deepEqual(factsOfValue({ kind: "audio", name: "a", mime: "audio/mpeg", bytes: new Uint8Array(), duration: 3.5 }), { duration: 3.5 });
  assert.deepEqual(factsOfValue({ kind: "document", name: "d.pdf", bytes: new Uint8Array(), pageCount: 12 }), { pages: 12 });
  assert.deepEqual(factsOfValue(undefined), {});
});

test("a node with an input reports its input; a source node its own output", () => {
  const resize = def({ inputs: [{ key: "image", label: "Image", type: "image" }], outputs: [{ key: "image", label: "Image", type: "image" }] });
  assert.deepEqual(nodeFacts(resize, {}, { image: image(1920, 1280) }, { image: image(100, 50) }, ctx), { width: 1920, height: 1280 });
  const source = def({ outputs: [{ key: "video", label: "Video", type: "video" }] });
  assert.equal(nodeFacts(source, {}, {}, { video: video(192, 25) }, ctx)?.duration, 192);
});

test("a node's own names are added, and a failing facts() is ignored", () => {
  const playlist = def({ outputs: [{ key: "video", label: "Video", type: "video" }], facts: (p) => ({ items: [`${p.n} videos`] }) });
  assert.deepEqual(nodeFacts(playlist, { n: 15 }, {}, {}, ctx), { items: ["15 videos"] });
  const broken = def({ facts: () => { throw new Error("no"); } });
  assert.equal(nodeFacts(broken, {}, {}, {}, ctx), undefined);
});
