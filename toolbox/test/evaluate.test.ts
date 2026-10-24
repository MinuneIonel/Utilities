import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, evaluate, topoSort } from "../src/runtime/evaluate.ts";
import type { Graph, NodeDef, RunContext, Value } from "../src/runtime/types.ts";

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
