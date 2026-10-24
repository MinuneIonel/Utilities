import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, canConnect, evaluate, outputShapes } from "../src/runtime/evaluate.ts";
import type { Graph, NodeDef, RunContext, TextValue, VideoValue } from "../src/runtime/types.ts";

// A "video" of text frames keeps these tests free of decoders and canvases.
const words = ["one", "two", "three"];
const defs: NodeDef[] = [
  {
    type: "clip", title: "Clip", category: "input", description: "", inputs: [], params: [],
    outputs: [{ key: "video", label: "Video", type: "video" }],
    defaults: () => ({}), kind: "frame",
    async run() {
      const video: VideoValue = {
        kind: "video", of: "text", width: 1, height: 1, duration: 3, fps: 1,
        poster: { kind: "text", text: "poster" },
        async *frames() {
          for (let i = 0; i < words.length; i++) yield { value: { kind: "text", text: words[i] }, timestamp: i, duration: 1 };
        },
      };
      return { video };
    },
  },
  {
    type: "upper", title: "Upper", category: "text", description: "", params: [],
    inputs: [{ key: "text", label: "Text", type: "text" }],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({}), kind: "frame",
    async run(i) {
      return { text: { kind: "text", text: (i.text as TextValue).text.toUpperCase() } };
    },
  },
  {
    type: "join", title: "Join", category: "output", description: "", params: [],
    // A sequence input takes the whole video, like Images to PDF.
    inputs: [{ key: "video", label: "Video", type: "text", sequence: true }],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({}), kind: "job",
    async run(i, _p, ctx) {
      const out: string[] = [];
      for await (const f of (i.video as VideoValue).frames(ctx.signal)) out.push((f.value as TextValue).text);
      return { text: { kind: "text", text: out.join(" ") } };
    },
  },
  {
    type: "save", title: "Save", category: "output", description: "", params: [],
    inputs: [{ key: "text", label: "Text", type: "text" }],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({}), kind: "job",
    async run(i) {
      return { text: i.text! };
    },
  },
];
const registry = new Map(defs.map((d) => [d.type, d]));
const node = (id: string, type: string) => ({ id, type, params: {}, position: { x: 0, y: 0 } });
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle });
const graph: Graph = {
  version: 1,
  nodes: [node("c", "clip"), node("u", "upper"), node("j", "join")],
  edges: [edge("c", "video", "u", "text"), edge("u", "text", "j", "video")],
};

test("a frame node fed a video becomes a video itself", () => {
  const shapes = outputShapes(graph, registry);
  assert.deepEqual(shapes.get("c:video"), { type: "image", seq: true });
  assert.deepEqual(shapes.get("u:text"), { type: "text", seq: true });
  // A job node's single-value input can't take a video; a sequence input can; a video port needs a video.
  assert.equal(canConnect({ type: "text", seq: true }, registry.get("save")!, registry.get("save")!.inputs[0], []).ok, false);
  assert.equal(canConnect({ type: "text", seq: true }, registry.get("join")!, registry.get("join")!.inputs[0], []).ok, true);
  const videoPort = { key: "v", label: "Video", type: "video" as const };
  assert.equal(canConnect({ type: "image", seq: false }, registry.get("join")!, videoPort, []).ok, false);
  assert.equal(canConnect({ type: "image", seq: true }, registry.get("join")!, videoPort, []).ok, true);
});

test("preview maps the poster, Render streams every frame", async () => {
  const cache = new ResultCache();
  const preview: RunContext = { mode: "preview", assets: new Map() };
  const p = await evaluate(graph, { registry, ctx: preview, cache });
  const u = p.get("u")!.outputs.text as VideoValue;
  assert.equal(u.kind, "video");
  assert.equal((u.poster as TextValue).text, "POSTER");
  assert.equal(p.get("j")!.status, "skipped");

  const r = await evaluate(graph, { registry, ctx: { mode: "render", assets: new Map() }, cache });
  assert.equal((r.get("j")!.outputs.text as TextValue).text, "ONE TWO THREE");
});

test("a video into a job node's single input waits with a reason", async () => {
  const g: Graph = { version: 1, nodes: [node("c", "clip"), node("u", "upper"), node("s", "save")], edges: [edge("c", "video", "u", "text"), edge("u", "text", "s", "text")] };
  const r = await evaluate(g, { registry, ctx: { mode: "render", assets: new Map() }, cache: new ResultCache() });
  assert.equal(r.get("s")!.status, "waiting");
  assert.match(r.get("s")!.error!, /not a video/);
});
