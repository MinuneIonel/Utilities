// Fan-out check: one video through Dither into two Encode video nodes (MP4 and GIF) on one Render.
// Both files must be written, and since the encoders share one pass over the dithered frames
// (decoded and dithered once, not once per encoder), the pair must take well under the time of
// two single renders: under 1.4x the slower encoder rendering alone.
//   node test/e2e/fanout.mjs     (npm run build first; on Linux under xvfb-run)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-fanout-"));
const out = path.join(tmp, "out");
execFileSync("mkdir", ["-p", out]);

const SECONDS = 3;
const clip = path.join(tmp, "clip.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=800x450:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(SECONDS), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);

// Error diffusion at one pixel per dither pixel: the shared work is the expensive part.
const HEAVY = { version: 1, name: "Heavy", pixelSize: 1, steps: [{ type: "dither", enabled: true, params: { algorithm: "jarvis-judice-ninke", palette: "spectra6" } }] };

/** Video file -> Dither -> one Encode video + Save per output name ("name.mp4", "name.gif"). */
function graph(outputs) {
  const nodes = [
    { id: "v", type: "input.video", params: { path: clip, name: "clip.mp4" }, position: { x: 40, y: 160 } },
    { id: "d", type: "dither.recipe", params: { recipe: HEAVY, size: "source" }, position: { x: 340, y: 160 } },
  ];
  const edges = [{ id: "vd", source: "v", sourceHandle: "video", target: "d", targetHandle: "image" }];
  outputs.forEach((file, i) => {
    const [name, container] = file.split(".");
    nodes.push(
      { id: `e${i}`, type: "video.encode", params: { container, quality: "medium", name, fps: container === "gif" ? 15 : 0 }, position: { x: 640, y: 60 + 260 * i } },
      { id: `s${i}`, type: "output.save-file", params: { folder: out }, position: { x: 940, y: 60 + 260 * i } },
    );
    edges.push(
      { id: `de${i}`, source: "d", sourceHandle: "image", target: `e${i}`, targetHandle: "video" },
      { id: `es${i}`, source: `e${i}`, sourceHandle: "file", target: `s${i}`, targetHandle: "file" },
    );
  });
  return { version: 1, nodes, edges };
}

function duration(file) {
  const err = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(err) ?? [];
  return h === undefined ? NaN : +h * 3600 + +m * 60 + +s;
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
const errors = [];
try {
  const win = await app.firstWindow();
  win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForSelector(".canvas");
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1")) {
    await win.evaluate(() => localStorage.setItem("toolbox.tutorial", "1"));
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
  let n = 0;
  /** Opens a graph, renders it, and returns how long until every file it saves is on disk (ms). */
  const render = async (outputs) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(graph(outputs)));
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      // Opening a graph that names files asks first: use them.
      dialog.showMessageBox = async () => ({ response: 0 });
    }, f);
    await menu("open");
    await win.waitForTimeout(2500);
    const t0 = Date.now();
    await menu("render");
    const done = () => outputs.every((o) => readdirSync(out).includes(o));
    while (!done() && Date.now() - t0 < 40_000) await win.waitForTimeout(100);
    const ms = Date.now() - t0;
    await win.waitForTimeout(300);
    return done() ? ms : NaN;
  };

  // The first Render loads the encoders and the dither engine; it isn't timed.
  await render(["warm.mp4"]);
  const mp4 = await render(["solo.mp4"]);
  const gif = await render(["solo.gif"]);
  const both = await render(["both.mp4", "both.gif"]);
  const files = readdirSync(out).sort();
  check("One Render writes both the MP4 and the GIF", files.includes("both.mp4") && files.includes("both.gif"), files.join(", "));
  const d = duration(path.join(out, "both.mp4"));
  check("The MP4 has the whole video", Math.abs(d - SECONDS) < 0.2, `${d} s`);
  const g = duration(path.join(out, "both.gif"));
  check("The GIF has the whole video", Math.abs(g - SECONDS) < 0.3, `${g} s`);
  const single = Math.max(mp4, gif);
  check(
    "Both together take under 1.4x the slower one alone",
    both < 1.4 * single,
    `MP4 alone ${mp4} ms, GIF alone ${gif} ms, both ${both} ms (${(both / single).toFixed(2)}x; without sharing about ${((mp4 + gif) / single).toFixed(2)}x)`,
  );
  const status = await win.evaluate(() => [...document.querySelectorAll(".tnode-status.s-error")].map((e) => e.textContent).join(" | "));
  check("No node shows an error", !status, status);
} finally {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (failed && errors.length) console.log(`     console: ${errors.slice(0, 5).join(" | ")}`);
process.exit(failed ? 1 : 0);
