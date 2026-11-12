import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRecent, graphPathsIn, recentLabel } from "../electron/graph-files.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-recent-"));
const abs = (name: string) => path.join(tmp, name);

test("the recent list keeps the newest first, once each, and only so many", () => {
  const r = createRecent(null, 3);
  for (const n of ["a", "b", "c", "b", "d"]) r.add(abs(`${n}.toolbox`));
  assert.deepEqual(r.list(), [abs("d.toolbox"), abs("b.toolbox"), abs("c.toolbox")]);
  r.remove(abs("b.toolbox"));
  assert.deepEqual(r.list(), [abs("d.toolbox"), abs("c.toolbox")]);
  r.add("relative.toolbox");
  assert.equal(r.list().length, 2, "relative paths are ignored");
  r.clear();
  assert.deepEqual(r.list(), []);
});

test("the recent list is kept across launches, and a broken file starts it empty", () => {
  const file = abs("recent.json");
  createRecent(file).add(abs("kept.toolbox"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [abs("kept.toolbox")]);
  assert.deepEqual(createRecent(file).list(), [abs("kept.toolbox")]);
  writeFileSync(file, "{nope");
  assert.deepEqual(createRecent(file).list(), []);
});

test("graph files on a command line", () => {
  const cwd = abs("here");
  // An absolute path made here, so on Windows it has the same drive as `cwd` ("/abs/x" would take cwd's drive).
  const other = abs("Other.TOOLBOX");
  const argv = ["/opt/Toolbox/toolbox", ".", "--user-data-dir=/x/y.toolbox", "graph.toolbox", other, "photo.png"];
  assert.deepEqual(graphPathsIn(argv, cwd), [path.join(cwd, "graph.toolbox"), other]);
});

test("recent menu labels", () => {
  const home = abs("home");
  assert.equal(recentLabel(path.join(home, "Graphs", "cats.toolbox"), home), `cats.toolbox — ~${path.sep}Graphs`);
  assert.equal(recentLabel(path.join(tmp, "R&D.toolbox")), `R&&D.toolbox — ${tmp}`);
});
