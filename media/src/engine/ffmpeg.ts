// ffmpeg.wasm fallback: slower (software, single thread) but reads almost anything
// (AVI, WMV, FLV, GIF, old codecs) and writes animated GIFs. Loaded only when needed (~32 MB).

import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import type { RunOptions, VideoInfo } from "./video";
import { planGeometry, type EncodedFile, type VideoJob } from "./types";

let instance: Promise<FFmpeg> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<FFmpeg> {
  if (!instance) {
    instance = (async () => {
      const ff = new FFmpeg();
      await ff.load({ coreURL, wasmURL });
      return ff;
    })();
    instance.catch(() => (instance = null));
  }
  return instance;
}

/** ffmpeg.wasm runs one command at a time, so calls are queued. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function kill() {
  instance?.then((ff) => ff.terminate()).catch(() => undefined);
  instance = null;
}

function inputName(file: Blob): string {
  const name = (file as File).name ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  return `in.${ext || "bin"}`;
}

async function writeInput(ff: FFmpeg, file: Blob): Promise<string> {
  const name = inputName(file);
  await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  return name;
}

export function ffmpegProbe(file: Blob): Promise<Omit<VideoInfo, "reader"> | null> {
  return exclusive(async () => {
    const ff = await load();
    const name = await writeInput(ff, file);
    const lines: string[] = [];
    const onLog = ({ message }: { message: string }) => lines.push(message);
    ff.on("log", onLog);
    try {
      await ff.exec(["-hide_banner", "-i", name]);
    } finally {
      ff.off("log", onLog);
      await ff.deleteFile(name).catch(() => undefined);
    }
    return parseProbe(lines.join("\n"));
  });
}

export function parseProbe(log: string): Omit<VideoInfo, "reader"> | null {
  const v = log.match(/Stream #\d+:\d+.*?: Video: ([a-z0-9_]+).*?, (\d{2,5})x(\d{2,5})/);
  if (!v) return null;
  let width = +v[2];
  let height = +v[3];
  // ffmpeg rotates phone videos upright on decode, so report the upright size.
  const rot = log.match(/rotation of (-?[\d.]+) degrees/) ?? log.match(/rotate\s*:\s*(-?\d+)/);
  if (rot && Math.abs(Math.round(+rot[1])) % 180 === 90) [width, height] = [height, width];
  const d = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0;
  return { width, height, duration, hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(log), codec: v[1] };
}

const CRF_X264 = { "very-high": 18, high: 21, medium: 24, low: 28, "very-low": 33 } as const;
// libvpx-vp9 crashes in the single-thread ffmpeg.wasm build, so WebM falls back to VP8.
const CRF_VP8 = { "very-high": 8, high: 14, medium: 22, low: 30, "very-low": 40 } as const;

/** Builds the ffmpeg arguments for a job. Exported for testing. */
export function ffmpegArgs(inName: string, outName: string, info: VideoInfo, job: VideoJob): string[] {
  const gif = job.container === "gif";
  const g = planGeometry(info.width, info.height, job, !gif);
  const filters: string[] = [];
  if (g.crop.x || g.crop.y || g.crop.width !== info.width || g.crop.height !== info.height) {
    filters.push(`crop=${g.crop.width}:${g.crop.height}:${g.crop.x}:${g.crop.y}`);
  }
  if (g.rotate === 90) filters.push("transpose=1");
  if (g.rotate === 180) filters.push("hflip,vflip");
  if (g.rotate === 270) filters.push("transpose=2");
  if (g.flipH) filters.push("hflip");
  if (g.flipV) filters.push("vflip");
  const sideways = g.rotate === 90 || g.rotate === 270;
  const rw = sideways ? g.crop.height : g.crop.width;
  const rh = sideways ? g.crop.width : g.crop.height;
  if (g.width !== rw || g.height !== rh) filters.push(`scale=${g.width}:${g.height}:flags=lanczos`);
  const fps = job.fps > 0 ? job.fps : gif ? 15 : 0;
  if (fps) filters.push(`fps=${fps}`);

  const args = ["-hide_banner", "-y"];
  if (job.trim) args.push("-ss", job.trim.start.toFixed(3));
  args.push("-i", inName);
  if (job.trim) args.push("-t", (job.trim.end - job.trim.start).toFixed(3));

  if (gif) {
    const chain = filters.length ? filters.join(",") + "," : "";
    args.push("-filter_complex", `[0:v]${chain}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, "-loop", "0", "-an", outName);
    return args;
  }

  const copy = job.rate.mode === "copy" && filters.length === 0;
  if (filters.length) args.push("-vf", filters.join(","));
  const vp = job.container === "webm" || job.codec === "vp9" || job.codec === "vp8";
  const seconds = job.trim ? job.trim.end - job.trim.start : info.duration;
  const bitrate =
    job.rate.mode === "bitrate" ? job.rate.kbps * 1000
    : job.rate.mode === "size" && seconds > 0 ? Math.max(50_000, Math.floor((job.rate.megabytes * 8_000_000 * 0.93) / seconds - (job.audio === "keep" ? job.audioKbps * 1000 : 0)))
    : 0;
  const level = job.rate.mode === "quality" ? job.rate.level : "medium";

  if (copy) args.push("-c:v", "copy");
  else if (vp) {
    args.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-auto-alt-ref", "0");
    if (bitrate) args.push("-b:v", `${Math.round(bitrate / 1000)}k`);
    else args.push("-crf", String(CRF_VP8[level]), "-b:v", "8M");
  } else {
    args.push("-c:v", job.codec === "hevc" ? "libx265" : "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
    if (bitrate) args.push("-b:v", `${Math.round(bitrate / 1000)}k`, "-maxrate", `${Math.round((bitrate * 1.5) / 1000)}k`, "-bufsize", `${Math.round((bitrate * 2) / 1000)}k`);
    else args.push("-crf", String(CRF_X264[level]));
    if (job.container === "mp4" || job.container === "mov") args.push("-movflags", "+faststart");
  }

  if (job.audio === "remove" || !info.hasAudio) args.push("-an");
  else if (copy) args.push("-c:a", "copy");
  else args.push("-c:a", vp ? "libopus" : "aac", "-b:a", `${job.audioKbps}k`);
  args.push(outName);
  return args;
}

export function ffmpegVideo(file: Blob, info: VideoInfo, job: VideoJob, opts: RunOptions = {}): Promise<EncodedFile> {
  return exclusive(async () => {
    opts.onProgress?.({ fraction: -1, label: "Loading ffmpeg.wasm…" });
    const ff = await load();
    const inName = await writeInput(ff, file);
    const ext = job.container === "mkv" ? "mkv" : job.container;
    const outName = `out.${ext}`;
    const onProgress = ({ progress }: { progress: number }) =>
      opts.onProgress?.({ fraction: progress >= 0 && progress <= 1 ? progress : -1, label: "Encoding (ffmpeg.wasm)" });
    const onAbort = () => kill();
    ff.on("progress", onProgress);
    opts.signal?.addEventListener("abort", onAbort);
    try {
      let code: number;
      try {
        code = await ff.exec(ffmpegArgs(inName, outName, info, job));
      } catch (e) {
        // A crash leaves the wasm instance unusable; start fresh next time.
        kill();
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (opts.signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}.`);
      const data = (await ff.readFile(outName)) as Uint8Array;
      const g = planGeometry(info.width, info.height, job, job.container !== "gif");
      const mime = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", gif: "image/gif" }[job.container];
      return { bytes: data, mime, ext, width: g.width, height: g.height, via: "ffmpeg.wasm" };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (!opts.signal?.aborted) {
        ff.off("progress", onProgress);
        await ff.deleteFile(inName).catch(() => undefined);
        await ff.deleteFile(outName).catch(() => undefined);
      }
    }
  });
}
