// Transparency check: drives the built desktop app (npm run build first) with two transparent
// PNGs through Several images → Dither → Save (PNG sequence), GIF, WebM and MP4, then decodes
// what Save wrote with ffmpeg and checks the corners stayed see-through.
//   node test/e2e/alpha.mjs     (on Linux under xvfb-run)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-alpha-"));
const out = path.join(tmp, "out");
mkdirSync(out);

const W = 96;
const H = 64;
const GAME_BOY = { version: 1, name: "Game Boy", pixelSize: 1, steps: [{ type: "dither", enabled: true, params: { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 } }] };

/** Decodes a file's frames to RGBA with ffmpeg; `decoder` forces one (libvpx for VP9 alpha). */
function frames(file, decoder) {
  const raw = execFileSync(ffmpeg, ["-v", "error", ...(decoder ? ["-c:v", decoder] : []), "-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 });
  const n = raw.length / (W * H * 4);
  return Array.from({ length: n }, (_, i) => raw.subarray(i * W * H * 4, (i + 1) * W * H * 4));
}
const at = (f, x, y) => [...f.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
const problems = [];
try {
  // Two frames: a soft disc, then a square, on a fully transparent background that hides white.
  const inputs = await app.evaluate(({ nativeImage }, { dir, W, H }) => {
    const fs = process.mainModule.require("node:fs");
    const files = [];
    for (const [k, shape] of [["a", "disc"], ["b", "square"]]) {
      const bgra = Buffer.alloc(W * H * 4);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const d = Math.hypot(x - W / 2, y - H / 2);
          const a = shape === "disc" ? Math.max(0, Math.min(1, 24 - d)) : Math.abs(x - W / 2) < 20 && Math.abs(y - H / 2) < 20 ? 1 : 0;
          const i = (y * W + x) * 4;
          // Fully transparent pixels keep white under them; the shape is orange.
          bgra.set(a ? [0, 140, 255, Math.round(a * 255)] : [255, 255, 255, 0], i);
        }
      const f = `${dir}/${k}.png`;
      fs.writeFileSync(f, nativeImage.createFromBitmap(bgra, { width: W, height: H }).toPNG());
      files.push(f);
    }
    return files;
  }, { dir: tmp, W, H });

  const nodes = [
    ["input.images", { paths: inputs, names: ["a.png", "b.png"], at: 1 }],
    ["dither.recipe", { recipe: GAME_BOY, size: "source" }],
    ["output.save-file", { name: "frame", folder: out }],
    ["video.encode", { container: "gif", fps: 2, name: "anim" }],
    ["output.save-file", { name: "", folder: out }],
    ["video.encode", { container: "webm", codec: "vp9", quality: "high", fps: 2, audio: false, name: "anim" }],
    ["output.save-file", { name: "", folder: out }],
    ["video.encode", { container: "mp4", codec: "avc", quality: "high", fps: 2, audio: false, name: "anim" }],
    ["output.save-file", { name: "", folder: out }],
  ].map(([type, params], i) => ({ id: `n${i}`, type, params, position: { x: 40 + 300 * i, y: 120 + 120 * (i % 3) } }));
  const edges = [
    [0, "images", 1, "image"], [1, "image", 2, "file"],
    [1, "image", 3, "video"], [3, "file", 4, "file"],
    [1, "image", 5, "video"], [5, "file", 6, "file"],
    [1, "image", 7, "video"], [7, "file", 8, "file"],
  ].map(([s, sh, t, th], i) => ({ id: `e${i}`, source: `n${s}`, sourceHandle: sh, target: `n${t}`, targetHandle: th }));
  const file = path.join(tmp, "graph.toolbox");
  writeFileSync(file, JSON.stringify({ version: 1, nodes, edges }));

  const win = await app.firstWindow();
  const errors = [];
  win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  await win.waitForSelector(".canvas");
  await app.evaluate(({ dialog, BrowserWindow }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    // Opening a graph that names files asks first: use them.
    dialog.showMessageBox = async () => ({ response: 0 });
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
  }, file);
  await win.waitForTimeout(2000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
  const want = ["frame-1.png", "frame-2.png", "anim.gif", "anim.webm", "anim.mp4"];
  const written = () => readdirSync(out).filter((f) => want.includes(f));
  for (let i = 0; i < 240 && written().length < want.length; i++) await win.waitForTimeout(250);
  await win.waitForTimeout(500);
  for (const f of want) if (!written().includes(f)) problems.push(`missing ${f}`);
  if (problems.length) {
    const errText = await win.evaluate(() => [...document.querySelectorAll(".node-error, .error")].map((e) => e.textContent).join(" | "));
    problems.push(...[errText, ...errors].filter(Boolean));
  }

  /** Corners see-through, centre solid, in every frame. */
  const checkAlpha = (name, fs, n) => {
    if (fs.length < n) problems.push(`${name}: ${fs.length} frames, wanted ${n}`);
    fs.forEach((f, i) => {
      const corner = at(f, 2, 2)[3];
      const centre = at(f, W / 2, H / 2)[3];
      if (corner > 8 || centre < 247) problems.push(`${name} frame ${i + 1}: corner alpha ${corner}, centre alpha ${centre}`);
    });
  };
  if (!problems.length) {
    checkAlpha("frame-1.png", frames(path.join(out, "frame-1.png")), 1);
    checkAlpha("frame-2.png", frames(path.join(out, "frame-2.png")), 1);
    checkAlpha("anim.gif", frames(path.join(out, "anim.gif")), 2);
    checkAlpha("anim.webm", frames(path.join(out, "anim.webm"), "libvpx-vp9"), 2);
    // MP4 has no alpha: transparent areas come out black, not the dither pattern hidden under them.
    frames(path.join(out, "anim.mp4")).forEach((f, i) => {
      const [r, g, b] = at(f, 2, 2);
      if (r + g + b > 40) problems.push(`anim.mp4 frame ${i + 1}: corner is ${r},${g},${b}, wanted black`);
    });
  }
} finally {
  await app.close();
}
console.log(problems.length ? `FAIL\n  ${problems.join("\n  ")}` : "ok   PNG sequence, GIF and WebM keep transparency; MP4 turns it black");
rmSync(tmp, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
