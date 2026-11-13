import assert from "node:assert/strict";
import { test } from "node:test";
import type { Graph, NodeTimeline } from "../src/runtime/types.ts";
import {
  atOfTime,
  editMarks,
  editParts,
  effectiveRange,
  findTimeSource,
  panSpan,
  playheadTime,
  rangeValue,
  rulerTicks,
  snapTime,
  stripKey,
  tOf,
  timelineMarks,
  upstreamGraph,
  xOf,
  zoomSpan,
  type WalkDef,
} from "../src/timeline.ts";

const port = (key: string, type: WalkDef["inputs"][number]["type"]) => ({ key, label: key, type });
const DEFS: Record<string, WalkDef> = {
  "input.video": { kind: "frame", inputs: [], outputs: [port("video", "video")] },
  "input.audio": { kind: "frame", inputs: [], outputs: [port("audio", "audio")] },
  "input.download": { kind: "frame", inputs: [], outputs: [port("video", "video"), port("audio", "audio"), port("file", "file")] },
  "input.image": { kind: "frame", inputs: [], outputs: [port("image", "image")] },
  "input.webcam": { kind: "frame", live: true, inputs: [], outputs: [port("video", "video")] },
  "dither.recipe": { kind: "frame", inputs: [port("image", "image")], outputs: [port("image", "image")] },
  "video.extract-audio": { kind: "frame", inputs: [port("video", "video")], outputs: [port("audio", "audio")] },
  "video.encode": { kind: "job", inputs: [port("video", "video")], outputs: [port("file", "file")] },
  "media.split": { kind: "job", inputs: [port("video", "video"), port("audio", "audio")], outputs: [port("clips", "file")] },
  "audio.cut": { kind: "job", inputs: [port("audio", "audio")], outputs: [port("audio", "audio")] },
};
const defOf = (t: string) => DEFS[t];

function chain(...links: [string, string, Record<string, unknown>?][]): Graph {
  // [id, type, params]; each node is wired to the one before it, by the first ports that fit.
  const nodes = links.map(([id, type, params]) => ({ id, type, params: params ?? {}, position: { x: 0, y: 0 } }));
  const edges = links.slice(1).map(([id, type], i) => {
    const from = nodes[i];
    const out = DEFS[from.type].outputs[0];
    const into = DEFS[type].inputs.find((p) => p.type === out.type) ?? DEFS[type].inputs[0];
    return { id: `e${i}`, source: from.id, sourceHandle: out.key, target: id, targetHandle: into.key };
  });
  return { version: 1, nodes, edges };
}

test("a file node is its own time source, showing the whole file", () => {
  const g = chain(["v", "input.video"], ["s", "media.split"]);
  assert.deepEqual(findTimeSource(g, "v", defOf), { source: { id: "v", port: "video" }, base: { id: "v", port: "video" }, whole: true });
  const a = chain(["a", "input.audio"]);
  assert.deepEqual(findTimeSource(a, "a", defOf)?.source, { id: "a", port: "audio" });
  const d = chain(["d", "input.download", { quality: "audio" }]);
  assert.equal(findTimeSource(d, "d", defOf)?.source.port, "audio");
});

test("a node after a video looks back through frame nodes, in its input's seconds", () => {
  const g = chain(["v", "input.video"], ["d", "dither.recipe"], ["s", "media.split"]);
  assert.deepEqual(findTimeSource(g, "s", defOf), { source: { id: "v", port: "video" }, base: { id: "d", port: "image" }, whole: false });
  const audio = chain(["v", "input.video"], ["x", "video.extract-audio"], ["c", "audio.cut"]);
  assert.deepEqual(findTimeSource(audio, "c", defOf), { source: { id: "v", port: "video" }, base: { id: "x", port: "audio" }, whole: false });
});

test("no source behind an image, a webcam, a job node or nothing at all", () => {
  assert.equal(findTimeSource(chain(["i", "input.image"], ["d", "dither.recipe"]), "d", defOf), undefined);
  assert.equal(findTimeSource(chain(["w", "input.webcam"], ["e", "video.encode"]), "e", defOf), undefined);
  assert.equal(findTimeSource(chain(["v", "input.video"], ["e", "video.encode"]), "e", defOf)?.source.id, "v");
  assert.equal(findTimeSource(chain(["s", "media.split"]), "s", defOf), undefined);
  assert.equal(findTimeSource(chain(["s", "media.split"]), "missing", defOf), undefined);
});

test("only what feeds a node is worked out for its strip", () => {
  const g = chain(["v", "input.video"], ["d", "dither.recipe"], ["s", "media.split"]);
  const up = upstreamGraph(g, "d");
  assert.deepEqual(up.nodes.map((n) => n.id), ["v", "d"]);
  assert.equal(up.edges.length, 1);
});

test("the strip's key ignores the playhead, and trimming when the whole file shows", () => {
  const g = (p: Record<string, unknown>) => chain(["v", "input.video", { assetId: "a1", ...p }], ["s", "media.split"]);
  const whole = findTimeSource(g({}), "v", defOf)!;
  const after = findTimeSource(g({}), "s", defOf)!;
  assert.equal(stripKey(g({ at: 10 }), whole), stripKey(g({ at: 50, start: 1, end: 3 }), whole));
  assert.equal(stripKey(g({ at: 10 }), after), stripKey(g({ at: 50 }), after));
  assert.notEqual(stripKey(g({ start: 0 }), after), stripKey(g({ start: 1 }), after));
  assert.notEqual(stripKey(g({ assetId: "a2" }), whole), stripKey(g({}), whole));
});

test("seconds and pixels map both ways", () => {
  const span = { t0: 10, t1: 20 };
  assert.equal(xOf(15, span, 200), 100);
  assert.equal(tOf(100, span, 200), 15);
  assert.equal(tOf(xOf(12.34, span, 777), span, 777).toFixed(6), "12.340000");
});

test("zoom keeps the time under the pointer, within the ends", () => {
  const z = zoomSpan({ t0: 0, t1: 100 }, 25, 0.5, 100);
  assert.deepEqual(z, { t0: 12.5, t1: 62.5 });
  // Zooming out past everything shows everything.
  assert.deepEqual(zoomSpan({ t0: 10, t1: 20 }, 15, 100, 100), { t0: 0, t1: 100 });
  // Never closer than the smallest span.
  const close = zoomSpan({ t0: 0, t1: 1 }, 0.5, 0.01, 100);
  assert.ok(Math.abs(close.t1 - close.t0 - 0.2) < 1e-9);
  assert.deepEqual(panSpan({ t0: 10, t1: 20 }, 15, 50), { t0: 25, t1: 35 });
  assert.deepEqual(panSpan({ t0: 10, t1: 20 }, 100, 50), { t0: 40, t1: 50 });
  assert.deepEqual(panSpan({ t0: 10, t1: 20 }, -100, 50), { t0: 0, t1: 10 });
});

test("ruler ticks are round and far enough apart", () => {
  const r = rulerTicks({ t0: 0, t1: 4 }, 800);
  assert.equal(r.step, 0.5);
  assert.equal(r.times[0], 0);
  assert.equal(r.times.at(-1), 4);
  assert.equal(rulerTicks({ t0: 0, t1: 3600 }, 700).step, 600);
  assert.deepEqual(rulerTicks({ t0: 1.3, t1: 2.9 }, 160, 70).times, [2]);
});

test("Start and End as they take effect, and what a drag writes", () => {
  assert.deepEqual(effectiveRange(1, 0, 4), { start: 1, end: 4 });
  assert.deepEqual(effectiveRange(1, 9, 4), { start: 1, end: 4 });
  assert.deepEqual(effectiveRange(2, 1, 4), { start: 2, end: 4 });
  const r = { start: 1, end: 3 };
  assert.equal(rangeValue("end", 2, r, 4), 2);
  // Dragged to the end: End 0, which is what "to the end" is written as.
  assert.equal(rangeValue("end", 3.99, r, 4), 0);
  assert.equal(rangeValue("end", 0.5, r, 4), 1.1);
  assert.equal(rangeValue("start", 3.5, r, 4), 2.9);
  assert.equal(rangeValue("start", -1, r, 4), 0);
  assert.equal(snapTime(2.6, true), 3);
  assert.equal(snapTime(2.6, false), 2.6);
});

test("what's kept and what's taken out", () => {
  const cut: NodeTimeline = { range: { start: "start", end: "end" }, remove: (p) => p.mode === "remove" };
  assert.deepEqual(timelineMarks(cut, { mode: "keep", start: 1, end: 3 }, 6).kept, [{ start: 1, end: 3 }]);
  assert.deepEqual(timelineMarks(cut, { mode: "remove", start: 1, end: 3 }, 6).kept, [
    { start: 0, end: 1 },
    { start: 3, end: 6 },
  ]);
  const split: NodeTimeline = {
    marks: "at",
    parts: "parts",
    uses: (p) => (p.mode === "at" ? "marks" : p.mode === "parts" ? "parts" : "cuts"),
    cuts: (_p, d) => [d / 2],
  };
  assert.deepEqual(timelineMarks(split, { mode: "at", at: "1, 0:02.5" }, 6).marks, [1, 2.5]);
  assert.deepEqual(timelineMarks(split, { mode: "parts", parts: "1-2, 4-end" }, 6).kept, [
    { start: 1, end: 2 },
    { start: 4, end: 6 },
  ]);
  assert.deepEqual(timelineMarks(split, { mode: "count" }, 6).cuts, [3]);
  assert.equal(timelineMarks(undefined, {}, 6).use, undefined);
});

test("marks and parts are edited as the same text Split reads", () => {
  assert.equal(editMarks([], -1, 1.5), "0:01.5");
  assert.equal(editMarks([1.5], -1, 0.75), "0:00.75, 0:01.5");
  assert.equal(editMarks([1, 2], 0, 3), "0:02.0, 0:03.0");
  assert.equal(editMarks([1, 2], 0, undefined), "0:02.0");
  assert.equal(editParts([], -1, { start: 3, end: 1 }), "0:01.0-0:03.0");
  assert.equal(editParts([{ start: 1, end: 2 }], 0, { start: 1, end: 2.5 }), "0:01.0-0:02.5");
  assert.equal(editParts([{ start: 1, end: 2 }], 0, undefined), "");
});

test("the playhead sits within the part the source keeps", () => {
  assert.equal(playheadTime(50, 4), 2);
  assert.equal(playheadTime(50, 10, { start: 2, end: 6 }), 4);
  assert.equal(atOfTime(4, 10, { start: 2, end: 6 }), 50);
  assert.equal(atOfTime(9, 10, { start: 2, end: 6 }), 100);
  assert.equal(atOfTime(1, 4), 25);
});
