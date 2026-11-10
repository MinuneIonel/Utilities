// Checks the fixes from the November 2026 audit in the built desktop app (npm run build first):
// job nodes marked out of date, the playhead not re-encoding, thumbnails after New then Undo,
// AAC sound in MP4, and no unhandled errors after Cancel. On Linux run it under xvfb-run.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-audit-"));
const out = path.join(tmp, "out");
execFileSync("mkdir", ["-p", out]);

const clip = path.join(tmp, "clip.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
const long = path.join(tmp, "long.mp4");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "40", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", long]);

const mp3 = path.join(tmp, "song.mp3");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-c:a", "libmp3lame", "-b:a", "96k", mp3]);
const cutGraph = {
  version: 1,
  nodes: [
    { id: "a", type: "input.audio", params: { path: mp3, name: "song.mp3" }, position: { x: 40, y: 120 } },
    { id: "c", type: "audio.cut", params: { mode: "remove", start: 0, end: 1, format: "same", name: "cut" }, position: { x: 340, y: 120 } },
    { id: "s", type: "output.save-file", params: { folder: out }, position: { x: 640, y: 120 } },
  ],
  edges: [
    { id: "e1", source: "a", sourceHandle: "audio", target: "c", targetHandle: "audio" },
    { id: "e2", source: "c", sourceHandle: "audio", target: "s", targetHandle: "file" },
  ],
};

const graph = ({ at = 10, quality = "high", file = clip, flip = false } = {}) => ({
  version: 1,
  nodes: [
    { id: "v", type: "input.video", params: { path: file, name: path.basename(file), at }, position: { x: 40, y: 120 } },
    { id: "r", type: "media.transform", params: { flipH: flip }, position: { x: 340, y: 120 } },
    { id: "e", type: "video.encode", params: { container: "mp4", quality, name: "out" }, position: { x: 640, y: 120 } },
    { id: "s", type: "output.save-file", params: { folder: out }, position: { x: 940, y: 120 } },
  ],
  edges: [
    { id: "e1", source: "v", sourceHandle: "video", target: "r", targetHandle: "image" },
    { id: "e2", source: "r", sourceHandle: "image", target: "e", targetHandle: "video" },
    { id: "e3", source: "e", sourceHandle: "file", target: "s", targetHandle: "file" },
  ],
});

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
  const open = async (g) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(g));
    await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), f);
    await menu("open");
    await win.waitForTimeout(2500);
  };
  const status = (id) => win.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"] .tnode-status`);
    return el ? `${el.className.match(/s-(\w+)/)?.[1]}: ${el.textContent}` : "";
  }, id);
  const files = () => readdirSync(out).filter((f) => f.startsWith("out"));
  const render = async (want) => {
    await menu("render");
    for (let i = 0; i < 160 && files().length < want; i++) await win.waitForTimeout(250);
    await win.waitForTimeout(1500);
  };
  // Changes a setting the way a person does: select the node, then use the inspector.
  const select = (id) => win.click(`.react-flow__node[data-id="${id}"] .tnode-title`);
  const field = (label) => win.locator(`.inspector .field:has(label:text-is("${label}"))`);
  const thumbs = () => win.evaluate(() => [...document.querySelectorAll(".tnode-thumb")].filter((c) => !c.hidden && c.width > 0).length);

  await open(graph());
  await render(1);
  check("Render writes the video", files().length === 1, files().join(", "));
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", path.join(out, files()[0] ?? "x")], { encoding: "utf8" }).stderr;
  check("MP4 sound is AAC (bug 4)", /Audio: aac/.test(probe), probe.split("\n").filter((l) => /Stream #/.test(l)).map((l) => l.trim()).join(" | "));
  check("Save says what it saved", /Saved/.test(await status("s")), await status("s"));

  await select("v");
  await field("Playhead %").locator("input.num").fill("60");
  await field("Playhead %").locator("input.num").press("Enter");
  await win.waitForTimeout(2500);
  check("Moving the playhead keeps Encode current (bug 2)", /^cached/.test(await status("e")), await status("e"));
  await render(2);
  check("…and Render doesn't write a duplicate (bug 2)", files().length === 1, files().join(", "));

  await select("r");
  await field("Flip horizontal").locator("input").check();
  await win.waitForTimeout(2500);
  check("Changing something upstream marks Encode out of date (bug 1)", /^stale/.test(await status("e")), await status("e"));
  check("…and Save too, without its Saved label (bug 1)", /^stale/.test(await status("s")) && !/Saved/.test(await status("s")), await status("s"));

  await select("v");
  await field("Playhead %").locator("input.num").fill("5000");
  await field("Playhead %").locator("input.num").press("Enter");
  await win.waitForTimeout(500);
  const at = await field("Playhead %").locator("input.num").inputValue();
  check("A number box pulls 5000 back into its 0–100 range (bug 6)", at === "100", `box shows ${at}`);

  const before = await thumbs();
  await menu("new");
  await win.waitForTimeout(1500);
  await menu("undo");
  await win.waitForTimeout(2500);
  const after = await thumbs();
  check("New then Undo brings the thumbnails back (bug 3)", after >= before && after > 0, `${before} before, ${after} after`);

  await open(cutGraph);
  await menu("render");
  const cutFile = path.join(out, "cut.mp3");
  for (let i = 0; i < 80 && !readdirSync(out).includes("cut.mp3"); i++) await win.waitForTimeout(250);
  await win.waitForTimeout(500);
  const sizes = readdirSync(out).includes("cut.mp3") ? [statSync(mp3).size, statSync(cutFile).size] : [0, 0];
  check("Cutting a second out of an MP3 doesn't grow it (bug 7)", sizes[1] > 0 && sizes[1] < sizes[0], `${sizes[0]} bytes in, ${sizes[1]} out`);

  errors.length = 0;
  await open(graph({ file: long, quality: "very-high", flip: true }));
  await menu("render");
  await win.waitForTimeout(2500);
  await win.click(".topbar button:text-is(\"Cancel\")");
  await win.waitForTimeout(3000);
  const unhandled = errors.filter((e) => /cancel/i.test(e));
  check("Cancel leaves no unhandled error (bug 9)", unhandled.length === 0, unhandled.join(" | "));
} finally {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
