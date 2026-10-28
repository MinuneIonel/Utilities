// Split check: drives the built desktop app (npm run build first) through
// Split into clips and Cut audio graphs and checks what Save wrote.
//   node test/e2e/split.mjs     (on Linux under xvfb-run)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-split-"));

const video = path.join(tmp, "talk.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
const sound = path.join(tmp, "song.mp3");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "libmp3lame", sound]);

const GAME_BOY = { version: 1, name: "Game Boy", pixelSize: 3, steps: [{ type: "dither", enabled: true, params: { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 } }] };

/** A chain of nodes: [type, params, input handle, output handle]. */
function graph(chain) {
  const nodes = chain.map(([type, params], i) => ({ id: `n${i}`, type, params, position: { x: 40 + 300 * i, y: 120 } }));
  const edges = chain.slice(1).map((c, i) => ({ id: `e${i}`, source: `n${i}`, sourceHandle: chain[i][3], target: `n${i + 1}`, targetHandle: c[2] }));
  return { version: 1, nodes, edges };
}
const videoIn = ["input.video", {}, null, "video"];
const audioIn = ["input.audio", {}, null, "audio"];
const save = (folder) => ["output.save-file", { folder }, "file", null];

const CASES = [
  { name: "Video every 1.5 s, cut from the file", file: video, chain: [videoIn, ["media.split", { mode: "every", every: 1.5 }, "video", "clips"]], expect: { "talk-1.mp4": 1.5, "talk-2.mp4": 1.5, "talk-3.mp4": 1 }, streams: 2 },
  { name: "Dithered video in 2 parts, as WebM", file: video, chain: [videoIn, ["dither.recipe", { recipe: GAME_BOY, size: "source" }, "image", "image"], ["media.split", { mode: "count", count: 2, container: "webm", name: "dith" }, "video", "clips"]], expect: { "dith-1.webm": 2, "dith-2.webm": 2 }, streams: 2 },
  { name: "Video parts, trimmed input", file: video, chain: [["input.video", { start: 1 }, null, "video"], ["media.split", { mode: "parts", parts: "0:00.5-1, 2-end" }, "video", "clips"]], expect: { "talk-1.mp4": 0.5, "talk-2.mp4": 1 }, streams: 2 },
  { name: "Sound cut at times", file: sound, chain: [audioIn, ["media.split", { mode: "at", at: "2, 0:04.5" }, "audio", "clips"]], expect: { "song-1.mp3": 2, "song-2.mp3": 2.5, "song-3.mp3": 1.5 }, streams: 1 },
  { name: "Cut audio: take 1-3 s out", file: sound, chain: [audioIn, ["audio.cut", { mode: "remove", start: 1, end: 3 }, "audio", "audio"]], expect: { "song-cut.mp3": 4 }, streams: 1 },
  { name: "Cut audio: keep 2 s to the end, as WAV", file: sound, chain: [audioIn, ["audio.cut", { mode: "keep", start: 2, format: "wav" }, "audio", "audio"]], expect: { "song-part.wav": 4 }, streams: 1 },
];

function probe(file) {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(out) ?? [];
  return { duration: h === undefined ? NaN : +h * 3600 + +m * 60 + +s, streams: out.split("\n").filter((l) => /Stream #/.test(l)).length };
}

async function runCase(c) {
  const out = path.join(tmp, c.name.replace(/\W+/g, "-"));
  mkdirSync(out, { recursive: true });
  const file = path.join(out, "graph.toolbox");
  writeFileSync(file, JSON.stringify(graph([...c.chain, save(out)])));
  const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
    await win.waitForSelector(".canvas");
    await app.evaluate(({ dialog, BrowserWindow }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
    }, file);
    await win.waitForTimeout(1000);
    await win.evaluate(async ([b64, name, type]) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      const el = document.querySelector(".canvas");
      const r = el.getBoundingClientRect();
      for (const t of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 100, clientY: r.y + 400 }));
    }, [readFileSync(c.file).toString("base64"), path.basename(c.file), c.file.endsWith(".mp3") ? "audio/mpeg" : "video/mp4"]);
    await win.waitForTimeout(2000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
    const want = Object.keys(c.expect);
    const written = () => readdirSync(out).filter((f) => want.includes(f));
    for (let i = 0; i < 240 && written().length < want.length; i++) await win.waitForTimeout(250);
    await win.waitForTimeout(500);
    const errText = await win.evaluate(() => [...document.querySelectorAll(".node-error, .error")].map((e) => e.textContent).join(" | "));
    const files = readdirSync(out).filter((f) => f !== "graph.toolbox").sort();
    const problems = [];
    for (const [f, d] of Object.entries(c.expect)) {
      if (!files.includes(f)) { problems.push(`missing ${f}`); continue; }
      const p = probe(path.join(out, f));
      if (!(Math.abs(p.duration - d) < 0.15)) problems.push(`${f} is ${p.duration} s, wanted ${d}`);
      if (p.streams !== c.streams) problems.push(`${f} has ${p.streams} streams`);
    }
    return { ok: !problems.length, files, problems, errors: [errText, ...errors].filter(Boolean) };
  } finally {
    await app.close();
  }
}

let ok = true;
for (const c of CASES) {
  const r = await runCase(c);
  ok &&= r.ok;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name}: ${r.files.join(", ")}`);
  for (const p of r.problems) console.log(`     ${p}`);
  if (!r.ok) for (const e of r.errors) console.log(`     ${e}`);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
