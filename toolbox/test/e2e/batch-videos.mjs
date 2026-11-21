// Batch video encoding (npm run build first; on Linux under xvfb-run). Several videos → Encode
// video → Save: Render encodes each one, named after it, and the cards say which file they're on.
// Cancel part way through a Folder of videos with Only new files keeps the finished files, and
// only those count as done: the rest are still new next time.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-batch-videos-"));
const dir = (...p) => {
  const d = path.join(tmp, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
const picked = dir("picked");
const long = dir("long");
const out = { a: dir("out-a"), b: dir("out-b") };

const ff = (...args) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
const video = (file, n, secs = 1, size = "160x120") =>
  ff("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=${300 + n * 50}:duration=${secs}`, "-vf", `drawbox=x=${n * 10}:y=10:w=20:h=20:color=red:t=fill`, "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-shortest", file);
const names = ["one.webm", "two.webm", "three.webm", "four.webm"];
names.forEach((f, i) => video(path.join(picked, f), i));
// Long enough that Cancel lands part way through.
for (let i = 1; i <= 5; i++) video(path.join(long, `clip${i}.webm`), i, 6, "640x480");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};
const ls = (d) => readdirSync(d).sort();
const node = (id, type, params, x) => ({ id, type, params, position: { x, y: 120 } });
const wire = (source, sourceHandle, target, targetHandle) => ({ id: `${source}-${target}`, source, sourceHandle, target, targetHandle });
const encode = { container: "mp4", codec: "auto", quality: "high", prores: "hq", fps: 0, audio: true, name: "video" };
const chain = (input, save) => ({
  version: 1,
  nodes: [input, node("e", "video.encode", encode, 340), node("s", "output.save-file", { name: "", folder: save, exists: "skip" }, 640)],
  edges: [wire(input.id, input.type === "input.folder" ? "images" : "video", "e", "video"), wire("e", "file", "s", "file")],
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
const busy = () => win.evaluate(() => [...document.querySelectorAll(".topbar button")].some((b) => b.textContent === "Cancel"));
/** Renders; `during` is called while it runs (with the cards' text) until it returns true. */
async function render(during) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
  await win.waitForTimeout(300);
  const seen = new Set();
  let done = false;
  for (let i = 0; i < 1200 && (await busy()); i++) {
    const cards = { f: await card("f"), v: await card("v"), e: await card("e") };
    Object.values(cards).forEach((c) => seen.add(c));
    if (during && !done && (await during(cards))) done = true;
    await win.waitForTimeout(100);
  }
  await win.waitForTimeout(1500);
  return seen;
}

try {
  // ---------------------------------------------------------- Several videos
  const paths = names.map((f) => path.join(picked, f));
  await open(chain(node("v", "input.videos", { assetIds: [], paths, names, name: "4 files", at: 1 }, 40), out.a));
  check("Several videos reads its files back and says how many", await cardSays("v", /4 videos/), await card("v"));
  check("…its card offers to choose several files", await win.evaluate(() => !!document.querySelector('.react-flow__node[data-id="v"] input[type=file][multiple]')));
  const seen = await render();
  check("Render encodes each video as an MP4 named after it", ls(out.a).join() === "four.mp4,one.mp4,three.mp4,two.mp4", ls(out.a).join(", "));
  check("…Encode video's card said which file it was on", [...seen].some((c) => /File [1-4] of 4/.test(c) && /Encod|ffmpeg/.test(c)), [...seen].filter((c) => /File/.test(c)).join(" | "));
  check("…and Save's card counts them", await cardSays("s", /4 files/), await card("s"));

  // ---------------------------------------------------------- Cancel part way, Only new files
  await open(chain(node("f", "input.folder", { folder: long, kind: "videos", pattern: "", subfolders: false, onlyNew: true, at: 1 }, 40), out.b));
  check("A folder of 5 long videos, all new", await cardSays("f", /^5 new of 5/), await card("f"));
  await render(async (c) => {
    if (!/File 3 of 5/.test(c.e)) return false;
    await win.click(".topbar button:has-text('Cancel')");
    return true;
  });
  const made = ls(out.b);
  check("Cancel on the third video keeps the two finished ones", made.join() === "clip1.mp4,clip2.mp4", made.join(", "));
  const said = await win.evaluate(() => document.querySelector(".topbar .message")?.textContent ?? "");
  check("…and says so", /cancelled\. The 2 files finished before it are saved/i.test(said), said);
  check("…the other three are still new", await cardSays("f", /^3 new of 5/), await card("f"));
  await render();
  check("Render again does just those three", ls(out.b).join() === "clip1.mp4,clip2.mp4,clip3.mp4,clip4.mp4,clip5.mp4", ls(out.b).join(", "));
} finally {
  await app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall batch video checks passed");
process.exit(failed ? 1 : 0);
