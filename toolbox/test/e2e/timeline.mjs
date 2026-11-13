// Timeline check: the strip under the canvas, driven with the mouse. Dragging a 4 s clip's End handle
// to the middle of the strip makes Render write a ~2 s video; double-clicking twice on a Split node's
// strip makes three clips; a selected cut goes with Delete (and the node stays); a time box takes 1:05.5.
//   node test/e2e/timeline.mjs     (npm run build first; on Linux under xvfb-run)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-timeline-"));
const userData = path.join(tmp, "user");

const clip = path.join(tmp, "talk.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);

function probe(file) {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const [, h, m, s] = /Duration: (\d+):(\d+):([\d.]+)/.exec(out) ?? [];
  return h === undefined ? NaN : +h * 3600 + +m * 60 + +s;
}

/** Video file -> `middle` -> Save into `folder`. */
const graph = (middle, folder) => ({
  version: 1,
  nodes: [
    { id: "v", type: "input.video", params: { path: clip, name: "talk.mp4", at: 10 }, position: { x: 40, y: 120 } },
    { id: "m", type: middle.type, params: middle.params, position: { x: 340, y: 120 } },
    { id: "s", type: "output.save-file", params: { folder }, position: { x: 640, y: 120 } },
  ],
  edges: [
    { id: "e1", source: "v", sourceHandle: "video", target: "m", targetHandle: "video" },
    { id: "e2", source: "m", sourceHandle: middle.out, target: "s", targetHandle: "file" },
  ],
});

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
  await win.waitForSelector(".canvas", { state: "attached" });
  // A new profile opens on Simple view, and Graph view starts with the tour: these checks drive the graph.
  await win.evaluate(() => {
    localStorage.setItem("toolbox.tutorial", "1");
    localStorage.setItem("toolbox.mode", "graph");
  });
  await win.reload();
  await win.waitForSelector(".canvas");
  await win.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);

  let n = 0;
  const open = async (g) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(g));
    await app.evaluate(({ dialog, BrowserWindow }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      // Opening a graph that names files asks first: use them.
      dialog.showMessageBox = async () => ({ response: 0 });
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
    }, f);
    await win.waitForSelector('.react-flow__node[data-id="m"]', { timeout: 20_000 });
  };
  const select = async (id) => {
    await win.click(`.react-flow__node[data-id="${id}"] .tnode-title`);
    await win.waitForSelector(`.timeline[data-node="${id}"] .tl-strip[data-duration]`, { timeout: 20_000 });
  };
  const render = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
  const waitFor = async (cond, tries = 240) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await win.waitForTimeout(250);
    }
    return false;
  };
  const strip = () => win.locator(".tl-strip").boundingBox();

  // --- Trim: drag the Video file's End handle to the middle.
  const out1 = path.join(tmp, "trim");
  mkdirSync(out1);
  await open(graph({ type: "video.encode", params: { name: "trimmed" }, out: "file" }, out1));
  await select("v");
  const duration = Number(await win.getAttribute(".tl-strip", "data-duration"));
  check("Selecting the Video file shows its whole length on the timeline", Math.abs(duration - 4) < 0.1, `${duration} s`);
  const pictures = await waitFor(async () => Number(await win.getAttribute(".tl-strip", "data-pictures")) >= 24, 80);
  check("…with a filmstrip of 24 pictures", pictures, `${await win.getAttribute(".tl-strip", "data-pictures")} pictures`);
  const box = await strip();
  const handle = await win.locator('.tl-handle[data-handle="end"]').boundingBox();
  check("The End handle starts at the end", Math.abs(handle.x + handle.width / 2 - (box.x + box.width)) < 3, `${handle.x + handle.width / 2} vs ${box.x + box.width}`);
  await win.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 5 });
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await win.mouse.up();
  const endBox = win.locator('.inspector .field:has(> label:text-is("End (0 = to the end)")) input');
  const endText = await endBox.inputValue();
  check("The inspector's End reads about 0:02", /^0:0(1\.9|2\.0|2\.1)/.test(endText), endText);
  check("…and a kept part is drawn, with the rest hatched", (await win.locator(".tl-hatch").count()) === 1);
  await win.waitForTimeout(500);
  await render();
  const trimmed = path.join(out1, "trimmed.mp4");
  await waitFor(async () => readdirSync(out1).includes("trimmed.mp4"));
  await win.waitForTimeout(500);
  const d1 = readdirSync(out1).includes("trimmed.mp4") ? probe(trimmed) : NaN;
  check("Render writes a video of about 2 s", Math.abs(d1 - 2) < 0.2, `${d1} s`);

  // A time box takes minutes:seconds.
  const startBox = win.locator('.inspector .field:has(> label:text-is("Start")) input');
  await startBox.fill("1:05.5");
  await startBox.press("Enter");
  await win.waitForTimeout(200);
  check('A time box accepts "1:05.5"', (await startBox.inputValue()) === "1:05.5", await startBox.inputValue());
  await startBox.fill("nonsense");
  await startBox.press("Enter");
  check("…and puts back the time it had for anything that isn't a time", (await startBox.inputValue()) === "1:05.5", await startBox.inputValue());

  // --- Split: double-click twice on the strip for two cuts, so three clips.
  const out2 = path.join(tmp, "split");
  mkdirSync(out2);
  await open(graph({ type: "media.split", params: { mode: "at", at: "", name: "part" }, out: "clips" }, out2));
  await select("m");
  const sbox = await strip();
  const y = sbox.y + sbox.height / 2;
  for (const f of [1 / 4, 1 / 2, 3 / 4]) {
    await win.mouse.dblclick(sbox.x + sbox.width * f, y);
    await win.waitForTimeout(150);
  }
  check("Double-clicking on a Split node's strip adds cuts", (await win.locator(".tl-mark").count()) === 3, `${await win.locator(".tl-mark").count()} cuts`);
  // The last one is selected: Delete takes it out, and the node stays.
  await win.keyboard.press("Delete");
  await win.waitForTimeout(200);
  const nodes = await win.locator(".react-flow__node").count();
  check("Delete removes the selected cut, not the node", (await win.locator(".tl-mark").count()) === 2 && nodes === 3, `${await win.locator(".tl-mark").count()} cuts, ${nodes} nodes`);
  const at = await win.locator('.inspector .field:has(> label:text-is("Cut at")) input').inputValue();
  check("Cut at lists the two times", /^0:0[01]\.\d+, 0:0[12]\.\d+$/.test(at), at);
  await render();
  const clips = () => readdirSync(out2).filter((f) => f.endsWith(".mp4"));
  await waitFor(async () => clips().length >= 3);
  await win.waitForTimeout(500);
  const lengths = clips().sort().map((f) => probe(path.join(out2, f)).toFixed(2));
  check("Render makes three clips", clips().length === 3 && lengths.every((l) => Number(l) > 0.5), `${clips().join(", ")} (${lengths.join(", ")} s)`);

  // --- Folding the timeline away keeps it folded.
  await win.click(".tl-fold");
  check("The timeline folds down to its title", (await win.locator(".timeline[data-collapsed] .tl-strip").count()) === 0 && (await win.locator(".timeline[data-collapsed]").count()) === 1);
  await win.click(".tl-fold");

  check("no errors in the console", errors.length === 0, errors.join("\n     "));
} finally {
  await app.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall timeline checks passed");
process.exit(failed ? 1 : 0);
