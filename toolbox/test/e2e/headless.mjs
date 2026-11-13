// Run-without-the-window check (npm run build first; on Linux under xvfb-run): Toolbox --run runs a
// saved graph and exits. Files are written where the Save nodes say (or --out), --input and --set
// change the graph for that run, a folder feeds Several images, a second run replaces its own file,
// and the files it was given aren't remembered afterwards. Exit codes: 0 when it worked, 1 when a
// node failed (named in the message), 2 for bad arguments or graph files. A run beside an open
// Toolbox isn't swallowed by it and doesn't open the graph in a tab, and the graph still opens there.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const electron = require("electron");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-headless-"));
const profile = path.join(tmp, "profile");
const linux = process.platform === "linux" ? ["--no-sandbox"] : [];

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

// Fixtures: one picture, and a folder of three.
const pic = path.join(tmp, "pic.png");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120", "-frames:v", "1", pic]);
const photos = path.join(tmp, "photos");
mkdirSync(photos);
for (const n of [1, 2, 3]) execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${100 + n * 20}x80`, "-frames:v", "1", path.join(photos, `photo${n}.png`)]);
writeFileSync(path.join(photos, "notes.txt"), "not an image");

const dir = (name) => path.join(tmp, name);
const ls = (d) => (existsSync(d) ? readdirSync(d).sort() : []);
const pngWidth = (f) => readFileSync(f).readUInt32BE(16);
let n = 0;
const graphFile = (g) => {
  const f = path.join(tmp, `g${n++}.toolbox`);
  writeFileSync(f, typeof g === "string" ? g : JSON.stringify(g));
  return f;
};
const node = (id, type, params = {}, x = 0) => ({ id, type, params, position: { x, y: 120 } });
const edge = (source, sourceHandle, target, targetHandle) => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle });

/** Runs Toolbox --run with these arguments; resolves with the exit code and what it printed. */
function run(...args) {
  const r = spawnSync(electron, [appDir, ...linux, `--user-data-dir=${profile}`, "--run", ...args], { encoding: "utf8", timeout: 120_000 });
  // Chromium's own log lines go to stderr too; the run's messages are the lines without its [pid:…] prefix.
  const err = r.stderr.split("\n").filter((l) => l && !/^\[\d+:\d+\//.test(l)).join("\n");
  return { code: r.status, out: r.stdout, err };
}
const show = (r) => `exit ${r.code}; out: ${r.out.trim().replace(/\n/g, " | ")}; err: ${r.err.trim().replace(/\n/g, " | ")}`;

const qrGraph = (save = {}) => ({
  version: 1,
  nodes: [node("q", "input.qr", { text: "hello", size: 200 }), node("s", "output.save-file", { name: "qr", ...save }, 300)],
  edges: [edge("q", "image", "s", "file")],
});
const ditherGraph = (file = {}, save = {}) => ({
  version: 1,
  nodes: [node("i", "input.file", file), node("d", "dither.recipe", {}, 300), node("s", "output.save-file", { name: "dithered", ...save }, 600)],
  edges: [edge("i", "image", "d", "image"), edge("d", "image", "s", "file")],
});

try {
  // QR -> Save, into --out.
  const qr = graphFile(qrGraph());
  const outQr = dir("out-qr");
  let r = run(qr, "--out", outQr);
  check("QR -> Save writes its file and exits 0", r.code === 0 && ls(outQr).join() === "qr.png", show(r));
  check("…printing progress and where the file went", /\[QR code\]/.test(r.out) && r.out.includes(`Saved ${path.join(outQr, "qr.png")}`), r.out);
  r = run(qr, "--out", outQr, "--set", "QR code.text=again", "--quiet");
  check("A second run replaces its own file instead of adding a copy", r.code === 0 && ls(outQr).join() === "qr.png", show(r));
  check("--quiet prints only the saved files", !/\[QR code\]/.test(r.out) && /Saved /.test(r.out), r.out);

  // Image -> Dither -> Save, with --input and --set; the Save node has its own folder.
  const outD = dir("out-dither");
  const dg = graphFile(ditherGraph({}, { folder: outD }));
  r = run(dg, "--input", `Image file=${pic}`);
  const full = ls(outD).includes("dithered.png") ? pngWidth(path.join(outD, "dithered.png")) : 0;
  check("Image -> Dither -> Save with --input writes into the Save node's folder", r.code === 0 && full === 160, `${show(r)}; width ${full}`);
  r = run(dg, "--input", `Image file=${pic}`, "--set", "Dither.size=pixels", "--set", "s.name=small");
  const small = ls(outD).includes("small.png") ? pngWidth(path.join(outD, "small.png")) : 0;
  check("--set changes settings, naming nodes by title or id", r.code === 0 && small > 0 && small < 160, `${show(r)}; width ${small}`);
  const allowed = existsSync(path.join(profile, "allowed-files.json")) ? readFileSync(path.join(profile, "allowed-files.json"), "utf8") : "[]";
  check("Files given to a run are allowed for that run only", !allowed.includes("pic.png"), allowed);

  // A file the graph itself names is read without asking: the person chose to run that graph.
  const outNamed = dir("out-named");
  r = run(graphFile(ditherGraph({ path: pic, name: "pic.png" })), "--out", outNamed);
  check("A file the graph names is read in a run", r.code === 0 && ls(outNamed).join() === "dithered.png", show(r));

  // Several images from a folder -> Encode image -> Save: one file per image (the compress workflow).
  const outPhotos = dir("out-photos");
  const compress = graphFile({
    version: 1,
    nodes: [node("i", "input.images"), node("e", "media.encode", { format: "jpeg", quality: 80, maxKB: 500 }, 300), node("s", "output.save-file", {}, 600)],
    edges: [edge("i", "images", "e", "image"), edge("e", "file", "s", "file")],
  });
  r = run(compress, "--input", `Several images=${photos}`, "--out", outPhotos);
  check("A folder feeds Several images, and each image is saved", r.code === 0 && ls(outPhotos).join() === "photo1.jpg,photo2.jpg,photo3.jpg", `${show(r)}; ${ls(outPhotos).join()}`);

  // Exit code 1: a node failed, and the message names it.
  r = run(graphFile(ditherGraph()), "--out", dir("out-missing"));
  check("A graph with a missing input exits 1, naming the node", r.code === 1 && /Image file/.test(r.err), show(r));
  r = run(graphFile(ditherGraph({ path: path.join(tmp, "gone.png"), name: "gone.png" })), "--out", dir("out-gone"));
  check("A file the graph names that's gone exits 1, naming the node", r.code === 1 && /Image file: can't read/.test(r.err), show(r));
  const cam = graphFile({ version: 1, nodes: [node("w", "input.webcam"), node("s", "output.save-file", {}, 300)], edges: [edge("w", "video", "s", "file")] });
  r = run(cam, "--out", dir("out-cam"));
  check("A webcam graph exits 1 with a plain message", r.code === 1 && r.err.includes("A webcam graph needs the window"), show(r));

  // Exit code 2: bad arguments or graph files.
  const bad = [
    ["an unknown option", [qr, "--frobnicate"]],
    ["no graph", []],
    ["a graph that isn't there", [path.join(tmp, "nope.toolbox"), "--out", outQr]],
    ["a damaged graph", [graphFile("{ nope"), "--out", outQr]],
    ["a node that isn't in the graph", [qr, "--out", outQr, "--set", "Dither.size=pixels"]],
    ["a setting the node doesn't have", [qr, "--out", outQr, "--set", "QR code.colour=red"]],
    ["an input file that isn't there", [dg, "--input", `Image file=${path.join(tmp, "nope.png")}`]],
    ["a folder for a one-file input", [dg, "--input", `Image file=${photos}`]],
    ["a Save node with no folder and no --out", [qr]],
  ];
  for (const [what, args] of bad) {
    r = run(...args);
    check(`Bad arguments exit 2: ${what}`, r.code === 2 && r.err.trim().length > 0, show(r));
  }

  // Beside an open Toolbox: the run isn't handed to it, and the graph opens there as usual.
  const app = await _electron.launch({ executablePath: electron, args: [appDir, `--user-data-dir=${profile}`, ...linux] });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector(".canvas", { state: "attached" });
    await win.evaluate(() => {
      localStorage.setItem("toolbox.tutorial", "1");
      localStorage.setItem("toolbox.mode", "graph");
    });
    await win.reload();
    await win.waitForSelector(".canvas");
    const tabs = () => win.$$eval(".tabstrip .tab .tab-name", (els) => els.map((e) => e.textContent ?? ""));
    const before = await tabs();
    const outBeside = dir("out-beside");
    r = run(qr, "--out", outBeside);
    check("A run beside an open Toolbox runs on its own", r.code === 0 && ls(outBeside).join() === "qr.png", show(r));
    await win.waitForTimeout(1000);
    check("…and the open Toolbox doesn't open the graph", JSON.stringify(await tabs()) === JSON.stringify(before), `${before.join()} → ${(await tabs()).join()}`);
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      dialog.showMessageBox = async () => ({ response: 0 });
    }, qr);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "open"));
    await win.waitForTimeout(1500);
    const shown = await win.$$eval(".react-flow__node", (els) => els.map((e) => e.getAttribute("data-id")).sort().join());
    check("The same graph still opens in the app", (await tabs()).includes(path.basename(qr, ".toolbox")) && shown === "q,s", `${(await tabs()).join()}; nodes ${shown}`);
  } finally {
    await app.close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL ${e.stack ?? e}`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll headless checks passed");
process.exit(failed ? 1 : 0);
