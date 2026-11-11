import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGraph } from "../src/graph-file.ts";

const defaults = (type: string) => (type === "a" || type === "b" ? { k: 1 } : undefined);
let n = 0;
const fresh = (p: string) => `${p}new${n++}`;
const node = (id: string, type = "a") => ({ id, type, params: {}, position: { x: 0, y: 0 } });
const edge = (id: string, source: string, target: string, targetHandle = "in") => ({ id, source, sourceHandle: "out", target, targetHandle });

test("broken JSON gets a plain message, not the parser's", () => {
  assert.throws(() => checkGraph("{ nope", defaults, fresh), /isn't a Toolbox graph, or it's damaged/);
  assert.throws(() => checkGraph('{"hello":1}', defaults, fresh), /isn't a Toolbox graph/);
});

test("a good file opens untouched, with no notes", () => {
  const r = checkGraph(JSON.stringify({ version: 1, nodes: [node("x"), node("y", "b")], edges: [edge("e1", "x", "y")] }), defaults, fresh);
  assert.deepEqual(r.notes, []);
  assert.equal(r.graph.nodes.length, 2);
  assert.equal(r.graph.edges.length, 1);
  assert.deepEqual(r.graph.nodes[0].params, { k: 1 });
});

test("a loop is broken and reported", () => {
  const r = checkGraph(JSON.stringify({ version: 1, nodes: [node("x"), node("y"), node("z")], edges: [edge("e1", "x", "y"), edge("e2", "y", "z"), edge("e3", "z", "x")] }), defaults, fresh);
  assert.equal(r.graph.edges.length, 2);
  assert.match(r.notes.join(" "), /loop/);
});

test("duplicate ids get a fresh id instead of a node vanishing", () => {
  const r = checkGraph(JSON.stringify({ version: 1, nodes: [node("x"), node("x", "b")], edges: [] }), defaults, fresh);
  assert.equal(r.graph.nodes.length, 2);
  assert.notEqual(r.graph.nodes[0].id, r.graph.nodes[1].id);
  assert.match(r.notes.join(" "), /shared its id/);
});

test("unknown node types and dangling or doubled wires are dropped", () => {
  const r = checkGraph(
    JSON.stringify({ version: 1, nodes: [node("x"), node("y"), node("q", "mystery")], edges: [edge("e1", "x", "q"), edge("e2", "x", "y"), edge("e3", "x", "y")] }),
    defaults,
    fresh,
  );
  assert.equal(r.graph.nodes.length, 2);
  assert.deepEqual(r.graph.edges.map((e) => e.id), ["e3"]);
  assert.match(r.notes.join(" "), /mystery/);
});
