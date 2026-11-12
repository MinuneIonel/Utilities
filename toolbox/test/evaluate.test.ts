import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, evaluate, fanout, hash, topoSort } from "../src/runtime/evaluate.ts";
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

test("a rendered job node is marked stale once something before it changes", async () => {
  const cache = new ResultCache();
  await evaluate(chain("hi"), { registry, ctx: renderCtx, cache });
  let r = await evaluate(chain("hi"), { registry, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "cached");
  r = await evaluate(chain("yo"), { registry, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "stale");
  // Still shows the last render, so the card isn't empty.
  assert.equal(textOf(r, "c"), "HI");
  // Going back to what was rendered makes it current again.
  r = await evaluate(chain("hi"), { registry, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "cached");
});

test("preview-only params never make Render run a job again", async () => {
  const withAt: NodeDef = { ...defs[0], type: "src-at", previewParams: ["at"], cacheKey: (_p, c) => c.mode };
  const reg = new Map([...registry, ["src-at", withAt]]);
  const g = (at: number): Graph => {
    const x = chain("hi");
    x.nodes[2] = { ...x.nodes[2], type: "src-at", params: { text: "hi", at } };
    return x;
  };
  const cache = new ResultCache();
  const first = await evaluate(g(10), { registry: reg, ctx: renderCtx, cache });
  let r = await evaluate(g(50), { registry: reg, ctx: preview, cache });
  assert.equal(r.get("c")!.status, "cached");
  runs = [];
  r = await evaluate(g(50), { registry: reg, ctx: renderCtx, cache });
  assert.equal(r.get("c")!.status, "cached");
  assert.ok(!runs.includes("save"));
  // Same key, so the window knows the saved file hasn't changed.
  assert.equal(r.get("c")!.key, first.get("c")!.key);
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

// Sharing work between branches: a video source that counts how often its frames are started.
function sharingDefs(frames = 10) {
  const counts = { starts: 0, split: 0 };
  const video = (origin?: Blob): VideoValue => ({
    kind: "video", of: "text", width: 1, height: 1, duration: frames / 10, fps: 10,
    poster: { kind: "text", text: "poster" },
    origin,
    async *frames() {
      counts.starts++;
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => setTimeout(r, 1));
        yield { value: { kind: "text", text: `f${i}` }, timestamp: i / 10, duration: 0.1 };
      }
    },
  });
  // Reads every frame of its video on Render, like Encode video; `tag` only tells two apart.
  const reader = (type: string, extra: NodeDef["inputs"] = []): NodeDef => ({
    type, title: type, category: "output", description: "", params: [],
    inputs: [{ key: "video", label: "Video", type: "text", sequence: true }, ...extra],
    outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({ tag: "" }), kind: "job",
    async run(i) {
      if (type === "fails") throw new Error("broken");
      const seen: string[] = [];
      for await (const f of (i.video as VideoValue).frames()) seen.push((f.value as { text: string }).text);
      return { text: { kind: "text", text: seen.join(",") } };
    },
  });
  const sdefs: NodeDef[] = [
    {
      type: "vid", title: "Video", category: "input", description: "", inputs: [], params: [],
      outputs: [{ key: "video", label: "Video", type: "video" }], defaults: () => ({ origin: false }), kind: "frame",
      run: async (_i, p) => ({ video: video(p.origin ? new Blob(["x"]) : undefined) }),
    },
    defs0("upper"),
    {
      // Two outputs, like Remove background's image and mask.
      type: "two", title: "Two", category: "image", description: "", params: [],
      inputs: [{ key: "text", label: "Text", type: "text" }],
      outputs: [{ key: "a", label: "A", type: "text" }, { key: "b", label: "B", type: "text" }],
      defaults: () => ({}), kind: "frame",
      async run(i) {
        counts.split++;
        const t = (i.text as { text: string }).text;
        return { a: { kind: "text", text: `${t}a` }, b: { kind: "text", text: `${t}b` } };
      },
    },
    {
      type: "join", title: "Join", category: "image", description: "", params: [],
      inputs: [{ key: "x", label: "X", type: "text" }, { key: "y", label: "Y", type: "text" }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({}), kind: "frame",
      async run(i) {
        return { text: { kind: "text", text: `${(i.x as { text: string }).text}+${(i.y as { text: string }).text}` } };
      },
    },
    reader("read"),
    reader("fails"),
    reader("needs-two", [{ key: "other", label: "Other", type: "text" }]),
    defs0("save"),
  ];
  return { counts, registry: new Map(sdefs.map((d) => [d.type, d])) };
}

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle });
/** Fails instead of hanging when a reader is left waiting for another. */
const inTime = <T>(p: Promise<T>, ms = 3000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error("timed out: a reader is stuck waiting")), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};
const frameList = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_x, i) => f(i)).join(",");

test("a frame node with two outputs read side by side runs once per frame", async () => {
  const s = sharingDefs(10);
  const g: Graph = {
    version: 1,
    nodes: [node("v", "vid"), node("t", "two"), node("j", "join"), node("r", "read")],
    edges: [wire("v", "video", "t", "text"), wire("t", "a", "j", "x"), wire("t", "b", "j", "y"), wire("j", "text", "r", "video")],
  };
  const r = await inTime(evaluate(g, { registry: s.registry, ctx: renderCtx, cache: new ResultCache() }));
  assert.equal(textOf(r, "r"), frameList(10, (i) => `f${i}a+f${i}b`));
  // 10 frames + the poster, not 10 per output.
  assert.equal(s.counts.split, 11);
  assert.equal(s.counts.starts, 1);
});

test("two job nodes reading the same video decode it once", async () => {
  const s = sharingDefs(10);
  const g: Graph = {
    version: 1,
    nodes: [node("v", "vid"), node("u", "upper"), node("r1", "read"), node("r2", "read", { tag: "2" })],
    edges: [wire("v", "video", "u", "text"), wire("u", "text", "r1", "video"), wire("u", "text", "r2", "video")],
  };
  const r = await inTime(evaluate(g, { registry: s.registry, ctx: renderCtx, cache: new ResultCache() }));
  const want = frameList(10, (i) => `F${i}`);
  assert.equal(textOf(r, "r1"), want);
  assert.equal(textOf(r, "r2"), want);
  assert.equal(s.counts.starts, 1);
});

test("a job after one sharing reader doesn't hold up the other reader", async () => {
  // Listed so that the order is v, r1, s, r2: running one node at a time in that order
  // would wait on r1, which waits for r2 to start reading.
  const s = sharingDefs(20);
  const g: Graph = {
    version: 1,
    nodes: [node("s", "save"), node("r1", "read"), node("r2", "read", { tag: "2" }), node("v", "vid")],
    edges: [wire("v", "video", "r1", "video"), wire("v", "video", "r2", "video"), wire("r1", "text", "s", "text")],
  };
  assert.deepEqual(topoSort(g).map((n) => n.id), ["v", "r1", "s", "r2"]);
  const r = await inTime(evaluate(g, { registry: s.registry, ctx: renderCtx, cache: new ResultCache() }));
  assert.equal(textOf(r, "s"), frameList(20, (i) => `f${i}`));
  assert.equal(textOf(r, "r2"), frameList(20, (i) => `f${i}`));
  assert.equal(s.counts.starts, 1);
});

test("a sharing reader that is a cache hit lets the other finish", async () => {
  const s = sharingDefs(20);
  const cache = new ResultCache();
  const one: Graph = { version: 1, nodes: [node("v", "vid"), node("r1", "read")], edges: [wire("v", "video", "r1", "video")] };
  await evaluate(one, { registry: s.registry, ctx: renderCtx, cache });
  const both: Graph = { ...one, nodes: [...one.nodes, node("r2", "read", { tag: "2" })], edges: [...one.edges, wire("v", "video", "r2", "video")] };
  const r = await inTime(evaluate(both, { registry: s.registry, ctx: renderCtx, cache }));
  assert.equal(r.get("r1")!.status, "cached");
  assert.equal(r.get("r2")!.status, "ok");
  assert.equal(textOf(r, "r2"), frameList(20, (i) => `f${i}`));
});

test("a sharing reader missing another input, or failing, lets the other finish", async () => {
  for (const type of ["needs-two", "fails"]) {
    const s = sharingDefs(20);
    const g: Graph = {
      version: 1,
      nodes: [node("v", "vid"), node("r1", type), node("r2", "read")],
      edges: [wire("v", "video", "r1", "video"), wire("v", "video", "r2", "video")],
    };
    const r = await inTime(evaluate(g, { registry: s.registry, ctx: renderCtx, cache: new ResultCache() }));
    assert.equal(r.get("r1")!.status, type === "fails" ? "error" : "waiting");
    assert.equal(textOf(r, "r2"), frameList(20, (i) => `f${i}`), type);
  }
});

test("an untouched file isn't shared: an encoder may read the file itself", async () => {
  const s = sharingDefs(10);
  const g: Graph = {
    version: 1,
    nodes: [node("v", "vid", { origin: true }), node("r1", "read"), node("r2", "read", { tag: "2" })],
    edges: [wire("v", "video", "r1", "video"), wire("v", "video", "r2", "video")],
  };
  const r = await inTime(evaluate(g, { registry: s.registry, ctx: renderCtx, cache: new ResultCache() }));
  assert.equal(textOf(r, "r2"), frameList(10, (i) => `f${i}`));
  assert.equal(s.counts.starts, 2);
});

test("fanout leaves out live values, mapped jobs and readers fed by another reader", () => {
  const s = sharingDefs();
  const g: Graph = {
    version: 1,
    nodes: [node("v", "vid"), node("r1", "read"), node("r2", "read"), node("r3", "read"), node("t", "two"), node("s", "save")],
    edges: [
      wire("v", "video", "r1", "video"),
      wire("v", "video", "r2", "video"),
      wire("v", "video", "t", "text"),
      wire("t", "a", "r3", "video"),
      wire("t", "a", "s", "text"),
    ],
  };
  // Save takes one value, so it runs once per frame, later (it isn't a reader); r3 reads alone.
  assert.deepEqual([...fanout(g, s.registry)], [["v:video", ["r1", "r2"]]]);
  assert.deepEqual([...fanout(g, s.registry, new Set(["v", "r1", "r2", "t", "r3", "s"]))], []);
  // r2 now waits for r1's result: it couldn't start while r1 waits for it.
  const reg = new Map(s.registry);
  const read = s.registry.get("read")!;
  reg.set("read", { ...read, inputs: [...read.inputs, { key: "other", label: "Other", type: "text", optional: true }] });
  const chained: Graph = { ...g, edges: [...g.edges, wire("r1", "text", "r2", "other")] };
  assert.deepEqual([...fanout(chained, reg)], []);
});

test("graphs in different scopes don't share last renders, even with the same node ids", async () => {
  const cache = new ResultCache();
  await evaluate(chain("one"), { registry, ctx: renderCtx, cache, scope: "A" });
  // Tab B holds a graph with the same ids: its job node hasn't been rendered there.
  let b = await evaluate(chain("two"), { registry, ctx: preview, cache, scope: "B" });
  assert.equal(b.get("c")!.status, "skipped");
  await evaluate(chain("two"), { registry, ctx: renderCtx, cache, scope: "B" });
  b = await evaluate(chain("two"), { registry, ctx: preview, cache, scope: "B" });
  assert.equal(textOf(b, "c"), "TWO");
  const a = await evaluate(chain("one"), { registry, ctx: preview, cache, scope: "A" });
  assert.equal(a.get("c")!.status, "cached");
  assert.equal(textOf(a, "c"), "ONE");
});

test("forgetting a scope drops only that graph's last renders", async () => {
  const cache = new ResultCache();
  await evaluate(chain("one"), { registry, ctx: renderCtx, cache, scope: "A" });
  await evaluate(chain("one"), { registry, ctx: renderCtx, cache, scope: "AB" });
  cache.forget("A");
  const a = await evaluate(chain("one"), { registry, ctx: preview, cache, scope: "A" });
  assert.equal(a.get("c")!.status, "skipped");
  const ab = await evaluate(chain("one"), { registry, ctx: preview, cache, scope: "AB" });
  assert.equal(ab.get("c")!.status, "cached");
});
