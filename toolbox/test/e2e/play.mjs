// Playback check: Video file -> Dither with the eye on Dither. Play must draw at least 10 different
// frames within 2 s; Pause must stop the frames and move the video's playhead to where it stopped;
// a Dither slider changed while playing must have the picture moving again within half a second;
// an Audio file's card plays its sound. Also reports how fast a 1080p clip plays through Dither.
//   node test/e2e/play.mjs     (npm run build first; on Linux under xvfb-run)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-play-"));
const userData = path.join(tmp, "user");

// A keyframe every second, like most camera and phone clips are close to.
const clip = path.join(tmp, "clip.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=800x450:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
const big = path.join(tmp, "big.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "6", "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-pix_fmt", "yuv420p", big]);
const sound = path.join(tmp, "tone.wav");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "4", "-c:a", "pcm_s16le", sound]);

/** Video file -> Dither (its default look). */
const videoGraph = (file) => ({
  version: 1,
  nodes: [
    { id: "v", type: "input.video", params: { path: file, name: path.basename(file), at: 10 }, position: { x: 40, y: 160 } },
    { id: "d", type: "dither.recipe", params: { size: "source" }, position: { x: 360, y: 160 } },
  ],
  edges: [{ id: "vd", source: "v", sourceHandle: "video", target: "d", targetHandle: "image" }],
});
const soundGraph = {
  version: 1,
  nodes: [{ id: "a", type: "input.audio", params: { path: sound, name: "tone.wav" }, position: { x: 120, y: 160 } }],
  edges: [],
};

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
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
  let n = 0;
  const open = async (graph) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(graph));
    await app.evaluate(({ dialog, BrowserWindow }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      // Opening a graph that names files asks first: use them.
      dialog.showMessageBox = async () => ({ response: 0 });
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
    }, f);
  };
  /** How many frames the player has drawn, and the time of the last one. */
  const drawn = () => win.evaluate(() => {
    const c = document.querySelector(".play-frame");
    return { frames: Number(c?.dataset.frames ?? 0), t: Number(c?.dataset.t ?? 0) };
  });
  /** Hashes of the player's picture (shrunk to 64 × 36), sampled every 20 ms for `ms`. */
  const distinctFrames = (ms) =>
    win.evaluate(async (ms) => {
      const c = document.querySelector(".play-frame");
      const small = new OffscreenCanvas(64, 36);
      const g = small.getContext("2d", { willReadFrequently: true });
      const seen = new Set();
      const end = performance.now() + ms;
      while (performance.now() < end) {
        if (c && c.width) {
          g.drawImage(c, 0, 0, 64, 36);
          const d = g.getImageData(0, 0, 64, 36).data;
          let h = 0x811c9dc5;
          for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
          seen.add(h >>> 0);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return seen.size;
    }, ms);
  const playhead = () => win.locator(".player input[type=range]").evaluate((i) => Number(i.value));

  // --- Video -> Dither, the eye on Dither
  await open(videoGraph(clip));
  await win.waitForSelector('.react-flow__node[data-id="d"] .tnode-thumb:not([hidden])', { timeout: 20_000 });
  await win.click('.react-flow__node[data-id="d"] .preview-toggle');
  await win.waitForSelector(".backdrop .backdrop-img:not([hidden])");
  await win.waitForSelector(".player .play-toggle");
  const before = await playhead();
  check("The playhead starts where the graph file put it", before === 10, `at ${before}`);

  await win.click(".player .play-toggle");
  await win.waitForFunction(() => Number(document.querySelector(".play-frame")?.dataset.frames ?? 0) > 0, null, { timeout: 10_000 });
  const t0 = (await drawn()).t;
  check("Playback starts at the playhead", Math.abs(t0 - 0.6) < 0.25, `first frame at ${t0.toFixed(2)} s, playhead at 10% of 6 s`);
  const distinct = await distinctFrames(2000);
  check("Play draws at least 10 different frames within 2 s", distinct >= 10, `${distinct} different pictures`);
  const note = await win.locator(".play-note").allTextContents();
  console.log(`     speed: ${note.length ? note.join(" ") : "real time"}`);
  // The sound against the picture: where the sound is, against where the last frame drawn says it should be by now.
  const drift = await win.evaluate(async () => {
    const c = document.querySelector(".play-frame");
    const out = [];
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const a = document.querySelector("audio.play-audio");
      if (!a || a.paused || document.querySelector(".play-note")) continue;
      out.push(a.currentTime - (Number(c.dataset.t) + (performance.now() - Number(c.dataset.drawn)) / 1000));
    }
    return out.map((x) => Math.abs(x)).sort((x, y) => x - y);
  });
  const mid = drift[Math.floor(drift.length / 2)] ?? NaN;
  check("The sound stays within about a tenth of a second of the picture", drift.length >= 20 && mid <= 0.1, `${drift.length} samples, median ${(mid * 1000).toFixed(0)} ms, worst ${((drift.at(-1) ?? NaN) * 1000).toFixed(0)} ms`);

  // Pause: frames stop, and the playhead moves to where playback stopped.
  await win.click(".player .play-toggle");
  const atPause = await drawn();
  await win.waitForTimeout(250);
  const settled = await drawn();
  await win.waitForTimeout(700);
  const later = await drawn();
  check("Pause stops the frames", later.frames === settled.frames && settled.frames - atPause.frames <= 2, `${atPause.frames} → ${settled.frames} → ${later.frames}`);
  const after = await playhead();
  const want = (settled.t / 6) * 100;
  check("Pause moves the playhead to where playback stopped", after !== before && Math.abs(after - want) < 3, `at ${after}, last frame at ${settled.t.toFixed(2)} s (${want.toFixed(1)}%)`);
  check("The button says Play again", (await win.locator(".player .play-toggle").getAttribute("aria-label")) === "Play");

  // A Dither slider changed while playing: the picture moves again within half a second.
  await win.click('.react-flow__node[data-id="d"] .tnode-title');
  await win.waitForSelector(".dither-panel");
  await win.click(".player .play-toggle");
  await win.waitForFunction((n) => Number(document.querySelector(".play-frame")?.dataset.frames ?? 0) > n + 5, settled.frames, { timeout: 10_000 });
  const slider = win.locator(".dither-panel .field:has(> label:text-is('Pixel size')) input[type=range]");
  const restarts = [];
  for (const px of [4, 6, 3]) {
    // Timed in the page: from the change to the next frame drawn.
    const changed = await win.evaluate(() => ({ at: performance.now(), frames: Number(document.querySelector(".play-frame")?.dataset.frames ?? 0) }));
    await slider.fill(String(px));
    const ms = await win.evaluate(async (from) => {
      const c = document.querySelector(".play-frame");
      while (Number(c?.dataset.frames ?? 0) <= from.frames + 1 && performance.now() - from.at < 5000) await new Promise((r) => setTimeout(r, 5));
      return performance.now() - from.at;
    }, changed);
    restarts.push(Math.round(ms));
    await win.waitForTimeout(800);
  }
  const best = Math.min(...restarts);
  const median = [...restarts].sort((a, b) => a - b)[1];
  check("A slider change while playing has the picture moving again within half a second", median <= 500, `${restarts.join(", ")} ms (median ${median}, best ${best})`);
  check("It is still playing", (await win.locator(".player .play-toggle").getAttribute("aria-label")) === "Pause");
  // Space pauses and plays, away from text fields.
  await win.click(".react-flow__pane", { position: { x: 30, y: 30 } });
  await win.keyboard.press("Space");
  await win.waitForTimeout(300);
  const spacePaused = (await win.locator(".player .play-toggle").getAttribute("aria-label")) === "Play";
  await win.keyboard.press("Space");
  await win.waitForTimeout(300);
  const spacePlays = (await win.locator(".player .play-toggle").getAttribute("aria-label")) === "Pause";
  check("Space pauses and plays", spacePaused && spacePlays);
  await win.click(".player .play-toggle");

  // --- How fast a 1080p clip plays through Dither here (reported; it slows down honestly when it can't keep up).
  await open(videoGraph(big));
  await win.waitForFunction(() => document.querySelector(".backdrop-label")?.textContent?.includes("Dither"), null, { timeout: 20_000 });
  await win.waitForSelector('.react-flow__node[data-id="d"] .tnode-thumb:not([hidden])', { timeout: 20_000 });
  await win.waitForTimeout(500);
  await win.click(".player .play-toggle");
  await win.waitForFunction(() => Number(document.querySelector(".play-frame")?.dataset.frames ?? 0) > 2, null, { timeout: 10_000 });
  // Time to settle on a speed, then 3 s of playing, sampling the speed shown (the clip loops every 6 s).
  await win.waitForTimeout(1500);
  const m = await win.evaluate(async () => {
    const c = document.querySelector(".play-frame");
    const speed = () => Number(/([\d.]+)× speed/.exec(document.querySelector(".play-note")?.textContent ?? "")?.[1] ?? 1);
    const read = () => ({ frames: Number(c.dataset.frames), t: Number(c.dataset.t) });
    const a = read();
    const t0 = performance.now();
    let sum = 0;
    let n = 0;
    let advanced = 0;
    let last = a.t;
    while (performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 25));
      sum += speed();
      n++;
      const t = read().t;
      advanced += t >= last ? t - last : t + 6 - last;
      last = t;
    }
    return { frames: read().frames - a.frames, secs: (performance.now() - t0) / 1000, advanced, speed: sum / n };
  });
  const real = m.advanced / m.secs;
  console.log(`     1080p through Dither: ${(m.frames / m.secs).toFixed(1)} frames a second shown, video time ${real.toFixed(2)}x wall time, shown speed ${m.speed.toFixed(2)}x on average`);
  check(
    "A 1080p clip through Dither plays at real time or says how fast it plays",
    m.frames > 0 && Math.abs(real - m.speed) <= 0.15,
    `${m.frames} frames in ${m.secs.toFixed(1)} s, ${real.toFixed(2)}x against a shown ${m.speed.toFixed(2)}x`,
  );
  await win.click(".player .play-toggle");

  // --- An Audio file plays from its card.
  await open(soundGraph);
  await win.waitForSelector('.react-flow__node[data-id="a"] .play-now', { timeout: 20_000 });
  await win.click('.react-flow__node[data-id="a"] .play-now');
  await win.waitForSelector(".player[data-playing]", { timeout: 5000 });
  let shown = "";
  try {
    await win.waitForFunction(() => /^0:0[1-9] \//.test(document.querySelector(".play-time")?.textContent ?? ""), null, { timeout: 5000 });
    shown = await win.locator(".play-time").textContent();
  } catch {
    shown = (await win.locator(".play-time").textContent().catch(() => "")) ?? "";
  }
  check("An Audio file's card plays its sound", /^0:0[1-9] \/ 0:04$/.test(shown), `time shown: "${shown}"`);
  check("Its card button turns into Pause", (await win.locator('.react-flow__node[data-id="a"] .play-now').getAttribute("aria-label")) === "Pause");
  await win.click('.react-flow__node[data-id="a"] .play-now');
  await win.waitForSelector(".player:not([data-playing])", { timeout: 3000 });

  const status = await win.evaluate(() => [...document.querySelectorAll(".tnode-status.s-error")].map((e) => e.textContent).join(" | "));
  check("No node shows an error", !status, status);
  check("No errors in the console", !errors.length, errors.slice(0, 5).join(" | "));
} finally {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
