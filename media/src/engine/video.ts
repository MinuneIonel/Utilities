// Video pipeline: file in, encoded file out. Uses Mediabunny (WebCodecs, hardware accelerated)
// and falls back to ffmpeg.wasm for containers, codecs and outputs (GIF) Mediabunny can't handle.

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  getFirstEncodableVideoCodec,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import { ffmpegProbe, ffmpegVideo } from "./ffmpeg";
import { cropInTransformedSpace, planGeometry, type EncodedFile, type Geometry, type Progress, type Rect, type Rotation, type VideoContainer, type VideoJob } from "./types";

export const VIDEO_CONTAINERS: Record<VideoContainer, { label: string; mime: string; ext: string }> = {
  mp4: { label: "MP4", mime: "video/mp4", ext: "mp4" },
  webm: { label: "WebM", mime: "video/webm", ext: "webm" },
  mov: { label: "MOV", mime: "video/quicktime", ext: "mov" },
  mkv: { label: "MKV", mime: "video/x-matroska", ext: "mkv" },
  gif: { label: "GIF (animated)", mime: "image/gif", ext: "gif" },
};

const PREFERRED: Record<Exclude<VideoContainer, "gif">, VideoCodec[]> = {
  mp4: ["avc", "hevc", "av1", "vp9"],
  mov: ["avc", "hevc", "av1", "vp9"],
  webm: ["vp9", "av1", "vp8"],
  mkv: ["avc", "vp9", "hevc", "av1", "vp8"],
};

export interface VideoInfo {
  width: number;
  height: number;
  /** Seconds. 0 when unknown. */
  duration: number;
  hasAudio: boolean;
  /** "mediabunny" when the browser path can read it, "ffmpeg" when only the fallback can. */
  reader: "mediabunny" | "ffmpeg";
  codec?: string;
}

export interface RunOptions {
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export async function probeVideo(file: Blob): Promise<VideoInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    await input.getFormat();
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("no video track");
    const audio = await input.getPrimaryAudioTrack();
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await input.computeDuration(),
      hasAudio: !!audio,
      reader: (await track.canDecode()) ? "mediabunny" : "ffmpeg",
      codec: track.codec ?? undefined,
    };
  } catch {
    const p = await ffmpegProbe(file);
    if (!p) throw new Error("Couldn't read this video.");
    return { ...p, reader: "ffmpeg" };
  } finally {
    input.dispose?.();
  }
}

/** Mediabunny only flips horizontally; a vertical flip is the same as a half turn plus a horizontal flip. */
function normalizeFlip(g: Geometry): Geometry {
  if (!g.flipV) return g;
  return { ...g, rotate: ((g.rotate + 180) % 360) as Rotation, flipH: !g.flipH, flipV: false };
}

const toCropRectangle = (r: Rect) => ({ left: r.x, top: r.y, width: r.width, height: r.height });

export function targetBitrate(job: VideoJob, seconds: number): number | undefined {
  if (job.rate.mode === "bitrate") return job.rate.kbps * 1000;
  if (job.rate.mode === "size" && seconds > 0) {
    const audio = job.audio === "keep" ? job.audioKbps * 1000 : 0;
    // Leave ~7% for container overhead and encoder overshoot.
    return Math.max(50_000, Math.floor((job.rate.megabytes * 8_000_000 * 0.93) / seconds - audio));
  }
  return undefined;
}

export async function processVideo(file: Blob, info: VideoInfo, job: VideoJob, opts: RunOptions = {}): Promise<EncodedFile> {
  if (job.container === "gif" || info.reader === "ffmpeg") return ffmpegVideo(file, info, job, opts);
  try {
    return await mediabunnyVideo(file, info, job, opts);
  } catch (e) {
    if (e instanceof ConversionCanceledError || opts.signal?.aborted) throw e;
    console.warn("Mediabunny failed, falling back to ffmpeg.wasm:", e);
    opts.onProgress?.({ fraction: -1, label: "Retrying with ffmpeg.wasm…" });
    return ffmpegVideo(file, info, job, opts);
  }
}

async function mediabunnyVideo(file: Blob, info: VideoInfo, job: VideoJob, opts: RunOptions): Promise<EncodedFile> {
  const container = job.container as Exclude<VideoContainer, "gif">;
  const format: OutputFormat =
    container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" })
    : container === "mov" ? new MovOutputFormat({ fastStart: "in-memory" })
    : container === "webm" ? new WebMOutputFormat()
    : new MkvOutputFormat();

  const g = normalizeFlip(planGeometry(info.width, info.height, job, true));
  const full = g.crop.x === 0 && g.crop.y === 0 && g.crop.width === info.width && g.crop.height === info.height;
  const seconds = job.trim ? job.trim.end - job.trim.start : info.duration;
  const bitrate = targetBitrate(job, seconds);
  const copy = job.rate.mode === "copy";

  const supported = format.getSupportedVideoCodecs();
  const wanted = job.codec !== "auto" && supported.includes(job.codec) ? [job.codec] : PREFERRED[container].filter((c) => supported.includes(c));
  const codec = await getFirstEncodableVideoCodec(wanted, { width: g.width, height: g.height, bitrate });
  if (!codec) throw new Error(`This browser can't encode ${wanted.join("/")} at ${g.width}×${g.height}.`);

  const quality = bitrate ? new Quality({ bitrate }) : job.rate.mode === "quality" ? new Quality(job.rate.level) : undefined;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    showWarnings: false,
    trim: job.trim ? { start: job.trim.start, end: job.trim.end } : undefined,
    video: {
      codec,
      width: g.width,
      height: g.height,
      fit: "fill",
      crop: full ? undefined : toCropRectangle(cropInTransformedSpace(g, info.width, info.height)),
      rotate: g.rotate,
      flip: g.flipH,
      allowTransformationMetadata: false,
      frameRate: job.fps > 0 ? job.fps : undefined,
      quality,
      forceTranscode: !copy,
    },
    audio:
      job.audio === "remove"
        ? { discard: true }
        : { quality: copy ? undefined : new Quality({ bitrate: job.audioKbps * 1000 }) },
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(", ");
    throw new Error(`Mediabunny can't do this conversion (${why}).`);
  }
  const onAbort = () => void conversion.cancel();
  opts.signal?.addEventListener("abort", onAbort);
  conversion.onProgress = (p) => opts.onProgress?.({ fraction: p, label: "Encoding (WebCodecs)" });
  try {
    await conversion.execute();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  const meta = VIDEO_CONTAINERS[container];
  return { bytes: new Uint8Array(target.buffer!), mime: meta.mime, ext: meta.ext, width: g.width, height: g.height, via: `Mediabunny · ${codec}` };
}
