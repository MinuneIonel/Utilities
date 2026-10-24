// The heavy half of the video nodes: decoding with Mediabunny (WebCodecs) and
// encoding with Mediabunny or gifenc. Loaded on first use, so only the graph
// worker ever pulls these libraries in.
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat,
  type OutputFormat,
  type VideoCodec,
} from "mediabunny";
import { probeVideo, processVideo, type VideoInfo } from "../../../media/src/engine/video";
import { VIDEO_CONTAINERS, type QualityLevel, type VideoCodecChoice, type VideoContainer, type VideoJob } from "../../../media/src/engine/types";
import type { FrameItem, ImageValue, Params, RunContext, Value, VideoValue } from "../runtime/types";
import { PREVIEW_MAX } from "./file";
import { scaleImage } from "./image";
import { encodersFor, fileEncodeArgs, rawEncodeArgs, type Encoder, type NativeCodec, type ProresProfile } from "./ffmpeg-video";
import { lastError, nativeTools, type NativeTools, type ToolStream } from "./native";
import { CODEC_LABEL, frameImage } from "./video";

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clean = (s: unknown, d: string) => String(s || d).replace(/[\\/:*?"<>|]+/g, "-");

const infos = new WeakMap<Blob, Promise<VideoInfo>>();
/** Probing reads the container header; cached per file since every preview needs it. */
function info(blob: Blob): Promise<VideoInfo> {
  let p = infos.get(blob);
  if (!p) {
    p = probeVideo(blob);
    infos.set(blob, p);
    p.catch(() => infos.delete(blob));
  }
  return p;
}

/** Draws a decoded frame, rotation applied, no larger than maxSide. */
function sampleToImage(sample: VideoSample, maxSide = Infinity): ImageValue {
  const s = Math.min(1, maxSide / Math.max(sample.displayWidth, sample.displayHeight));
  const w = Math.max(1, Math.round(sample.displayWidth * s));
  const h = Math.max(1, Math.round(sample.displayHeight * s));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  sample.draw(g, 0, 0, w, h);
  return { kind: "image", width: w, height: h, data: g.getImageData(0, 0, w, h).data, scale: s };
}

async function openTrack(blob: Blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("This file has no video track");
  if (!(await track.canDecode())) throw new Error(`This system can't decode ${track.codec ?? "this"} video here. Convert it in Media Lab first.`);
  return { input, track };
}

/** Every frame of a video file, full size. */
async function* fileFrames(blob: Blob, signal?: AbortSignal): AsyncGenerator<FrameItem> {
  const { input, track } = await openTrack(blob);
  try {
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        if (signal?.aborted) return;
        yield { value: sampleToImage(sample), timestamp: sample.timestamp, duration: sample.duration };
      } finally {
        sample.close();
      }
    }
  } finally {
    input.dispose?.();
  }
}

async function frameAt(blob: Blob, t: number, maxSide: number): Promise<ImageValue> {
  const { input, track } = await openTrack(blob);
  try {
    const first = await track.getFirstTimestamp();
    const sample = await new VideoSampleSink(track).getSample(Math.max(first, t));
    if (!sample) throw new Error("No frame at this time");
    try {
      return sampleToImage(sample, maxSide);
    } finally {
      sample.close();
    }
  } finally {
    input.dispose?.();
  }
}

/** Whether WebCodecs can decode this file's video here. */
async function decodable(blob: Blob): Promise<boolean> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    return !!track && (await track.canDecode());
  } catch {
    return false;
  } finally {
    input.dispose?.();
  }
}

const readable = new WeakMap<Blob, Promise<Blob>>();
/**
 * Files WebCodecs can't read (AVI, WMV, old codecs) are converted once to an
 * H.264 MP4 with the desktop app's native ffmpeg.
 */
function readableCopy(blob: Blob, ctx: RunContext): Promise<Blob> {
  let p = readable.get(blob);
  if (!p) {
    p = (async () => {
      const tools = nativeTools();
      if (!tools?.ffmpeg || (await decodable(blob))) return blob;
      const name = (blob as File).name || "input.bin";
      const ext = name.includes(".") ? name.split(".").pop()!.replace(/[^a-z0-9]/gi, "") : "bin";
      const inName = `in.${ext || "bin"}`;
      ctx.progress?.(-1, "Converting with ffmpeg");
      const r = await tools.run(
        "ffmpeg",
        // VideoToolbox decodes ProRes and the like in hardware; H.264 encodes faster in software (libx264) on Apple Silicon.
        ["-hide_banner", "-y", ...(tools.hwaccels.has("videotoolbox") ? ["-hwaccel", "videotoolbox"] : []), "-i", inName, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "out.mp4"],
        { [inName]: new Uint8Array(await blob.arrayBuffer()) },
        { onProgress: (f) => ctx.progress?.(f, "Converting with ffmpeg") },
      );
      const out = r.files["out.mp4"];
      if (r.code !== 0 || !out) throw new Error(`ffmpeg couldn't read this video: ${lastError(r.log)}`);
      return new File([out as Uint8Array<ArrayBuffer>], name.replace(/\.[^.]+$/, "") + ".mp4", { type: "video/mp4" });
    })();
    readable.set(blob, p);
    p.catch(() => readable.delete(blob));
  }
  return p;
}

/** A video value for a file: the frame at the playhead now, every frame on demand. */
export async function videoFromBlob(source: Blob, params: Params, ctx: RunContext): Promise<VideoValue> {
  const blob = await readableCopy(source, ctx);
  const i = await info(blob);
  if (i.reader !== "mediabunny") throw new Error(`Toolbox can't decode ${i.codec ?? "this video"} in a browser. Open it in the desktop app, which converts it with ffmpeg.`);
  const t = (i.duration * Math.min(100, Math.max(0, num(params.at, 0)))) / 100;
  const poster = await frameAt(blob, Math.min(t, Math.max(0, i.duration - 0.05)), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
  const fps = await estimateFps(blob);
  return {
    kind: "video",
    of: "image",
    width: i.width,
    height: i.height,
    duration: i.duration,
    fps,
    poster,
    origin: blob,
    audioSource: i.hasAudio ? blob : undefined,
    frames: (signal) => fileFrames(blob, signal),
  };
}

const fpsCache = new WeakMap<Blob, Promise<number>>();
function estimateFps(blob: Blob): Promise<number> {
  let p = fpsCache.get(blob);
  if (!p) {
    p = (async () => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        const stats = await track?.computePacketStats(60);
        return stats ? Math.round(stats.averagePacketRate * 100) / 100 : 0;
      } catch {
        return 0;
      } finally {
        input.dispose?.();
      }
    })();
    fpsCache.set(blob, p);
  }
  return p;
}

/**
 * A frame at exactly w × h. Most encoders need even sizes, so a frame one pixel
 * over loses its last row or column; a frame of another size (a slideshow of
 * mixed photos) is scaled to fit and centred on black.
 */
function evenFrame(img: ImageValue, w: number, h: number): Uint8ClampedArray {
  if (img.width === w && img.height === h) return img.data;
  if (img.width - w > 1 || img.height - h > 1 || img.width < w || img.height < h) {
    const s = Math.min(w / img.width, h / img.height);
    const fit = scaleImage(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), true);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    const x0 = Math.floor((w - fit.width) / 2);
    const y0 = Math.floor((h - fit.height) / 2);
    for (let y = 0; y < fit.height; y++) out.set(fit.data.subarray(y * fit.width * 4, (y + 1) * fit.width * 4), ((y0 + y) * w + x0) * 4);
    return out;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const rows = Math.min(h, img.height);
  const cols = Math.min(w, img.width) * 4;
  for (let y = 0; y < rows; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + cols), y * w * 4);
  return out;
}

const PREFERRED: Record<Exclude<VideoContainer, "gif">, VideoCodec[]> = {
  mp4: ["avc", "hevc", "av1", "vp9"],
  mov: ["avc", "hevc", "av1", "vp9"],
  webm: ["vp9", "av1", "vp8"],
  mkv: ["avc", "vp9", "hevc", "av1", "vp8"],
};

const formatFor = (c: Exclude<VideoContainer, "gif">): OutputFormat =>
  c === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" })
  : c === "mov" ? new MovOutputFormat({ fastStart: "in-memory" })
  : c === "webm" ? new WebMOutputFormat()
  : new MkvOutputFormat();

/** Keeps frames at most `fps` per second (0 keeps them all). */
async function* paced(frames: AsyncIterable<FrameItem>, fps: number): AsyncGenerator<FrameItem> {
  let next = -Infinity;
  let first: number | undefined;
  for await (const f of frames) {
    first ??= f.timestamp;
    const t = f.timestamp - first;
    if (fps > 0) {
      if (t + 1e-6 < next) continue;
      next = (next === -Infinity ? 0 : next) + 1 / fps;
      yield { ...f, timestamp: t, duration: 1 / fps };
    } else yield { ...f, timestamp: t };
  }
}

/** The codecs to try, in order: the chosen one, or the format's preferred list. */
function codecsFor(format: OutputFormat, container: Exclude<VideoContainer, "gif">, choice: VideoCodecChoice): VideoCodec[] {
  const supported = format.getSupportedVideoCodecs();
  if (choice === "auto") return PREFERRED[container].filter((c) => supported.includes(c));
  if (!supported.includes(choice)) throw new Error(`${VIDEO_CONTAINERS[container].label} can't hold ${CODEC_LABEL[choice]}. Pick another codec or format.`);
  return [choice];
}

async function encodeStream(
  v: VideoValue,
  container: Exclude<VideoContainer, "gif">,
  choice: VideoCodecChoice,
  level: QualityLevel,
  fps: number,
  keepAudio: boolean,
  progress: ((f: number, l?: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; codec: string }> {
  const format = formatFor(container);
  const output = new Output({ format, target: new BufferTarget() });
  let video: VideoSampleSource | undefined;
  let size: { w: number; h: number } | undefined;
  let audioDone: Promise<void> = Promise.resolve();
  let codec = "";
  let last = 0;
  try {
    for await (const f of paced(v.frames(signal), fps)) {
      if (signal?.aborted) throw new Error("Cancelled");
      const img = frameImage(f.value);
      if (!video || !size) {
        // The first frame decides the size and codec.
        size = { w: Math.max(2, img.width - (img.width % 2)), h: Math.max(2, img.height - (img.height % 2)) };
        const wanted = codecsFor(format, container, choice);
        const c = await getFirstEncodableVideoCodec(wanted, { width: size.w, height: size.h });
        if (!c) throw new Error(`This system can't encode ${wanted.join("/")} at ${size.w}×${size.h}`);
        codec = c;
        video = new VideoSampleSource({ codec: c, bitrate: new Quality(level) });
        output.addVideoTrack(video, fps > 0 ? { frameRate: fps } : undefined);
        const audio = keepAudio && v.audioSource ? await audioTrackFor(v.audioSource, format, output) : undefined;
        await output.start();
        if (audio) audioDone = audio();
      }
      const sample = new VideoSample(evenFrame(img, size.w, size.h), {
        format: "RGBA",
        codedWidth: size.w,
        codedHeight: size.h,
        timestamp: f.timestamp,
        duration: f.duration || (v.fps ? 1 / v.fps : 1 / 30),
      });
      try {
        await video.add(sample);
      } finally {
        sample.close();
      }
      last = f.timestamp + (f.duration || 0);
      if (v.duration > 0) progress?.(Math.min(0.99, last / v.duration), `Encoding ${codec}`);
      else progress?.(-1, `Recording ${last.toFixed(1)} s`);
    }
    // Sources end quietly when cancelled; don't write a half file.
    if (signal?.aborted) throw new Error("Cancelled");
    if (!video) throw new Error("The video has no frames");
    await audioDone;
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  }
  return { bytes: new Uint8Array((output.target as BufferTarget).buffer!), codec };
}

/** Adds the source's sound as a track and returns the function that feeds it. */
async function audioTrackFor(source: Blob, format: OutputFormat, output: Output): Promise<(() => Promise<void>) | undefined> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(await track.canDecode())) return undefined;
  // AAC first in MP4 and MOV, since QuickTime doesn't play Opus there.
  const supported = format.getSupportedAudioCodecs();
  const order = (["aac", "opus", "mp3", "vorbis"] as const).filter((c) => supported.includes(c));
  const codec = await getFirstEncodableAudioCodec(order.length ? [...order] : supported, {
    numberOfChannels: track.numberOfChannels,
    sampleRate: track.sampleRate,
  });
  if (!codec) return undefined;
  const src = new AudioSampleSource({ codec, bitrate: 160_000 });
  output.addAudioTrack(src);
  return async () => {
    try {
      for await (const s of new AudioSampleSink(track).samples()) {
        try {
          await src.add(s);
        } finally {
          s.close();
        }
      }
    } finally {
      input.dispose?.();
    }
  };
}

async function encodeGif(v: VideoValue, fps: number, progress: ((f: number, l?: string) => void) | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  const gif = GIFEncoder();
  let n = 0;
  let size: { w: number; h: number } | undefined;
  for await (const f of paced(v.frames(signal), fps || 12)) {
    if (signal?.aborted) throw new Error("Cancelled");
    const img = frameImage(f.value);
    // Every frame takes the first one's size: GIF frames can't be larger than the image.
    size ??= { w: img.width, h: img.height };
    const data = evenFrame(img, size.w, size.h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), size.w, size.h, { palette, delay: Math.round(f.duration * 1000) });
    n++;
    if (v.duration > 0) progress?.(Math.min(0.99, f.timestamp / v.duration), `GIF frame ${n}`);
  }
  if (signal?.aborted) throw new Error("Cancelled");
  if (!n) throw new Error("The video has no frames");
  gif.finish();
  return gif.bytes();
}

/** An encoder that couldn't start or stopped with an error: the next one in line gets a go. */
class EncoderFailed extends Error {}

interface NativeJob {
  codec: NativeCodec;
  container: Exclude<VideoContainer, "gif">;
  level: QualityLevel;
  prores: ProresProfile;
  fps: number;
  audio: boolean;
}

const extOf = (b: Blob, d: string) => ((b as File).name?.split(".").pop() ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase() || d;

/** Native ffmpeg reads the file itself: no decoding in the window, and VideoToolbox decodes when it can. */
async function nativeFromFile(tools: NativeTools, origin: Blob, e: Encoder, job: NativeJob, ctx: RunContext): Promise<Uint8Array> {
  const inName = `in.${extOf(origin, "mp4")}`;
  const out = `out.${VIDEO_CONTAINERS[job.container].ext}`;
  const label = `Encoding with ${e.name}`;
  ctx.progress?.(-1, label);
  const r = await tools.run(
    "ffmpeg",
    fileEncodeArgs(inName, tools.hwaccels, e, job.codec, job.container, job.level, job.prores, job.fps, job.audio, out),
    { [inName]: new Uint8Array(await origin.arrayBuffer()) },
    { onProgress: (f) => ctx.progress?.(f, label), signal: ctx.signal },
  );
  if (ctx.signal?.aborted) throw new Error("Cancelled");
  const bytes = r.files[out];
  if (r.code !== 0 || !bytes) throw new EncoderFailed(lastError(r.log));
  return bytes;
}

/** Frames after image nodes go to native ffmpeg as raw RGBA on its stdin. */
async function nativeFromFrames(tools: NativeTools, v: VideoValue, e: Encoder, job: NativeJob, ctx: RunContext): Promise<Uint8Array> {
  const out = `out.${VIDEO_CONTAINERS[job.container].ext}`;
  const rate = job.fps > 0 ? job.fps : v.fps > 0 ? v.fps : 30;
  const files: Record<string, Uint8Array> = {};
  let audioName: string | undefined;
  if (job.audio && v.audioSource) {
    audioName = `sound.${extOf(v.audioSource, "mp4")}`;
    files[audioName] = new Uint8Array(await v.audioSource.arrayBuffer());
  }
  let stream: ToolStream | undefined;
  let size: { w: number; h: number } | undefined;
  // One frame in flight while the next is made, so producing and encoding overlap.
  let pending: Promise<void> = Promise.resolve();
  let stopped = false;
  let n = 0;
  for await (const f of paced(v.frames(ctx.signal), rate)) {
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    const img = frameImage(f.value);
    if (!stream || !size) {
      size = { w: Math.max(2, img.width - (img.width % 2)), h: Math.max(2, img.height - (img.height % 2)) };
      stream = tools.open("ffmpeg", rawEncodeArgs({ width: size.w, height: size.h, fps: rate }, e, job.codec, job.container, job.level, job.prores, audioName, out), files, { signal: ctx.signal });
      stream.done.catch(() => undefined);
    }
    const data = evenFrame(img, size.w, size.h);
    try {
      await pending;
    } catch {
      stopped = true; // ffmpeg quit; its log says why
      break;
    }
    pending = stream.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    n++;
    if (v.duration > 0) ctx.progress?.(Math.min(0.99, f.timestamp / v.duration), `${e.name}, frame ${n}`);
    else ctx.progress?.(-1, `Recording ${f.timestamp.toFixed(1)} s`);
  }
  if (!stream) throw new Error("The video has no frames");
  if (!stopped) await pending.catch(() => undefined);
  stream.end();
  const r = await stream.done;
  if (ctx.signal?.aborted) throw new Error("Cancelled");
  const bytes = r.files[out];
  if (r.code !== 0 || !bytes) throw new EncoderFailed(lastError(r.log));
  return bytes;
}

/** Tries each encoder for the codec in turn: hardware first where it's faster, software if that fails. */
async function encodeNative(tools: NativeTools, v: VideoValue, job: NativeJob, ctx: RunContext): Promise<Uint8Array> {
  const chain = encodersFor(job.codec, tools.encoders);
  if (!chain.length) throw new Error(`This ffmpeg has no ${job.codec === "prores" ? "ProRes" : CODEC_LABEL[job.codec]} encoder`);
  let error = "";
  for (const e of chain) {
    try {
      return v.origin && v.of === "image" ? await nativeFromFile(tools, v.origin, e, job, ctx) : await nativeFromFrames(tools, v, e, job, ctx);
    } catch (err) {
      if (!(err instanceof EncoderFailed)) throw err;
      error = err.message;
    }
  }
  throw new Error(`ffmpeg couldn't encode this video: ${error}`);
}

/** Encode video's Render: Media Lab's converter for untouched files, frame streaming otherwise. */
export async function encodeVideo(v: VideoValue, params: Params, ctx: RunContext): Promise<Record<string, Value>> {
  const container = (String(params.container) in VIDEO_CONTAINERS ? params.container : "mp4") as VideoContainer;
  const meta = VIDEO_CONTAINERS[container];
  const base = clean(params.name, "video");
  const fps = num(params.fps, 0);
  const level = String(params.quality || "high") as QualityLevel;
  const picked = String(params.codec || "auto");
  const file = (bytes: Uint8Array) => ({ file: { kind: "file" as const, name: `${base}.${meta.ext}`, mime: meta.mime, bytes } });
  if (container === "gif") return file(await encodeGif(v, fps, ctx.progress, ctx.signal));

  // Native ffmpeg takes ProRes (browsers can't write it), and HEVC only where WebCodecs can't encode it.
  // On a Mac, Chromium's WebCodecs HEVC already runs on VideoToolbox and measured as fast as ffmpeg's.
  const tools = nativeTools();
  const nativeHevc =
    picked === "hevc" &&
    !!tools?.ffmpeg &&
    encodersFor("hevc", tools.encoders).length > 0 &&
    !(await getFirstEncodableVideoCodec(["hevc"], { width: v.width - (v.width % 2), height: v.height - (v.height % 2) }));
  if (picked === "prores" || nativeHevc) {
    if (picked === "prores") {
      if (container !== "mov" && container !== "mkv") throw new Error("ProRes goes in a MOV (or MKV) file. Pick MOV as the format.");
      if (!tools?.ffmpeg) throw new Error("ProRes needs the desktop app, which encodes it with ffmpeg");
    }
    const prores = String(params.prores || "hq") as ProresProfile;
    const job: NativeJob = { codec: picked as NativeCodec, container, level, prores, fps, audio: params.audio !== false };
    return file(await encodeNative(tools!, v, job, ctx));
  }
  const choice = (picked in CODEC_LABEL ? picked : "auto") as VideoCodecChoice;

  codecsFor(formatFor(container), container, choice); // fails early on e.g. VP8 in MP4
  // Untouched video: Media Lab's converter copies or transcodes without a round trip through pixels.
  if (v.origin && v.of === "image") {
    const i = await info(v.origin);
    const job: VideoJob = {
      rotate: 0, flipH: false, flipV: false, resize: { mode: "none" },
      container, codec: choice, rate: { mode: "quality", level }, fps, audio: params.audio === false ? "remove" : "keep", audioKbps: 160,
    };
    const r = await processVideo(v.origin, i, job, { signal: ctx.signal, onProgress: (p) => ctx.progress?.(p.fraction, p.label) });
    return file(r.bytes);
  }
  const r = await encodeStream(v, container, choice, level, fps, params.audio !== false, ctx.progress, ctx.signal);
  return file(r.bytes);
}
