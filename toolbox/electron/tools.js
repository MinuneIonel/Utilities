// Native command-line tools run from the main process: ffmpeg (bundled with the
// app, or from ffmpeg-static in development) and yt-dlp (downloaded on first use).
// Each job runs in its own temp folder; the files it creates are sent back.
import { app, ipcMain, net } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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
/** macOS's own image converter, for iPhone photos (HEIC) that Chromium can't decode. */
const sipsPath = process.platform === "darwin" && existsSync("/usr/bin/sips") ? "/usr/bin/sips" : null;
const ytdlpHome = () => path.join(app.getPath("userData"), "bin", exe("yt-dlp"));

const YTDLP_ASSET = { darwin: "yt-dlp_macos", linux: "yt-dlp_linux", win32: "yt-dlp.exe" }[process.platform];

/** Downloads the newest yt-dlp into Toolbox's folder, checked against the release's checksums. Returns whether it changed. */
async function fetchYtdlp(own, onProgress, label) {
  if (!YTDLP_ASSET) throw new Error("yt-dlp isn't available for this system");
  onProgress?.(-1, label);
  const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
  const [res, sums] = await Promise.all([net.fetch(base + YTDLP_ASSET), net.fetch(base + "SHA2-256SUMS")]);
  if (!res.ok) throw new Error(`Couldn't download yt-dlp (${res.status})`);
  if (!sums.ok) throw new Error(`Couldn't download yt-dlp's checksums (${sums.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  // The release lists "<sha256>  <file name>" per line; a download that doesn't match is thrown away.
  const want = (await sums.text()).split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === YTDLP_ASSET)?.[0];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (!want || want.toLowerCase() !== got) throw new Error("The downloaded yt-dlp didn't match its published checksum, so Toolbox didn't install it");
  const old = existsSync(own) ? createHash("sha256").update(await readFile(own)).digest("hex") : "";
  await mkdir(path.dirname(own), { recursive: true });
  await writeFile(own + ".part", bytes);
  await chmod(own + ".part", 0o755);
  await rename(own + ".part", own);
  return old !== got;
}

/** Sites change often and old yt-dlp builds stop working with them, so Toolbox's own copy is refreshed weekly. */
const YTDLP_MAX_AGE = 7 * 24 * 3600 * 1000;
/** Updated after a failed download in this session already: a second update won't help. */
let ytdlpRetried = false;

/**
 * The yt-dlp Toolbox keeps in its own folder, downloading it the first time. A system copy
 * (Homebrew) is only a fallback when that download fails: nothing keeps it up to date, and
 * an old yt-dlp gets 403s from YouTube.
 */
let ytdlp = null;
function getYtdlp(onProgress) {
  ytdlp ??= (async () => {
    const own = ytdlpHome();
    if (existsSync(own)) {
      if (Date.now() - (await stat(own)).mtimeMs > YTDLP_MAX_AGE) {
        // Offline or GitHub down: the old copy still works for most sites.
        await fetchYtdlp(own, onProgress, "Updating yt-dlp…").catch(() => undefined);
      }
      return own;
    }
    try {
      await fetchYtdlp(own, onProgress, "Downloading yt-dlp…");
      return own;
    } catch (e) {
      const system = SYSTEM_DIRS.map((d) => path.join(d, "yt-dlp")).find((p) => existsSync(p));
      if (system) return system;
      throw e;
    }
  })().catch((e) => {
    ytdlp = null;
    throw e;
  });
  return ytdlp;
}

/** After a failed download: fetches a newer yt-dlp, once per session. True when there is a new one to try. */
async function updateYtdlpAfterFailure(onProgress) {
  if (ytdlpRetried || (await getYtdlp()) !== ytdlpHome()) return false;
  ytdlpRetried = true;
  return fetchYtdlp(ytdlpHome(), onProgress, "Updating yt-dlp…").catch(() => false);
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

/** What this ffmpeg can do: its encoders and hardware decoders (VideoToolbox on a Mac). */
let caps = null;
function ffmpegCaps() {
  caps ??= (async () => {
    if (!ffmpegPath) return { encoders: [], hwaccels: [] };
    const list = (args) =>
      new Promise((resolve) => {
        let out = "";
        const p = spawn(ffmpegPath, ["-hide_banner", ...args]);
        p.stdout.on("data", (d) => (out += d));
        p.on("error", () => resolve(""));
        p.on("close", () => resolve(out));
      });
    const [enc, hw] = await Promise.all([list(["-encoders"]), list(["-hwaccels"])]);
    // Encoder lines look like " V....D libx264  libx264 H.264 / AVC ..."; hwaccels are one per line after a header.
    const encoders = [...enc.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)].map((m) => m[1]);
    const hwaccels = hw.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    return { encoders, hwaccels };
  })();
  return caps;
}

const jobs = new Map();
/** stdin of jobs that take their input as a stream (raw video frames), once their process has started. */
const streams = new Map();
/** Jobs cancelled before their process started (while yt-dlp downloads, or files are written). */
const cancelled = new Set();
/** Jobs the user cancelled, so a killed yt-dlp isn't mistaken for one that needs updating. */
const stopped = new Set();

/**
 * Runs `tool` with `args` in a fresh temp folder holding `files`, and returns
 * the exit code, every new file it wrote, and the end of its log.
 */
async function run(sender, id, tool, args, files, stdin = false) {
  let stream;
  if (stdin) {
    // Registered before the first await, so writes sent right after the open find it.
    stream = {};
    stream.ready = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
    stream.ready.catch(() => undefined);
    streams.set(id, stream);
  }
  const report = (fraction, label) => {
    if (!sender.isDestroyed()) sender.send("tool-progress", id, fraction, label);
  };
  let bin;
  let env;
  if (tool === "ffmpeg") bin = ffmpegPath;
  else if (tool === "sips") bin = sipsPath;
  else if (tool === "yt-dlp") {
    bin = await getYtdlp(report);
    if (ffmpegPath) args = ["--ffmpeg-location", ffmpegPath, ...args];
    // YouTube's player challenges need a JavaScript runtime, or its video links answer 403.
    // Toolbox's own Electron runs as Node for that, so nothing else has to be installed.
    // A personal yt-dlp config (say -P ~/Downloads) would send files outside the job's folder.
    args = ["--ignore-config", "--js-runtimes", `node:${process.execPath}`, ...args];
    env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  }
  if (!bin) {
    stream?.reject(new Error(`${tool} isn't available`));
    throw new Error(`${tool} isn't available`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "toolbox-"));
  try {
    for (const [name, file] of Object.entries(files ?? {})) {
      const to = path.join(dir, path.basename(name));
      // A file already on disk is linked in rather than sent over as bytes (a long video would be copied several times).
      if (file && typeof file === "object" && "path" in file) await symlink(file.path, to).catch(() => copyFile(file.path, to));
      else await writeFile(to, file);
    }
    const before = new Set(await readdir(dir));
    let log = "";
    const parse = progressParser(tool, report);
    if (cancelled.has(id)) throw new Error("Cancelled");
    const code = await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { cwd: dir, env, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      jobs.set(id, p);
      if (stream) {
        // ffmpeg closing its input early (a failed encoder) shows up as EPIPE on the next write.
        p.stdin.on("error", () => undefined);
        stream.resolve(p.stdin);
      }
      const onData = (d) => {
        const s = d.toString();
        log = (log + s).slice(-8000);
        parse(s);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      p.on("error", (e) => {
        stream?.reject(e);
        reject(e);
      });
      p.on("close", (c) => resolve(c ?? -1));
    });
    const out = {};
    for (const name of await readdir(dir)) {
      // yt-dlp leaves .part and .ytdl files behind when stopped; only finished files come back.
      if (!before.has(name) && !/\.(part|ytdl|temp)$/.test(name)) out[name] = await readFile(path.join(dir, name));
    }
    return { code, files: out, log };
  } catch (e) {
    stream?.reject(e);
    throw e;
  } finally {
    jobs.delete(id);
    streams.delete(id);
    cancelled.delete(id);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes one chunk to a streaming job's stdin, resolving once the process has taken it. */
async function write(id, bytes) {
  const stdin = await streams.get(id)?.ready;
  if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("ffmpeg stopped reading");
  await new Promise((resolve, reject) => stdin.write(bytes, (e) => (e ? reject(e) : resolve())));
}

/** Runs a tool; a yt-dlp download that fails gets one more try with a newer yt-dlp. */
async function runTool(sender, id, tool, args, files) {
  try {
    const r = await run(sender, id, tool, args, files);
    if (tool !== "yt-dlp" || r.code === 0 || stopped.has(id)) return r;
    const report = (fraction, label) => !sender.isDestroyed() && sender.send("tool-progress", id, fraction, label);
    return (await updateYtdlpAfterFailure(report)) && !stopped.has(id) ? await run(sender, id, tool, args, files) : r;
  } finally {
    stopped.delete(id);
  }
}

export function registerTools() {
  ipcMain.handle("tools-info", async () => ({ ffmpeg: !!ffmpegPath, ytdlp: !!YTDLP_ASSET, sips: !!sipsPath, ...(await ffmpegCaps()) }));
  ipcMain.handle("tool-run", (e, id, tool, args, files) => runTool(e.sender, id, tool, args, files));
  // A job fed through stdin: tool-open starts it and resolves when it exits; tool-write and tool-end feed it.
  ipcMain.handle("tool-open", (e, id, tool, args, files) => run(e.sender, id, tool, args, files, true).finally(() => stopped.delete(id)));
  ipcMain.handle("tool-write", (_e, id, bytes) => write(id, bytes));
  ipcMain.handle("tool-end", async (_e, id) => {
    const stdin = await streams.get(id)?.ready.catch(() => undefined);
    stdin?.end();
  });
  ipcMain.handle("tool-cancel", (_e, id) => {
    stopped.add(id);
    const p = jobs.get(id);
    if (p) p.kill("SIGKILL");
    else cancelled.add(id);
  });
  // Don't leave ffmpeg or yt-dlp running after the app quits.
  app.on("will-quit", () => {
    for (const p of jobs.values()) p.kill("SIGKILL");
  });
}
