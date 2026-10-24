// Native command-line tools run from the main process: ffmpeg (bundled with the
// app, or from ffmpeg-static in development) and yt-dlp (downloaded on first use).
// Each job runs in its own temp folder; the files it creates are sent back.
import { app, ipcMain, net } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function findFfmpeg() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, exe("ffmpeg")));
  try {
    candidates.push(createRequire(import.meta.url)("ffmpeg-static"));
  } catch {
    /* not installed: fall back to a system ffmpeg */
  }
  candidates.push(...SYSTEM_DIRS.map((d) => path.join(d, "ffmpeg")));
  return candidates.find((p) => typeof p === "string" && existsSync(p)) ?? null;
}

const ffmpegPath = findFfmpeg();
const ytdlpHome = () => path.join(app.getPath("userData"), "bin", exe("yt-dlp"));

const YTDLP_ASSET = { darwin: "yt-dlp_macos", linux: "yt-dlp_linux", win32: "yt-dlp.exe" }[process.platform];

/** A system yt-dlp, or the one Toolbox keeps in its own folder, downloading it the first time. */
let ytdlp = null;
function getYtdlp(onProgress) {
  ytdlp ??= (async () => {
    const own = ytdlpHome();
    if (existsSync(own)) return own;
    const system = SYSTEM_DIRS.map((d) => path.join(d, "yt-dlp")).find((p) => existsSync(p));
    if (system) return system;
    if (!YTDLP_ASSET) throw new Error("yt-dlp isn't available for this system");
    onProgress?.(-1, "Downloading yt-dlp…");
    const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`);
    if (!res.ok) throw new Error(`Couldn't download yt-dlp (${res.status})`);
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own + ".part", Buffer.from(await res.arrayBuffer()));
    await chmod(own + ".part", 0o755);
    await rename(own + ".part", own);
    return own;
  })().catch((e) => {
    ytdlp = null;
    throw e;
  });
  return ytdlp;
}

const clock = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** Reads progress out of the tools' log lines: ffmpeg's time= against its Duration, yt-dlp's percentages. */
function progressParser(tool, report) {
  let total = 0;
  return (text) => {
    if (tool === "ffmpeg") {
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (d) total = clock(d[1], d[2], d[3]);
      const t = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
      if (t && total > 0) report(Math.min(0.99, clock(t[1], t[2], t[3]) / total), "ffmpeg");
    } else {
      const p = [...text.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g)].pop();
      if (p) report(Math.min(0.99, Number(p[1]) / 100), "Downloading");
      else if (/\[Merger\]|\[ExtractAudio\]|\[VideoConvertor\]/.test(text)) report(-1, "Merging");
    }
  };
}

const jobs = new Map();

/**
 * Runs `tool` with `args` in a fresh temp folder holding `files`, and returns
 * the exit code, every new file it wrote, and the end of its log.
 */
async function run(sender, id, tool, args, files) {
  const report = (fraction, label) => {
    if (!sender.isDestroyed()) sender.send("tool-progress", id, fraction, label);
  };
  let bin;
  if (tool === "ffmpeg") bin = ffmpegPath;
  else if (tool === "yt-dlp") {
    bin = await getYtdlp(report);
    if (ffmpegPath) args = ["--ffmpeg-location", ffmpegPath, ...args];
  }
  if (!bin) throw new Error(`${tool} isn't available`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  try {
    for (const [name, bytes] of Object.entries(files ?? {})) await writeFile(path.join(dir, path.basename(name)), bytes);
    const before = new Set(await readdir(dir));
    let log = "";
    const parse = progressParser(tool, report);
    const code = await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { cwd: dir });
      jobs.set(id, p);
      const onData = (d) => {
        const s = d.toString();
        log = (log + s).slice(-8000);
        parse(s);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      p.on("error", reject);
      p.on("close", (c) => resolve(c ?? -1));
    });
    const out = {};
    for (const name of await readdir(dir)) {
      // yt-dlp leaves .part and .ytdl files behind when stopped; only finished files come back.
      if (!before.has(name) && !/\.(part|ytdl|temp)$/.test(name)) out[name] = await readFile(path.join(dir, name));
    }
    return { code, files: out, log };
  } finally {
    jobs.delete(id);
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerTools() {
  ipcMain.handle("tools-info", () => ({ ffmpeg: !!ffmpegPath, ytdlp: !!YTDLP_ASSET }));
  ipcMain.handle("tool-run", (e, id, tool, args, files) => run(e.sender, id, tool, args, files));
  ipcMain.handle("tool-cancel", (_e, id) => {
    jobs.get(id)?.kill("SIGKILL");
  });
}
