import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, evaluate, hash, topoSort } from "../src/runtime/evaluate.ts";
import type { FrameItem, Graph, NodeDef, RunContext, Value, VideoValue } from "../src/runtime/types.ts";

// Text nodes keep the tests free of canvases: "src" emits params.text, "upper" upper-cases, "save" is a job.
let runs: string[] = [];
const defs: NodeDef[] = [
  {
    type: "src", title: "Source", category: "input", description: "", inputs: [], params: [],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({ text: "" }), kind: "frame",
    async run(_i, p) {
      runs.push("src");
      return { text: { kind: "text", text: String(p.text) } };
    },
  },
  {
    type: "upper", title: "Upper", category: "text", description: "", params: [],
    inputs: [{ key: "text", label: "Text", type: "text" }],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({}), kind: "frame",
    async run(i) {
      runs.push("upper");
      const t = i.text;
      if (t?.kind !== "text") throw new Error("bad input");
      return { text: { kind: "text", text: t.text.toUpperCase() } };
    },
  },
  {
    type: "save", title: "Save", category: "output", description: "", params: [],
    inputs: [{ key: "text", label: "Text", type: "text" }],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({}), kind: "job",
    async run(i) {
      runs.push("save");
      return { text: i.text! };
    },
  },
];
const registry = new Map(defs.map((d) => [d.type, d]));
const preview: RunContext = { mode: "preview", assets: new Map() };
const renderCtx: RunContext = { mode: "render", assets: new Map() };

function chain(text: string): Graph {
  return {
    version: 1,
    nodes: [
      { id: "c", type: "save", params: {}, position: { x: 0, y: 0 } },
      { id: "b", type: "upper", params: {}, position: { x: 0, y: 0 } },
      { id: "a", type: "src", params: { text }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "1", source: "a", sourceHandle: "text", target: "b", targetHandle: "text" },
      { id: "2", source: "b", sourceHandle: "text", target: "c", targetHandle: "text" },
    ],
  };
}

const textOf = (r: Map<string, { outputs: Record<string, unknown> }>, id: string) =>
  (r.get(id)!.outputs.text as { text: string } | undefined)?.text;

test("runs nodes in dependency order", async () => {
  runs = [];
  const r = await evaluate(chain("hi"), { registry, ctx: renderCtx, cache: new ResultCache() });
  assert.deepEqual(runs, ["src", "upper", "save"]);
  assert.equal(textOf(r, "c"), "HI");
});

test("preview skips job nodes until they have been rendered", async () => {
  runs = [];
  const cache = new ResultCache();
  let r = await evaluate(chain("hi"), { registry, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "skipped");
  assert.deepEqual(runs, ["src", "upper"]);
  await evaluate(chain("hi"), { registry, ctx: renderCtx, cache });
  r = await evaluate(chain("hi"), { registry, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "cached");
  assert.equal(textOf(r, "c"), "HI");
});

test("unchanged nodes come from the cache; a param change re-runs only downstream", async () => {
  const cache = new ResultCache();
  await evaluate(chain("hi"), { registry, ctx: preview, cache });
  runs = [];
  const again = await evaluate(chain("hi"), { registry, ctx: preview, cache });
  assert.deepEqual(runs, []);
  assert.equal(again.get("b")!.status, "cached");
  runs = [];
  const changed = await evaluate(chain("yo"), { registry, ctx: preview, cache });
  assert.deepEqual(runs, ["src", "upper"]);
  assert.equal(textOf(changed, "b"), "YO");
});

test("a node with an unconnected input waits instead of running", async () => {
  const g = chain("hi");
  g.edges = g.edges.filter((e) => e.id !== "1");
  runs = [];
  const r = await evaluate(g, { registry, ctx: renderCtx, cache: new ResultCache() });
  assert.equal(r.get("b")!.status, "waiting");
  assert.equal(r.get("c")!.status, "waiting");
  assert.deepEqual(runs, ["src"]);
});

test("a node fed by a waiting node waits too", async () => {
  const g = chain("hi");
  g.nodes.push({ id: "x", type: "upper", params: {}, position: { x: 0, y: 0 } });
  g.edges = [{ id: "3", source: "x", sourceHandle: "text", target: "c", targetHandle: "text" }];
  const r = await evaluate(g, { registry, ctx: renderCtx, cache: new ResultCache() });
  assert.equal(r.get("x")!.status, "waiting");
  assert.equal(r.get("c")!.status, "waiting");
});

test("loops are rejected", () => {
  const g = chain("hi");
  g.edges.push({ id: "4", source: "c", sourceHandle: "text", target: "a", targetHandle: "text" });
  assert.throws(() => topoSort(g), /loop/);
});

test("the cache drops the oldest entries past its byte budget", () => {
  const cache = new ResultCache(10);
  cache.set("a", { t: { kind: "text", text: "abc" } }); // 6 bytes
  cache.set("b", { t: { kind: "text", text: "def" } }); // 12 bytes total, so "a" goes
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"));
});

test("a wire between different port types goes through a converter", async () => {
  const lenDefs: NodeDef[] = [
    ...defs,
    {
      type: "len", title: "Length", category: "text", description: "", params: [],
      inputs: [{ key: "n", label: "Number", type: "grid" }],
      outputs: [{ key: "text", label: "Text", type: "text" }],
      defaults: () => ({}), kind: "frame",
      async run(i) {
        return { text: { kind: "text", text: `got ${(i.n as { text: string }).text}` } };
      },
    },
  ];
  const g: Graph = {
    version: 1,
    nodes: [
      { id: "a", type: "src", params: { text: "abc" }, position: { x: 0, y: 0 } },
      { id: "b", type: "len", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ id: "1", source: "a", sourceHandle: "text", target: "b", targetHandle: "n" }],
  };
  const reg = new Map(lenDefs.map((d) => [d.type, d]));
  const without = await evaluate(g, { registry: reg, ctx: renderCtx, cache: new ResultCache() });
  assert.equal(without.get("b")!.status, "waiting");
  let conversions = 0;
  const converters = [
    {
      from: "text" as const, to: "grid" as const, label: "count",
      async convert(v: Value) {
        conversions++;
        return { kind: "text" as const, text: String((v as { text: string }).text.length) };
      },
    },
  ];
  const cache = new ResultCache();
  const r = await evaluate(g, { registry: reg, ctx: renderCtx, cache, converters });
  assert.equal(textOf(r, "b"), "got 3");
  await evaluate(g, { registry: reg, ctx: renderCtx, cache, converters });
  assert.equal(conversions, 1, "a cache hit skips the conversion");
});

test("live nodes and everything after them stay out of the cache", async () => {
  let frame = 0;
  const liveDefs: NodeDef[] = [
    ...defs,
    {
      type: "cam", title: "Camera", category: "input", description: "", inputs: [], params: [],
      outputs: [{ key: "text", label: "Text", type: "text" }],
      defaults: () => ({}), kind: "frame", live: true,
      cacheKey: () => String(++frame),
      async run() {
        return { text: { kind: "text", text: `frame ${frame}` } };
      },
    },
  ];
  const g = chain("unused");
  g.nodes = g.nodes.map((n) => (n.id === "a" ? { ...n, type: "cam" } : n));
  g.nodes.push({ id: "s", type: "src", params: { text: "still" }, position: { x: 0, y: 0 } });
  const cache = new ResultCache();
  const reg = new Map(liveDefs.map((d) => [d.type, d]));
  for (let i = 0; i < 5; i++) {
    const r = await evaluate(g, { registry: reg, ctx: preview, cache });
    assert.equal(textOf(r, "b"), `FRAME ${frame}`);
  }
  assert.equal(cache.size, 1, "only the node that isn't fed by the camera is cached");
});

test("cache keys are 64-bit", () => {
  assert.match(hash("a"), /^[0-9a-f]{16}$/);
  assert.notEqual(hash("ab"), hash("ba"));
});

// A live source whose frames only reach the readers listening when they arrive, like a webcam.
function liveDefs(): { defs: NodeDef[]; emit(): Promise<void> } {
  const readers = new Set<(f: FrameItem | null) => void>();
  const video = (): VideoValue => ({
    kind: "video", of: "text", width: 1, height: 1, duration: 0, fps: 30,
    poster: { kind: "text", text: "poster" },
    range: { start: 1, end: 2 },
    soundLater: async () => undefined,
    async *frames() {
      const queue: (FrameItem | null)[] = [];
      let wake: (() => void) | undefined;
      const r = (f: FrameItem | null) => (queue.push(f), wake?.());
      readers.add(r);
      try {
        for (;;) {
          if (!queue.length) await new Promise<void>((res) => (wake = res));
          const f = queue.shift()!;
          if (!f) return;
          yield f;
        }
      } finally {
        readers.delete(r);
      }
    },
  });
  const defs: NodeDef[] = [
    {
      type: "cam", title: "Cam", category: "input", description: "", inputs: [], params: [], live: true,
      outputs: [{ key: "video", label: "Video", type: "video" }], defaults: () => ({}), kind: "frame",
      run: async () => ({ video: video() }),
    },
    defs0("upper"),
    {
      type: "count", title: "Count", category: "output", description: "", params: [],
      inputs: [{ key: "video", label: "Video", type: "text", sequence: true }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({}), kind: "job",
      async run(i) {
        const v = i.video as VideoValue;
        let n = 0;
        for await (const f of v.frames()) n += f.value.kind === "text" && f.value.text === f.value.text.toUpperCase() ? 1 : 0;
        return { text: { kind: "text", text: `${n} ${v.range?.start}-${v.range?.end} ${!!v.soundLater}` } };
      },
    },
  ];
  return {
    defs,
    async emit() {
      // Give every consumer time to start reading, as a person takes time to press Stop.
      await new Promise((r) => setTimeout(r, 20));
      for (const t of ["a", "b", "c"]) for (const r of readers) r({ value: { kind: "text", text: t }, timestamp: 0, duration: 0 });
      for (const r of [...readers]) r(null);
    },
  };
}
const defs0 = (type: string) => defs.find((d) => d.type === type)!;

test("during a recording, two consumers of a live video both get every frame", async () => {
  const live = liveDefs();
  const reg = new Map(live.defs.map((d) => [d.type, d]));
  const g: Graph = {
    version: 1,
    nodes: [
      { id: "cam", type: "cam", params: {}, position: { x: 0, y: 0 } },
      { id: "up", type: "upper", params: {}, position: { x: 0, y: 0 } },
      { id: "n1", type: "count", params: {}, position: { x: 0, y: 0 } },
      { id: "n2", type: "count", params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "1", source: "cam", sourceHandle: "video", target: "up", targetHandle: "text" },
      { id: "2", source: "up", sourceHandle: "text", target: "n1", targetHandle: "video" },
      { id: "3", source: "up", sourceHandle: "text", target: "n2", targetHandle: "video" },
    ],
  };
  const done = evaluate(g, { registry: reg, ctx: renderCtx, cache: new ResultCache() });
  await live.emit();
  const r = await done;
  // The mapped node keeps the trim and the late sound of the video it runs on.
  assert.equal(textOf(r, "n1"), "3 1-2 true");
  assert.equal(textOf(r, "n2"), "3 1-2 true");
});
