import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { consentText, pathsInGraph } from "../electron/local-files.js";

const abs = (...p: string[]) => path.resolve("/", ...p);

test("collects every file a graph names, once each", () => {
  const g = {
    nodes: [
      { params: { path: abs("a.png") } },
      { params: { paths: [abs("b.png"), abs("a.png"), 7, ""] } },
      { params: { path: "relative.png", text: abs("not-a-path-param") } },
      { params: null },
      {},
    ],
  };
  assert.deepEqual(pathsInGraph(JSON.stringify(g)), [abs("a.png"), abs("b.png")]);
});

test("bad JSON or an odd shape names no files", () => {
  assert.deepEqual(pathsInGraph("{nope"), []);
  assert.deepEqual(pathsInGraph("null"), []);
  assert.deepEqual(pathsInGraph(JSON.stringify({ nodes: "x" })), []);
});

test("the question lists at most 8 files and counts the rest", () => {
  const paths = Array.from({ length: 11 }, (_, i) => abs(`f${i}.png`));
  const t = consentText(paths);
  assert.equal(t.message, "This graph uses 11 files on this computer");
  assert.equal(t.detail.split("\n").filter((l: string) => l.endsWith(".png")).length, 8);
  assert.match(t.detail, /and 3 more/);
  assert.equal(consentText([abs("one.png")]).message, "This graph uses a file on this computer");
});
