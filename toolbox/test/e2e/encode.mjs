// Encode check: drives the built desktop app (npm run build first) through
// Encode video graphs and reports what ffmpeg wrote and how long it took.
//   node test/e2e/encode.mjs            quick check, 2 s at 320×240
//   node test/e2e/encode.mjs --bench    10 s at 1920×1080
// On Linux run it under xvfb-run. Needs no browser download: it uses the app's Electron.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const bench = process.argv.includes("--bench");
const [W, H, S] = bench ? [1920, 1080, 10] : [320, 240, 2];
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-encode-"));

const clip = path.join(tmp, "clip.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(S), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);

const GAME_BOY = { version: 1, name: "Game Boy", pixelSize: 3, steps: [
  { type: "adjust", enabled: true, params: { contrast: 20, saturation: 0 } },
  { type: "dither", enabled: true, params: { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 } },
] };

/** A chain of nodes: [type, params, input handle, output handle]. */
function graph(chain) {
  const nodes = chain.map(([type, params], i) => ({ id: `n${i}`, type, params, position: { x: 40 + 300 * i, y: 120 } }));
  const edges = chain.slice(1).map((c, i) => ({ id: `e${i}`, source: `n${i}`, sourceHandle: chain[i][3], target: `n${i + 1}`, targetHandle: c[2] }));
  return { version: 1, nodes, edges };
}
const input = ["input.video", {}, null, "video"];
const dither = ["dither.recipe", { recipe: GAME_BOY, size: "source" }, "image", "image"];
const encode = (params) => ["video.encode", { name: "out", ...params }, "video", "file"];
const save = (folder) => ["output.save-file", { folder }, "file", null];

const CASES = [
  { name: "ProRes HQ, dithered frames", chain: [input, dither, encode({ container: "mov", codec: "prores", prores: "hq" })], expect: /prores \(HQ\)/ },
  { name: "ProRes 4444, straight from the file", chain: [input, encode({ container: "mov", codec: "prores", prores: "4444" })], expect: /prores \(4444\)/ },
  { name: "HEVC, dithered frames (VideoToolbox, else WebCodecs, else libx265)", chain: [input, dither, encode({ container: "mp4", codec: "hevc" })], expect: /hevc/ },
  // Only differs from the case above on a Mac; elsewhere there's no hevc_videotoolbox to hide.
  { name: "HEVC, dithered frames, without VideoToolbox", chain: [input, dither, encode({ container: "mp4", codec: "hevc" })], expect: /hevc/, hide: "hevc_videotoolbox" },
  { name: "H.264, dithered frames, WebCodecs", chain: [input, dither, encode({ container: "mp4", codec: "avc" })], expect: /h264/ },
];

async function runCase(c) {
  const out = path.join(tmp, c.name.replace(/\W+/g, "-"));
  mkdirSync(out, { recursive: true });
  const file = path.join(out, "graph.toolbox");
  writeFileSync(file, JSON.stringify(graph([...c.chain, save(out)])));
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, TOOLBOX_HIDE_ENCODERS: c.hide ?? "" },
  });
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
    // Drop the clip on the canvas; it fills the empty Video file node.
    await win.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "clip.mp4", { type: "video/mp4" }));
      const el = document.querySelector(".canvas");
      const r = el.getBoundingClientRect();
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 100, clientY: r.y + 400 }));
    }, readFileSync(clip).toString("base64"));
    await win.waitForTimeout(3000);
    const t0 = Date.now();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
    const written = () => readdirSync(out).filter((f) => f.startsWith("out."));
    for (let i = 0; i < (bench ? 1200 : 160) && !written().length; i++) await win.waitForTimeout(250);
    const ms = Date.now() - t0;
    const [name] = written();
    if (!name) return { ...c, ok: false, error: errors.join(" | ") || "no file written" };
    const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", path.join(out, name)], { encoding: "utf8" }).stderr;
    const streams = probe.split("\n").filter((l) => /Stream #/.test(l)).map((l) => l.trim().replace(/^Stream #\S+ /, ""));
    return { ...c, ok: c.expect.test(probe), ms, mb: statSync(path.join(out, name)).size / 1e6, streams };
  } finally {
    await app.close();
  }
}

console.log(`Clip: ${S} s at ${W}×${H}, 30 fps, with sound\n`);
let ok = true;
for (const c of CASES) {
  const r = await runCase(c);
  ok &&= r.ok || !!c.optional;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name}`);
  if (r.ms !== undefined) console.log(`     ${(r.ms / 1000).toFixed(2)} s, ${r.mb.toFixed(1)} MB`);
  for (const s of r.streams ?? []) console.log(`     ${s}`);
  if (r.error) console.log(`     ${r.error}`);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
