import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandLinePaths, createRunSaves, findInputs, imagesIn, isRun, parseRunArgs, parseValue, runAllowList } from "../electron/cli.js";
import { graphPathsIn } from "../electron/graph-files.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-cli-"));
const cwd = path.join(tmp, "here");
const home = path.join(tmp, "home");
const parse = (...args: string[]) => parseRunArgs(["/opt/Toolbox/toolbox", ...args], cwd, home);

test("a --run line is told apart from opening a file", () => {
  assert.ok(isRun(["toolbox", "--run", "g.toolbox"]));
  assert.ok(isRun(["toolbox", "--run=g.toolbox"]));
  assert.ok(!isRun(["toolbox", "g.toolbox"]));
  // The graph to run is never also opened in a tab of a running Toolbox.
  assert.deepEqual(graphPathsIn(["toolbox", "--run", "g.toolbox", "--input", "x=other.toolbox"], cwd), []);
  assert.deepEqual(graphPathsIn(["toolbox", "--run=g.toolbox"], cwd), []);
});

test("the graph, settings, inputs and out folder", () => {
  const r = parse("--run", "g.toolbox", "--set", "Dither.size=4", "--set=n1.mode=\"bayer\"", "--input", "Image file=photos/a b.png", "--out", "~/out", "--quiet");
  assert.deepEqual(r, {
    graph: path.join(cwd, "g.toolbox"),
    sets: [
      { node: "Dither", param: "size", value: 4 },
      { node: "n1", param: "mode", value: "bayer" },
    ],
    inputs: [{ node: "Image file", path: path.join(cwd, "photos/a b.png") }],
    out: path.join(home, "out"),
    quiet: true,
  });
});

test("values are JSON when they read as JSON, text otherwise", () => {
  assert.equal(parseValue("4"), 4);
  assert.equal(parseValue("true"), true);
  assert.deepEqual(parseValue("[1,2]"), [1, 2]);
  assert.equal(parseValue("pixels"), "pixels");
  assert.equal(parseValue("a=b"), "a=b");
  assert.equal(parseValue(""), "");
  const r = parse("--run", "g.toolbox", "--set", "QR code.text=https://x.org/?a=1&b=2");
  assert.ok(!("error" in r));
  assert.deepEqual((r as { sets: unknown[] }).sets, [{ node: "QR code", param: "text", value: "https://x.org/?a=1&b=2" }]);
});

test("repeated flags add up; a title may have dots; Electron's own switches are left alone", () => {
  const r = parse("--no-sandbox", "--run", "g.toolbox", "--user-data-dir=/tmp/p", "--input", "imgs=a.png", "--input", "imgs=b.png", "--set", "v1.2.name=x");
  assert.ok(!("error" in r));
  const run = r as { inputs: { node: string; path: string }[]; sets: { node: string; param: string }[] };
  assert.deepEqual(run.inputs.map((i) => i.path), [path.join(cwd, "a.png"), path.join(cwd, "b.png")]);
  assert.deepEqual(run.sets[0], { node: "v1.2", param: "name", value: "x" });
});

test("bad arguments are errors (the app exits with code 2)", () => {
  const bad: string[][] = [
    ["--run"],
    ["--run", "g.toolbox", "--set"],
    ["--run", "g.toolbox", "--set", "nodot=4"],
    ["--run", "g.toolbox", "--set", "Dither.size"],
    ["--run", "g.toolbox", "--set", "Dither.=4"],
    ["--run", "g.toolbox", "--input", "nofile"],
    ["--run", "g.toolbox", "--input", "=a.png"],
    ["--run", "g.toolbox", "--out"],
    ["--run", "g.toolbox", "--out", "a", "--out", "b"],
    ["--run", "g.toolbox", "--frobnicate"],
    ["--run", "a.toolbox", "b.toolbox"],
  ];
  for (const args of bad) assert.ok("error" in parse(...args), args.join(" "));
  assert.ok("error" in parseRunArgs(["toolbox", "g.toolbox"], cwd));
});

test("folders give their images in name order; missing files are errors", () => {
  const dir = path.join(tmp, "in");
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  for (const n of ["img10.png", "img2.JPG", "notes.txt", ".hidden.png", "img1.webp"]) writeFileSync(path.join(dir, n), "x");
  assert.deepEqual(imagesIn(dir).map((p) => path.basename(p)), ["img1.webp", "img2.JPG", "img10.png"]);
  const file = path.join(dir, "img2.JPG");
  const r = findInputs([{ node: "a", path: dir }, { node: "b", path: file }]);
  assert.ok("inputs" in r);
  const inputs = (r as { inputs: { dir: boolean; files: string[] }[] }).inputs;
  assert.deepEqual(inputs.map((i) => i.dir), [true, false]);
  assert.deepEqual(inputs[1].files, [file]);
  assert.match((findInputs([{ node: "Image file", path: path.join(dir, "gone.png") }]) as { error: string }).error, /Image file: can't find/);
});

test("a run may read what its command line names, and nothing else", () => {
  const dir = path.join(tmp, "in");
  const run = { sets: [{ node: "f", param: "path", value: "/abs/x.png" }, { node: "f", param: "size", value: "/not/a/path" }], inputs: [] };
  const paths = commandLinePaths(run, [{ node: "i", path: dir, dir: true, files: [path.join(dir, "img1.webp")] }]);
  assert.ok(paths.includes(dir) && paths.includes(path.join(dir, "img1.webp")) && paths.includes("/abs/x.png"));
  assert.ok(!paths.includes("/not/a/path"));
  const ok = runAllowList([path.join(tmp, "one.png")], [dir]);
  assert.ok(ok(path.join(tmp, "one.png")));
  assert.ok(ok(path.join(dir, "deep", "x.png")));
  assert.ok(!ok(path.join(tmp, "two.png")));
  assert.ok(!ok(`${dir}-other/x.png`));
  assert.ok(!ok("relative.png"));
});

test("what each Save node wrote is kept per graph, across runs", () => {
  const file = path.join(tmp, "run-saves.json");
  const g = path.join(tmp, "g.toolbox");
  const s = createRunSaves(file);
  assert.deepEqual(s.get(g), {});
  s.set(g, { s1: ["/out/a.png"], s2: ["/out/b.png"] });
  s.set(g, { s1: ["/out/a2.png"], s2: [] });
  assert.deepEqual(createRunSaves(file).get(g), { s1: ["/out/a2.png"], s2: ["/out/b.png"] }, "a node that wrote nothing keeps what it had");
  assert.deepEqual(createRunSaves(file).get(path.join(tmp, "other.toolbox")), {});
  const capped = createRunSaves(null, 2);
  for (const n of ["a", "b", "c"]) capped.set(`/g/${n}.toolbox`, { s: [`/o/${n}`] });
  assert.deepEqual(capped.get("/g/a.toolbox"), {}, "the oldest graph goes first");
  assert.deepEqual(capped.get("/g/c.toolbox"), { s: ["/o/c"] });
  writeFileSync(file, "{nope");
  assert.deepEqual(createRunSaves(file).get(g), {});
});
