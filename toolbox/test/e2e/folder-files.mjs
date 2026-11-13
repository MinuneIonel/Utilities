// Folder of files with whole files (npm run build first; on Linux under xvfb-run). A folder of
// videos, sounds or PDFs: on Render everything after the folder node runs once per file, and Save
// writes one file for each, named after it (one from a sub-folder into the same sub-folder).
// A file that fails doesn't stop the others, and with Only new files it's still new next time.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const { PDFDocument } = require("@cantoo/pdf-lib");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-folder-files-"));
const dir = (...p) => {
  const d = path.join(tmp, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
const videos = dir("clips");
dir("clips", "sub");
const sounds = dir("sounds");
const docs = dir("docs");
const out = { v: dir("out-v"), s: dir("out-s"), d: dir("out-d") };

const ff = (...args) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
const video = (file, n) => ff("-f", "lavfi", "-i", `testsrc2=size=160x120:rate=10:duration=1`, "-vf", `drawbox=x=${n * 10}:y=10:w=20:h=20:color=red:t=fill`, "-c:v", "libvpx", "-b:v", "200k", file);
const sound = (file, hz) => ff("-f", "lavfi", "-i", `sine=frequency=${hz}:duration=1`, file);
video(path.join(videos, "v1.webm"), 1);
video(path.join(videos, "v2.webm"), 2);
video(path.join(videos, "sub", "v3.webm"), 3);
sound(path.join(sounds, "s1.wav"), 440);
sound(path.join(sounds, "s2.wav"), 660);
writeFileSync(path.join(sounds, "broken.mp3"), "this is not a sound at all".repeat(20));
for (const [name, pages] of [["p1.pdf", 1], ["p2.pdf", 3]]) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([300, 400]);
  writeFileSync(path.join(docs, name), await pdf.save());
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};
const ls = (d, prefix = "") =>
  readdirSync(d, { withFileTypes: true })
    .flatMap((x) => (x.isDirectory() ? ls(path.join(d, x.name), `${prefix}${x.name}/`) : [`${prefix}${x.name}`]))
    .sort();

const node = (id, type, params, x) => ({ id, type, params, position: { x, y: 120 } });
const wire = (source, sourceHandle, target, targetHandle) => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle });
/** Folder → one node → Save. */
const graph = (folder, kind, mid, save, extra = {}) => ({
  version: 1,
  nodes: [node("f", "input.folder", { folder, kind, subfolders: true, ...extra }, 40), node("m", mid.type, mid.params, 340), node("s", "output.save-file", { name: "", folder: save, exists: "skip" }, 640)],
  edges: [wire("f", "images", "m", mid.in), wire("m", mid.out, "s", "file")],
});

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, `--user-data-dir=${dir("profile")}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
const win = await app.firstWindow();
await win.waitForSelector(".canvas", { state: "attached" });
await win.evaluate(() => {
  localStorage.setItem("toolbox.tutorial", "1");
  localStorage.setItem("toolbox.mode", "graph");
});
await win.reload();
await win.waitForSelector(".canvas");
const card = (id) => win.evaluate((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .tnode-status`)?.textContent ?? "", id);
const cardSays = async (id, re, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    if (re.test(await card(id))) return true;
    await win.waitForTimeout(250);
  }
  return false;
};
let n = 0;
async function open(g) {
  const f = path.join(tmp, `g${n++}.toolbox`);
  writeFileSync(f, JSON.stringify(g));
  await app.evaluate(({ dialog, BrowserWindow }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    dialog.showMessageBox = async () => ({ response: 0 });
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
  }, f);
  await win.waitForTimeout(2500);
}
/** Renders and waits until it's done (the Render button is back). */
async function render() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
  await win.waitForTimeout(500);
  for (let i = 0; i < 240; i++) {
    if (!(await win.evaluate(() => !!document.querySelector(".topbar .stop, .topbar button.cancel") || /Cancel|Stop/.test(document.querySelector(".topbar")?.textContent ?? "")))) break;
    await win.waitForTimeout(250);
  }
  await win.waitForTimeout(1500);
  return win.evaluate(() => document.querySelector(".topbar .message")?.textContent ?? "");
}

try {
  // ---------------------------------------------------------- videos
  await open(graph(videos, "videos", { type: "video.encode", params: { container: "mp4", codec: "auto", quality: "high", fps: 0, audio: true, name: "video" }, in: "video", out: "file" }, out.v));
  check("A folder of videos says what's in it", await cardSays("f", /^3 videos in clips/), await card("f"));
  check("…its port says Videos", (await win.textContent('.react-flow__node[data-id="f"] .port.out')).includes("Videos"));
  await render();
  check("Render encodes each video, named after it, the sub-folder's into the same sub-folder", ls(out.v).join() === "sub/v3.mp4,v1.mp4,v2.mp4", ls(out.v).join(", "));
  check("…and Save's card counts them", await cardSays("s", /3 files/), await card("s"));

  // ---------------------------------------------------------- sounds, one broken, Only new files
  await open(graph(sounds, "sounds", { type: "audio.convert", params: { format: "mp3" }, in: "audio", out: "audio" }, out.s, { onlyNew: true }));
  check("A folder of sounds, Only new files: all new at first", await cardSays("f", /^3 new of 3 in sounds/), await card("f"));
  await render();
  check("Render converts the good ones, though one is broken", ls(out.s).join() === "s1.mp3,s2.mp3", ls(out.s).join(", "));
  check("…and Save's card says which one failed", await cardSays("s", /broken\.mp3/), await card("s"));
  check("…which is still new next time", await cardSays("f", /^1 new of 3 in sounds/), await card("f"));

  // ---------------------------------------------------------- PDFs
  await open(graph(docs, "pdfs", { type: "pdf.stamp", params: { watermark: "COPY", size: 40, opacity: 30, numbers: true, format: "{n} / {total}", position: "bottom-center" }, in: "document", out: "document" }, out.d));
  check("A folder of PDFs says what's in it", await cardSays("f", /^2 PDFs in docs/), await card("f"));
  check("…and the node after it previews the first one", await cardSays("m", /1 page/), await card("m"));
  await render();
  check("Render stamps each PDF", ls(out.d).join() === "p1.pdf,p2.pdf", ls(out.d).join(", "));
  const pages = await Promise.all(["p1.pdf", "p2.pdf"].map(async (f) => (await PDFDocument.load(require("node:fs").readFileSync(path.join(out.d, f)))).getPageCount()));
  check("…each keeping its own pages", pages.join() === "1,3", pages.join());
} finally {
  await app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall folder-of-files checks passed");
process.exit(failed ? 1 : 0);
