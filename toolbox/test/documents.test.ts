import assert from "node:assert/strict";
import { test } from "node:test";
import { afterClose, closeLoses, DOCS_STORE, fingerprint, loadDocs, nameFromPath, OLD_STORE, uniqueName } from "../src/app/documents.ts";
import type { Graph } from "../src/runtime/types.ts";

const store = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });
let n = 0;
const newId = () => `d${++n}`;
const starter = () => "STARTER";

const graph = (text = "hi", x = 0): Graph => ({
  version: 1,
  nodes: [
    { id: "a", type: "input.text", params: { text }, position: { x, y: 0 } },
    { id: "s", type: "output.save-file", params: { name: "out" }, position: { x: 300, y: 0 } },
  ],
  edges: [{ id: "e", source: "a", sourceHandle: "text", target: "s", targetHandle: "file" }],
});

test("a first launch opens one untouched starter graph", () => {
  const s = loadDocs(store({}), newId, starter);
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].graph, "STARTER");
  assert.equal(s.docs[0].fresh, true);
  assert.equal(s.active, s.docs[0].id);
});

test("the graph an older Toolbox autosaved becomes the first tab", () => {
  const s = loadDocs(store({ [OLD_STORE]: '{"old":true}' }), newId, starter);
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].graph, '{"old":true}');
  assert.equal(s.docs[0].name, "Untitled");
  // It's someone's graph, not a starter: a workflow mustn't replace it.
  assert.equal(s.docs[0].fresh, undefined);
});

test("once tabs are kept, the old autosave is ignored", () => {
  const docs = { active: "b", docs: [{ id: "a", name: "One", graph: "1" }, { id: "b", name: "Two", graph: "2", path: "/x/Two.toolbox", saved: "f" }] };
  const s = loadDocs(store({ [OLD_STORE]: "OLD", [DOCS_STORE]: JSON.stringify(docs) }), newId, starter);
  assert.deepEqual(s, docs);
});

test("a broken or empty store starts over, and a missing active tab falls back to the first", () => {
  assert.equal(loadDocs(store({ [DOCS_STORE]: "{nope" }), newId, starter).docs[0].graph, "STARTER");
  assert.equal(loadDocs(store({ [DOCS_STORE]: '{"docs":[]}', [OLD_STORE]: "OLD" }), newId, starter).docs[0].graph, "OLD");
  const s = loadDocs(store({ [DOCS_STORE]: JSON.stringify({ active: "gone", docs: [{ id: "a", name: "A", graph: "1" }, { id: "a", name: "Dup", graph: "2" }, { id: 3 }] }) }), newId, starter);
  assert.equal(s.active, "a");
  assert.deepEqual(s.docs.map((d) => d.name), ["A"]);
});

test("storage that throws counts as empty", () => {
  const s = loadDocs({ getItem: () => { throw new Error("blocked"); } }, newId, starter);
  assert.equal(s.docs[0].graph, "STARTER");
});

test("the fingerprint changes with settings, wires and positions", () => {
  const base = fingerprint(graph());
  assert.equal(fingerprint(graph()), base);
  assert.notEqual(fingerprint(graph("bye")), base);
  assert.notEqual(fingerprint(graph("hi", 10)), base);
  assert.notEqual(fingerprint({ ...graph(), edges: [] }), base);
});

test("files read back, where Save wrote, and key order don't make a graph look changed", () => {
  const base = fingerprint(graph());
  const g = graph();
  g.nodes[0].params = { assetId: "a123", text: "hi" };
  g.nodes[1].params = { lastSaved: ["/out/out.png"], name: "out" };
  assert.equal(fingerprint(g), base);
});

test("tab names", () => {
  assert.equal(nameFromPath("/Users/me/Graphs/Dither cat.toolbox"), "Dither cat");
  assert.equal(nameFromPath("C:\\graphs\\old.json"), "old");
  assert.equal(nameFromPath("plain"), "plain");
  assert.equal(uniqueName("Untitled", ["Other"]), "Untitled");
  assert.equal(uniqueName("Untitled", ["Untitled", "Untitled 2"]), "Untitled 3");
});

test("closing the tab on screen shows its right neighbour, else its left one", () => {
  assert.equal(afterClose(["a", "b", "c"], "b", "b"), "c");
  assert.equal(afterClose(["a", "b", "c"], "c", "c"), "b");
  assert.equal(afterClose(["a", "b", "c"], "a", "c"), "c");
  assert.equal(afterClose(["a"], "a", "a"), undefined);
});

test("closing asks only when something would be lost", () => {
  assert.equal(closeLoses({ path: "/g.toolbox", changed: false, hasContent: true }), false, "saved file: nothing lost");
  assert.equal(closeLoses({ path: "/g.toolbox", changed: true, hasContent: false }), true, "changes not in the file");
  assert.equal(closeLoses({ changed: false, hasContent: false }), false, "an empty untitled graph");
  assert.equal(closeLoses({ changed: false, hasContent: true }), true, "an untitled graph with files in it");
  assert.equal(closeLoses({ changed: true, hasContent: false }), true, "an untitled graph someone built");
});
