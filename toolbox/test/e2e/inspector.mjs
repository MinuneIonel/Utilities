// The inspector fits its settings to what each node found (npm run build first; on Linux under xvfb-run):
// a playlist's videos as a list of titles, a playhead as a time, Resize's slider up to the image's own
// size, Split's clip count up to the video's length, a folder's files by name, proportional sliders.
// Screenshots of the panel go to $INSPECTOR_SHOTS when set.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-inspector-"));
const shots = process.env.INSPECTOR_SHOTS;
const run = (...args) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);

const clip = path.join(tmp, "song.mp4");
run("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=550", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip);
const long = path.join(tmp, "long.mp4");
run("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "40", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", long);
const photo = path.join(tmp, "photo.png");
run("-f", "lavfi", "-i", "testsrc2=size=1920x1280", "-frames:v", "1", photo);
const mp3 = path.join(tmp, "voice.mp3");
run("-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-c:a", "libmp3lame", "-b:a", "96k", mp3);
const pics = path.join(tmp, "Holiday");
mkdirSync(pics);
for (let i = 1; i <= 23; i++) run("-f", "lavfi", "-i", `color=c=0x${(i * 9).toString(16).padStart(2, "0")}4080:size=64x48`, "-frames:v", "1", path.join(pics, `IMG_${String(400 + i).padStart(4, "0")}.png`));

// A stand-in yt-dlp: a playlist of 15, each "downloading" the 12-second clip.
const bin = path.join(tmp, "profile", "bin");
mkdirSync(bin, { recursive: true });
const titles = ["Lo-fi beats to study to", "Rainy café", "Night drive", "Sunday morning", "Ocean", "Forest walk", "Old radio", "Late train", "Snowfall", "City lights", "Campfire", "Desert wind", "Harbour", "Rooftop", "Last one"];
const list = titles.map((t, i) => `${i + 1}\\tv${i + 1}\\thttps://www.youtube.com/watch?v=v${i + 1}\\tStudy mix\\t${t}\\n`).join("");
writeFileSync(
  path.join(bin, "yt-dlp"),
  ["#!/bin/sh", 'for a; do last="$a"; done', `case " $* " in *" --flat-playlist "*) printf '${list}' > playlist.txt; exit 0;; esac`, 'id="${last##*v=}"', `cp '${clip}' "Song $id [$id].mp4"`, ""].join("\n"),
  { mode: 0o755 },
);

const graph = {
  version: 1,
  nodes: [
    { id: "d", type: "input.download", params: { url: "https://www.youtube.com/playlist?list=PLtest", playlist: "all", which: "", item: 1, quality: "1080", at: 10 }, position: { x: 40, y: 40 } },
    { id: "i", type: "input.file", params: { path: photo, name: "photo.png" }, position: { x: 40, y: 320 } },
    { id: "r", type: "media.transform", params: { resize: "long-edge", size: 1024 }, position: { x: 340, y: 320 } },
    { id: "v", type: "input.video", params: { path: long, name: "long.mp4", at: 10 }, position: { x: 40, y: 600 } },
    { id: "s", type: "media.split", params: { mode: "count", count: 6 }, position: { x: 340, y: 600 } },
    { id: "f", type: "input.folder", params: { folder: pics, at: 4 }, position: { x: 40, y: 880 } },
    { id: "a", type: "input.audio", params: { path: mp3, name: "voice.mp3" }, position: { x: 640, y: 40 } },
    { id: "c", type: "audio.convert", params: { format: "mp3", bitrate: 192, fadeIn: 1 }, position: { x: 940, y: 40 } },
  ],
  edges: [
    { id: "e1", source: "i", sourceHandle: "image", target: "r", targetHandle: "image" },
    { id: "e2", source: "v", sourceHandle: "video", target: "s", targetHandle: "video" },
    { id: "e3", source: "a", sourceHandle: "audio", target: "c", targetHandle: "audio" },
  ],
};
const file = path.join(tmp, "graph.toolbox");
writeFileSync(file, JSON.stringify(graph));

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && detail ? `\n     ${detail}` : ""}`);
  if (!ok) failures++;
};

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, `--user-data-dir=${path.join(tmp, "profile")}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
try {
  const win = await app.firstWindow();
  const errors = [];
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForSelector(".canvas", { state: "attached" });
  await win.evaluate(() => {
    localStorage.setItem("toolbox.tutorial", "1");
    localStorage.setItem("toolbox.mode", "graph");
  });
  await win.reload();
  await win.waitForSelector(".canvas");
  // A missing field fails fast instead of holding up every retry below.
  win.setDefaultTimeout(4000);
  await app.evaluate(({ dialog, BrowserWindow }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    dialog.showMessageBox = async () => ({ response: 0 });
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
  }, file);
  await win.waitForTimeout(1500);

  const select = async (id) => {
    await win.click(`.react-flow__node[data-id="${id}"] .tnode-title`);
    await win.waitForTimeout(300);
  };
  const field = (label) => win.locator(`.inspector .field:has(.field-top label:text-is("${label}"))`);
  const waitFor = async (fn, seconds = 40) => {
    for (let i = 0; i < seconds * 4; i++) {
      if (await fn().catch(() => false)) return true;
      await win.waitForTimeout(250);
    }
    return false;
  };
  const shot = async (name) => shots && (await win.locator(".inspector").screenshot({ path: path.join(shots, `${name}.png`) }));

  // A playlist of 15: Show video lists their titles, not a 1–5000 slider.
  await select("d");
  const listed = await waitFor(async () => (await field("Show video").locator("select option").count()) === 15);
  check(listed, "Show video lists the playlist's 15 videos", `${await field("Show video").locator("select option").count()} options`);
  check((await field("Show video").locator("select option").first().textContent()) === "1. Lo-fi beats to study to", "…by number and title");
  check((await field("Show video").locator(".field-note").textContent()) === "1 of 15", "…and says which one of how many");
  await field("Show video").locator("button[aria-label=Next]").click();
  await win.waitForTimeout(300);
  check((await field("Show video").locator("select").inputValue()) === "2", "› steps to the next video");
  check((await field("Show video").locator("button[aria-label=Previous]").isEnabled()) === true, "…and ‹ can go back");
  const timed = await waitFor(async () => (await field("Preview at").locator(".ticks span").last().textContent()) === "0:12.0");
  check(timed, "Preview at spans the video, shown as a time", await field("Preview at").locator(".ticks").textContent().catch(() => "no ticks"));
  check((await field("Preview at").locator("input.num").inputValue()) === "0:01.2", "…10 % reads 0:01.2", await field("Preview at").locator("input.num").inputValue());
  await field("Preview at").locator("input.num").fill("0:06");
  await field("Preview at").locator("input.num").press("Enter");
  await win.waitForTimeout(300);
  check((await field("Preview at").locator("input[type=range]").inputValue()) === "50", "typing 0:06 puts the playhead half way");
  await shot("playlist");

  // Resize: the slider ends at the image's own size, with quick picks.
  await select("r");
  const fitted = await waitFor(async () => (await field("Long edge px").locator("input[type=range]").getAttribute("max")) === "1920");
  check(fitted, "Long edge ends at the image's 1920 px", await field("Long edge px").locator("input[type=range]").getAttribute("max"));
  const picks = await field("Long edge px").locator(".quick-picks button").allTextContents();
  check(picks.includes("Original · 1920") && picks.includes("1080"), "…with quick picks", picks.join(", "));
  await field("Long edge px").locator(".quick-picks button:text-is('1080')").click();
  await win.waitForTimeout(300);
  check((await field("Long edge px").locator("input.num").inputValue()) === "1080", "a quick pick sets the value");
  check(await field("Long edge px").locator("button.reset").isVisible(), "a changed value offers ↺");
  await win.locator(".inspector .toggle-field:has-text('Allow upscale') input").check();
  await win.waitForTimeout(300);
  check((await field("Long edge px").locator("input[type=range]").getAttribute("max")) === "3840", "Allow upscale stretches it to twice the image");
  await field("Long edge px").locator("input.num").fill("5000");
  await field("Long edge px").locator("input.num").press("Enter");
  await win.waitForTimeout(300);
  check((await field("Long edge px").locator("input.num").inputValue()) === "5000", "a typed value may go past the slider");
  await field("Long edge px").locator("button.reset").click();
  await win.waitForTimeout(300);
  check((await field("Long edge px").locator("input.num").inputValue()) === "1920", "↺ puts the default back");
  await shot("resize");

  // Split: up to one clip a second of the 40-second video, and how long each is.
  await select("s");
  const counted = await waitFor(async () => (await field("Number of clips").locator("input[type=range]").getAttribute("max")) === "40");
  check(counted, "Number of clips goes up to the video's 40 seconds", await field("Number of clips").locator("input[type=range]").getAttribute("max"));
  check((await field("Number of clips").locator(".field-note").textContent()) === "0:06.67 each", "…and says how long each clip is", await field("Number of clips").locator(".field-note").textContent());
  await shot("split");

  // A folder's files by name.
  await select("f");
  const named = await waitFor(async () => (await field("Preview file").locator("select option").count()) === 23);
  check(named, "Preview file lists the folder's 23 files");
  check((await field("Preview file").locator("select option:checked").textContent()) === "IMG_0404.png", "…with the previewed one picked", await field("Preview file").locator("select option:checked").textContent());
  await shot("folder");

  // Proportional bitrate, a fade no longer than half the sound, a hint off the label.
  await select("c");
  check((await field("Bitrate kbps").locator("input[type=range]").getAttribute("max")) === "1000", "Bitrate's slider is proportional");
  check((await field("Bitrate kbps").locator(".field-top small").textContent()) === "0 = default", "…and its bracket text is a grey hint");
  const faded = await waitFor(async () => (await field("Fade in s").locator("input[type=range]").getAttribute("max")) === "4");
  check(faded, "a fade goes up to half of the 8-second sound", await field("Fade in s").locator("input[type=range]").getAttribute("max"));
  await shot("audio");

  // Nothing wraps: every label sits on one line.
  for (const id of ["d", "r", "s", "c"]) {
    await select(id);
    const tall = await win.evaluate(() => [...document.querySelectorAll(".inspector .field-top label")].filter((l) => l.getBoundingClientRect().height > 24).map((l) => l.textContent));
    check(tall.length === 0, `labels fit on one line (${id})`, tall.join(", "));
  }
  check(errors.length === 0, "no errors in the window", errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FAIL ${e instanceof Error ? e.message.split("\n")[0] : e}`);
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
