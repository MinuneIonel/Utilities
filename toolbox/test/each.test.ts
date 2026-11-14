// The runtime's per-file Render (evaluateEach), on fake nodes: a node giving whole files one after
// another, the nodes after it run once per file, and Save collecting one batch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, evaluate } from "../src/runtime/evaluate.ts";
import type { DocumentValue, EachValue, FileValue, Graph, NodeDef, NodeResult, RunContext } from "../src/runtime/types.ts";

let runs: string[] = [];
const doc = (name: string, text: string): DocumentValue => ({ kind: "document", name, bytes: new TextEncoder().encode(text), pageCount: 1 });
const textOf = (v: { bytes: Uint8Array } | FileValue) => new TextDecoder().decode("bytes" in v ? v.bytes : (v.data as { bytes: Uint8Array }).bytes);

/** Files the fake folder holds, by name: text, or "!" to fail when opened. */
let files: Record<string, string> = {};

const defs: NodeDef[] = [
  {
    type: "folder", title: "Folder", category: "input", description: "", inputs: [], params: [],
    outputs: [{ key: "docs", label: "Docs", type: "document" }],
    defaults: () => ({ at: 1 }), kind: "frame", previewParams: ["at"],
    each: () => true,
    cacheKey: (_p, ctx) => `${ctx.mode}|${JSON.stringify(files)}`,
    async run(_i, p, ctx) {
      runs.push("folder");
      const names = Object.keys(files);
      if (!names.length) throw Object.assign(new Error("No files yet"), { waiting: true });
      if (ctx.mode === "preview") {
        const n = names[Math.min(names.length, Number(p.at) || 1) - 1];
        return { docs: doc(n, files[n]) };
      }
      const each: EachValue = {
        kind: "each",
        of: "document",
        items: names.map((n) => ({
          id: `${n}:${files[n]}`,
          name: n,
          async load() {
            if (files[n] === "!") throw new Error("can't open");
            return doc(n, files[n]);
          },
        })),
      };
      return { docs: each };
    },
  },
  {
    type: "word", title: "Word", category: "input", description: "", inputs: [], params: [],
    outputs: [{ key: "text", label: "Text", type: "text" }],
    defaults: () => ({ text: "" }), kind: "frame",
    async run(_i, p) {
      runs.push("word");
      return { text: { kind: "text", text: String(p.text) } };
    },
  },
  {
    type: "stamp", title: "Stamp", category: "pdf", description: "", params: [],
    inputs: [{ key: "doc", label: "Doc", type: "document" }, { key: "text", label: "Text", type: "text", optional: true }],
    outputs: [{ key: "doc", label: "Doc", type: "document" }],
    defaults: () => ({}), kind: "frame",
    async run(i) {
      const d = i.doc as DocumentValue;
      runs.push(`stamp:${d.name}`);
      if (textOf(d) === "bad") throw new Error("broken page");
      const w = i.text?.kind === "text" ? i.text.text : "";
      return { doc: doc(d.name, `${textOf(d)}+${w}`) };
    },
  },
  {
    type: "pack", title: "Pack", category: "pdf", description: "", params: [],
    inputs: [{ key: "doc", label: "Doc", type: "document" }],
    outputs: [{ key: "file", label: "File", type: "file" }],
    defaults: () => ({}), kind: "job",
    async run(i) {
      const d = i.doc as DocumentValue;
      runs.push(`pack:${d.name}`);
      const f: FileValue = { kind: "file", name: "out.pdf", mime: "application/pdf", data: { in: "memory", bytes: d.bytes } };
      return { file: f };
    },
  },
  {
    type: "save", title: "Save", category: "output", description: "", params: [],
    inputs: [{ key: "file", label: "File", type: "file", sequence: true }],
    outputs: [{ key: "file", label: "File", type: "file" }],
    defaults: () => ({}), kind: "job", saves: true,
    async run(i, _p, ctx) {
      const f = i.file as FileValue;
      runs.push(`save:${ctx.item?.name}`);
      return { file: { ...f, name: `${ctx.item?.name.replace(/\.[^.]+$/, "")}.pdf` } };
    },
  },
];
const registry = new Map(defs.map((d) => [d.type, d]));
const preview: RunContext = { mode: "preview", assets: new Map() };
const render: RunContext = { mode: "render", assets: new Map() };

const node = (id: string, type: string, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle });

/** folder → stamp (← word) → pack → save */
function graph(): Graph {
  return {
    version: 1,
    nodes: [node("f", "folder"), node("w", "word", { text: "hi" }), node("s", "stamp"), node("p", "pack"), node("v", "save")],
    edges: [edge("f", "docs", "s", "doc"), edge("w", "text", "s", "text"), edge("s", "doc", "p", "doc"), edge("p", "file", "v", "file")],
  };
}

const run = (g: Graph, cache: ResultCache, ctx = render, reported?: Map<string, NodeResult[]>) =>
  evaluate(g, { registry, ctx, cache, onNode: (id, r) => reported?.set(id, [...(reported.get(id) ?? []), r]) });

const batchOf = (r: NodeResult | undefined) => {
  const f = r?.outputs.file as FileValue | undefined;
  return f ? (f.batch ?? [f]).map((x) => `${x.name}=${textOf(x)}`) : [];
};

test("Render runs the nodes after the folder once per file, and Save collects one batch", async () => {
  runs = [];
  files = { "a.pdf": "A", "sub/b.pdf": "B", "c.pdf": "C" };
  const reported = new Map<string, NodeResult[]>();
  const r = await run(graph(), new ResultCache(), render, reported);
  assert.deepEqual(batchOf(r.get("v")), ["a.pdf=A+hi", "sub/b.pdf=B+hi", "c.pdf=C+hi"]);
  assert.equal(r.get("v")?.status, "ok");
  // What doesn't follow the folder ran once.
  assert.equal(runs.filter((x) => x === "word").length, 1);
  assert.deepEqual(runs.filter((x) => x.startsWith("save:")), ["save:a.pdf", "save:sub/b.pdf", "save:c.pdf"]);
  // Save is reported once, with the whole batch (the window writes what it's sent).
  assert.equal(reported.get("v")?.length, 1);
  assert.equal(batchOf(reported.get("v")![0]).length, 3);
});

test("after a Render, the live preview counts its jobs as up to date", async () => {
  files = { "a.pdf": "A", "b.pdf": "B" };
  const cache = new ResultCache();
  await run(graph(), cache);
  const p = await run(graph(), cache, preview);
  assert.equal(p.get("v")?.status, "cached");
  assert.equal(batchOf(p.get("v")).length, 2);
  // The preview's folder gives the previewed file itself.
  assert.equal((p.get("s")?.outputs.doc as DocumentValue).name, "a.pdf");
  // A new file makes it out of date.
  files = { ...files, "c.pdf": "C" };
  const q = await run(graph(), cache, preview);
  assert.equal(q.get("v")?.status, "stale");
});

test("Render again runs only the new files' jobs", async () => {
  files = { "a.pdf": "A", "b.pdf": "B" };
  const cache = new ResultCache();
  await run(graph(), cache);
  runs = [];
  files = { ...files, "c.pdf": "C" };
  const r = await run(graph(), cache);
  assert.deepEqual(batchOf(r.get("v")), ["a.pdf=A+hi", "b.pdf=B+hi", "c.pdf=C+hi"]);
  assert.deepEqual(runs.filter((x) => x.startsWith("pack:") || x.startsWith("save:")), ["pack:c.pdf", "save:c.pdf"]);
});

test("a file that fails doesn't stop the others; it's marked so it isn't counted as done", async () => {
  files = { "a.pdf": "A", "b.pdf": "bad", "c.pdf": "!", "d.pdf": "D" };
  const cache = new ResultCache();
  const r = await run(graph(), cache);
  assert.deepEqual(batchOf(r.get("v")), ["a.pdf=A+hi", "d.pdf=D+hi"]);
  assert.equal(r.get("v")?.status, "error");
  assert.match(r.get("v")?.error ?? "", /2 of 4 files failed/);
  assert.match(r.get("s")?.error ?? "", /1 of 4 files failed here\. b\.pdf: broken page/);
  const each = r.get("f")?.outputs.docs as EachValue;
  assert.deepEqual(each.items.map((i) => !!i.failed), [false, true, true, false]);
  // Not up to date: the next Render tries again.
  const p = await run(graph(), cache, preview);
  assert.equal(p.get("v")?.status, "stale");
  // …and says why, rather than just "out of date".
  assert.match(p.get("v")?.error ?? "", /2 of 4 files failed/);
  files = { "a.pdf": "A", "b.pdf": "B2", "c.pdf": "C", "d.pdf": "D" };
  const again = await run(graph(), cache);
  assert.equal(again.get("v")?.status, "ok");
  assert.equal(batchOf(again.get("v")).length, 4);
});

test("an empty folder leaves the nodes after it waiting", async () => {
  files = {};
  const r = await run(graph(), new ResultCache());
  assert.equal(r.get("f")?.status, "waiting");
  assert.equal(r.get("v")?.status, "waiting");
});

test("a node after two folders says it can't", async () => {
  files = { "a.pdf": "A" };
  const g: Graph = {
    version: 1,
    nodes: [node("f", "folder"), node("g", "folder"), node("s", "stamp"), node("p", "pack"), node("v", "save")],
    edges: [edge("f", "docs", "s", "doc"), edge("g", "docs", "s", "text"), edge("s", "doc", "p", "doc"), edge("p", "file", "v", "file")],
  };
  const r = await run(g, new ResultCache());
  assert.equal(r.get("s")?.status, "error");
  assert.equal(r.get("v")?.status, "error");
});

test("cancelling stops before the next file and sends no files", async () => {
  files = { "a.pdf": "A", "b.pdf": "B", "c.pdf": "C" };
  const ac = new AbortController();
  runs = [];
  const r = await evaluate(graph(), {
    registry,
    cache: new ResultCache(),
    ctx: { ...render, signal: ac.signal },
    onNode: (id) => id === "p" && ac.abort(),
  });
  assert.equal(r.get("v")?.status, "error");
  assert.equal(r.get("v")?.error, "Cancelled");
  assert.deepEqual(r.get("v")?.outputs, {});
  assert.equal(runs.filter((x) => x.startsWith("pack:")).length, 1);
});
