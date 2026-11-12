// Big files stay on disk (npm run build first; on Linux under xvfb-run). An encoded video is written
// into Toolbox's scratch folder as it's made, and Save copies it from there: its bytes never pass
// through the window. Checks that the Save IPC got a path, that two Save nodes on one Encode video
// both get the file, that it plays and starts with its index (fast start), that the scratch folder
// serves ranges and nothing outside itself, and that it's gone after quitting. Then a download (from
// a stand-in yt-dlp) and an AVI ffmpeg converts first: both stay on disk and are read from there.
//   TOOLBOX_E2E_BIG=1            also encodes a 10-minute 1080p video (about 3 GB) to ProRes and
//                                checks the window stays under 1.5 GB of memory (slow; not in CI)
//   TOOLBOX_E2E_BIG_SECONDS=60   a shorter big case, for a quicker look at the memory
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-bigfile-"));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};
const folder = (name) => {
  const d = path.join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const mb = (kb) => `${Math.round(kb / 1024)} MB`;

/** Top-level MP4/MOV boxes in order, so we can tell whether the index (moov) comes before the media (mdat). */
function topBoxes(file) {
  const buf = readFileSync(file);
  const boxes = [];
  for (let at = 0; at + 8 <= buf.length && boxes.length < 50; ) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(at + 8));
    else if (size === 0) size = buf.length - at;
    boxes.push(type);
    if (size < 8) break;
    at += size;
  }
  return boxes;
}

/** What ffmpeg says about a file, and whether it decodes from start to end. */
function probe(file) {
  const info = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
  const decode = spawnSync(ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
  return {
    info,
    plays: decode.status === 0 && !decode.stderr.trim(),
    errors: decode.stderr.trim().split("\n").slice(0, 3).join(" | "),
    seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
  };
}

async function launch() {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, `--user-data-dir=${path.join(tmp, "profile")}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  win.on("pageerror", (e) => errors.push(e.message));
  await win.waitForSelector(".canvas", { state: "attached" });
  // A new profile opens on Simple view, and Graph view starts with the tour: these checks drive the graph.
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1" || localStorage.getItem("toolbox.mode") !== "graph")) {
    await win.evaluate(() => {
      localStorage.setItem("toolbox.tutorial", "1");
      localStorage.setItem("toolbox.mode", "graph");
    });
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  // Records what the window sends to save-file (the second argument is the bytes, or { fromPath }).
  const spying = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get("save-file");
    if (!original) return false;
    globalThis.__saves = [];
    handlers.set("save-file", (e, ...args) => {
      const d = args[1];
      globalThis.__saves.push(d && typeof d === "object" && "fromPath" in d ? { fromPath: d.fromPath } : { bytes: d?.byteLength ?? -1 });
      return original(e, ...args);
    });
    return true;
  });
  const scratch = await app.evaluate(({ app }) => ({ temp: app.getPath("temp"), pid: process.pid }));
  const scratchDir = path.join(scratch.temp, `toolbox-scratch-${scratch.pid}`);
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
  let n = 0;
  const open = async (g) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(g));
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      dialog.showMessageBox = async () => ({ response: 0 });
    }, f);
    await menu("open");
    await win.waitForTimeout(2500);
  };
  /** The renderer's (window and graph worker) memory in KB, sampled until stopped. */
  const watchMemory = () => {
    let peak = 0;
    let all = 0;
    const timer = setInterval(async () => {
      try {
        const m = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, kb: p.memory.workingSetSize })));
        peak = Math.max(peak, ...m.filter((p) => p.type === "Tab").map((p) => p.kb));
        all = Math.max(all, m.reduce((s, p) => s + p.kb, 0));
      } catch {
        /* closing */
      }
    }, 500);
    return () => {
      clearInterval(timer);
      return { peak, all };
    };
  };
  const status = (id) => win.evaluate((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .tnode-status`)?.textContent ?? "", id);
  const saves = () => app.evaluate(() => globalThis.__saves ?? []);
  return { app, win, errors, spying, scratchDir, menu, open, watchMemory, status, saves };
}

/** Renders and waits until every folder holds a file (or the time is up). */
async function renderInto(t, folders, seconds) {
  const done = () => folders.every((d) => readdirSync(d).some((f) => !f.endsWith(".part")));
  await t.menu("render");
  for (let i = 0; i < seconds * 4 && !done(); i++) await t.win.waitForTimeout(250);
  await t.win.waitForTimeout(1500);
  return done();
}

// ---------------------------------------------------------------- the default case (CI)
{
  const clip = path.join(tmp, "clip.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const a = folder("a");
  const b = folder("b");
  const graph = {
    version: 1,
    nodes: [
      { id: "v", type: "input.video", params: { path: clip, name: "clip.mp4" }, position: { x: 40, y: 120 } },
      { id: "d", type: "dither.recipe", params: { size: "source" }, position: { x: 340, y: 120 } },
      { id: "e", type: "video.encode", params: { container: "mp4", codec: "avc", quality: "medium", name: "out" }, position: { x: 640, y: 120 } },
      { id: "s1", type: "output.save-file", params: { folder: a }, position: { x: 940, y: 40 } },
      { id: "s2", type: "output.save-file", params: { folder: b }, position: { x: 940, y: 260 } },
    ],
    edges: [
      { id: "e1", source: "v", sourceHandle: "video", target: "d", targetHandle: "image" },
      { id: "e2", source: "d", sourceHandle: "image", target: "e", targetHandle: "video" },
      { id: "e3", source: "e", sourceHandle: "file", target: "s1", targetHandle: "file" },
      { id: "e4", source: "e", sourceHandle: "file", target: "s2", targetHandle: "file" },
    ],
  };
  const t = await launch();
  let scratchDir = t.scratchDir;
  try {
    await t.open(graph);
    const stop = t.watchMemory();
    const t0 = Date.now();
    const wrote = await renderInto(t, [a, b], 120);
    const mem = stop();
    console.log(`     render took ${((Date.now() - t0) / 1000).toFixed(1)} s; window peak ${mb(mem.peak)}, all processes peak ${mb(mem.all)}`);
    check("Both Save nodes on one Encode video write the file", wrote, `${readdirSync(a).join(", ")} | ${readdirSync(b).join(", ")} | ${await t.status("e")} | ${t.errors.join(" | ")}`);
    const [fa, fb] = [path.join(a, "out.mp4"), path.join(b, "out.mp4")];
    if (wrote && existsSync(fa) && existsSync(fb)) {
      check("…the same file in both", readFileSync(fa).equals(readFileSync(fb)), `${statSync(fa).size} and ${statSync(fb).size} bytes`);
      const p = probe(fa);
      check("The video plays to the end", p.plays && Math.abs(p.seconds - 10) < 0.6, `${p.seconds} s ${p.errors}`);
      check("…as H.264 with AAC sound", /Video: h264/.test(p.info) && /Audio: aac/.test(p.info), p.info.split("\n").filter((l) => /Stream #/.test(l)).map((l) => l.trim()).join(" | "));
      const boxes = topBoxes(fa);
      check("…and starts with its index, so it plays at once (fast start)", boxes.indexOf("moov") >= 0 && boxes.indexOf("moov") < boxes.indexOf("mdat"), boxes.join(" "));
    }
    if (t.spying) {
      const sent = await t.saves();
      check(
        "Save sent the scratch file's path, not its bytes",
        sent.length === 2 && sent.every((s) => typeof s.fromPath === "string" && path.dirname(s.fromPath) === scratchDir),
        JSON.stringify(sent),
      );
    } else console.log("     (couldn't watch the save-file IPC in this Electron; skipped that check)");

    const kept = readdirSync(scratchDir);
    check("The encoded video waits in the scratch folder", kept.length >= 1, kept.join(", "));
    const name = kept.find((f) => f.endsWith(".mp4"));
    if (name) {
      const whole = readFileSync(path.join(scratchDir, name));
      const ranged = await t.win.evaluate(async (url) => {
        const r = await fetch(url, { headers: { Range: "bytes=4-11" } });
        return { status: r.status, range: r.headers.get("content-range"), bytes: [...new Uint8Array(await r.arrayBuffer())] };
      }, `app://toolbox/@scratch/${encodeURIComponent(name)}`);
      check(
        "The scratch folder answers range requests",
        ranged.status === 206 && ranged.range === `bytes 4-11/${whole.length}` && Buffer.from(ranged.bytes).equals(whole.subarray(4, 12)),
        `${ranged.status} ${ranged.range}`,
      );
    }
    const local = await t.win.evaluate(async (p) => {
      const r = await fetch(`app://toolbox/@local/${encodeURIComponent(p)}`, { headers: { Range: "bytes=0-99" } });
      return { status: r.status, length: (await r.arrayBuffer()).byteLength };
    }, clip);
    check("A file the person gave answers range requests too", local.status === 206 && local.length === 100, JSON.stringify(local));

    const outside = await t.win.evaluate(async () => {
      const urls = ["app://toolbox/@scratch/..%2F..%2Fetc%2Fhostname", "app://toolbox/@scratch/%2Fetc%2Fhostname", "app://toolbox/@local/%2Fetc%2Fhostname"];
      return Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 0)));
    });
    check("Nothing outside the scratch folder (or not given) is served", outside.every((s) => s === 404 || s === 403), outside.join(", "));
    const refused = await t.win.evaluate(
      async ({ dir, from }) => {
        try {
          await window.toolbox.saveFile("stolen.txt", { fromPath: from }, dir);
          return "saved";
        } catch (e) {
          return String(e.message);
        }
      },
      { dir: a, from: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hostname" },
    );
    check("Save refuses to copy a file from outside the scratch folder", refused !== "saved" && !existsSync(path.join(a, "stolen.txt")), refused);
  } finally {
    await t.app.close();
  }
  check("The scratch folder is gone after quitting", !existsSync(scratchDir), scratchDir);
}

// ---------------------------------------------------------------- downloads and converted inputs
// yt-dlp is stood in for by a script that "downloads" a clip (no internet needed): Toolbox uses the
// copy in its own folder while it's less than a week old. An AVI with MPEG-4 Part 2 video, which
// WebCodecs can't read, is converted by ffmpeg first; both then stay on disk and are read from there.
if (process.platform !== "win32") {
  const clip = path.join(tmp, "dl.mp4");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=660", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
  const avi = path.join(tmp, "old.avi");
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "2", "-c:v", "mpeg4", "-q:v", "5", avi]);
  const bin = path.join(tmp, "profile", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "yt-dlp"), `#!/bin/sh\ncp '${clip}' 'Fake clip [abc123].mp4'\n`, { mode: 0o755 });
  const [asIs, encoded, converted] = [folder("dl-file"), folder("dl-encoded"), folder("converted")];
  const graph = {
    version: 1,
    nodes: [
      { id: "d", type: "input.download", params: { url: "https://example.com/watch?v=abc123", quality: "1080" }, position: { x: 40, y: 40 } },
      { id: "s1", type: "output.save-file", params: { folder: asIs }, position: { x: 640, y: 0 } },
      { id: "e", type: "video.encode", params: { container: "mp4", codec: "avc", quality: "medium", name: "from-download" }, position: { x: 340, y: 160 } },
      { id: "s2", type: "output.save-file", params: { folder: encoded }, position: { x: 640, y: 160 } },
      { id: "v", type: "input.video", params: { path: avi, name: "old.avi" }, position: { x: 40, y: 360 } },
      { id: "e2", type: "video.encode", params: { container: "mp4", codec: "avc", quality: "medium", name: "from-avi" }, position: { x: 340, y: 360 } },
      { id: "s3", type: "output.save-file", params: { folder: converted }, position: { x: 640, y: 360 } },
    ],
    edges: [
      { id: "e1", source: "d", sourceHandle: "file", target: "s1", targetHandle: "file" },
      { id: "e2", source: "d", sourceHandle: "video", target: "e", targetHandle: "video" },
      { id: "e3", source: "e", sourceHandle: "file", target: "s2", targetHandle: "file" },
      { id: "e4", source: "v", sourceHandle: "video", target: "e2", targetHandle: "video" },
      { id: "e5", source: "e2", sourceHandle: "file", target: "s3", targetHandle: "file" },
    ],
  };
  const t = await launch();
  const scratchDir = t.scratchDir;
  try {
    await t.open(graph);
    const wrote = await renderInto(t, [asIs, encoded, converted], 90);
    check("A download and a converted AVI render and save", wrote, `${readdirSync(asIs).join(", ")} | ${readdirSync(encoded).join(", ")} | ${readdirSync(converted).join(", ")} | ${await t.status("d")} | ${await t.status("v")} | ${t.errors.join(" | ")}`);
    const saved = path.join(asIs, "Fake clip [abc123].mp4");
    check("The download's File output saves the file as it came", existsSync(saved) && readFileSync(saved).equals(readFileSync(clip)));
    if (t.spying) {
      const sent = await t.saves();
      check("…copied from the scratch folder, like every video here", sent.length === 3 && sent.every((s) => typeof s.fromPath === "string" && path.dirname(s.fromPath) === scratchDir), JSON.stringify(sent));
    }
    const a = path.join(encoded, "from-download.mp4");
    const pa = existsSync(a) ? probe(a) : { plays: false, seconds: 0, errors: "missing", info: "" };
    check("The downloaded video, read from disk, encodes and plays", pa.plays && Math.abs(pa.seconds - 3) < 0.5 && /Audio: aac/.test(pa.info), `${pa.seconds} s ${pa.errors}`);
    const b = path.join(converted, "from-avi.mp4");
    const pb = existsSync(b) ? probe(b) : { plays: false, seconds: 0, errors: "missing" };
    check("The converted AVI, read from disk, encodes and plays", pb.plays && Math.abs(pb.seconds - 2) < 0.5, `${pb.seconds} s ${pb.errors}`);
    const kept = readdirSync(scratchDir);
    // The download, the AVI's converted copy (ffmpeg's out.mp4) and the two encoded videos; the files
    // made along the way (before the fast-start pass) are gone already.
    check("The download and the converted copy wait in the scratch folder", kept.some((f) => f.endsWith("Fake clip [abc123].mp4")) && kept.length === 4, kept.join(", "));
  } finally {
    await t.app.close();
  }
  check("…and are gone after quitting", !existsSync(scratchDir), scratchDir);
}

// ---------------------------------------------------------------- the big case (TOOLBOX_E2E_BIG=1)
if (process.env.TOOLBOX_E2E_BIG === "1" || process.env.TOOLBOX_E2E_BIG_SECONDS) {
  const seconds = Number(process.env.TOOLBOX_E2E_BIG_SECONDS) || 600;
  const big = path.join(tmp, "big.mp4");
  console.log(`\nMaking a ${seconds} s 1080p test video…`);
  // About 40 Mbit/s: ten minutes come to about 3 GB.
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "40M", "-maxrate", "40M", "-bufsize", "80M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", big]);
  console.log(`     ${(statSync(big).size / 1e9).toFixed(2)} GB`);
  const out = folder("big");
  const graph = {
    version: 1,
    nodes: [
      { id: "v", type: "input.video", params: { path: big, name: "big.mp4" }, position: { x: 40, y: 120 } },
      { id: "e", type: "video.encode", params: { container: "mov", codec: "prores", prores: "hq", name: "big" }, position: { x: 340, y: 120 } },
      { id: "s", type: "output.save-file", params: { folder: out }, position: { x: 640, y: 120 } },
    ],
    edges: [
      { id: "e1", source: "v", sourceHandle: "video", target: "e", targetHandle: "video" },
      { id: "e2", source: "e", sourceHandle: "file", target: "s", targetHandle: "file" },
    ],
  };
  const t = await launch();
  try {
    await t.open(graph);
    const stop = t.watchMemory();
    const t0 = Date.now();
    await t.menu("render");
    for (let i = 0; i < seconds * 40 && !/^Saved/.test(await t.status("s")); i++) await t.win.waitForTimeout(250);
    const mem = stop();
    const file = path.join(out, "big.mov");
    const size = existsSync(file) ? statSync(file).size : 0;
    console.log(`     ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(size / 1e9).toFixed(2)} GB written; window peak ${mb(mem.peak)}, all processes peak ${mb(mem.all)}`);
    check("A big video encodes to ProRes and saves", size > 0 && /prores/.test(probe(file).info), `${await t.status("e")} ${t.errors.join(" | ")}`);
    check("…while the window stays under 1.5 GB", mem.peak > 0 && mem.peak < 1.5 * 1024 * 1024, mb(mem.peak));
  } finally {
    await t.app.close();
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall big-file checks passed");
process.exit(failed ? 1 : 0);
