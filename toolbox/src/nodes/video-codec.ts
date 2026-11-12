// The heavy half of the video nodes: decoding with Mediabunny (WebCodecs) and
// encoding with Mediabunny or gifenc. Loaded on first use, so only the graph
// worker ever pulls these libraries in.
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  WebMOutputFormat,
  type OutputFormat,
  type Source,
  type StreamTargetChunk,
  type VideoCodec,
} from "mediabunny";
import { probeVideo, processVideo, type VideoInfo } from "../../../media/src/engine/video";
import { VIDEO_CONTAINERS, type QualityLevel, type VideoCodecChoice, type VideoContainer, type VideoJob } from "../../../media/src/engine/types";
import type { AudioValue, Bytes, DiskMedia, FileValue, FrameItem, FrameOptions, ImageValue, MediaFile, Params, RunContext, Value, VideoValue } from "../runtime/types";
import { flattenOnBlack, gifFrame, hasTransparency } from "./alpha";
import { asBlob, fromBytes, fromDisk, scratchUrl } from "./bytes";
import { clipNames } from "./clips";
import { PREVIEW_MAX } from "./file";
import { scaleImage } from "./image";
import { audioArgs, encodersFor, fileEncodeArgs, rawEncodeArgs, type Encoder, type NativeCodec, type ProresProfile, type TimeRange } from "./ffmpeg-video";
import { lastError, nativeTools, scratchFiles, toolFile, toolFileOf, type NativeTools, type ToolFile, type ToolStream, type KeptResult } from "./native";
import { diskMedia, isDisk, MediaCache, mediaName } from "./source";
import { CODEC_LABEL, frameImage } from "./video";

/** Hands a scratch file a node made along the way back, once nothing needs it (unless a cached result holds it). */
const discard = (d: Bytes) => {
  if (d.in === "disk") scratchFiles()?.free([d.path]);
};

/**
 * In the desktop app, a target that streams an encoder's output into the scratch folder in 4 MB
 * chunks, instead of holding the whole file in memory. Each write waits for the disk, so a slow
 * disk slows the encoder rather than filling the memory. None in a browser.
 */
async function diskTarget(name: string) {
  const s = scratchFiles();
  if (!s) return undefined;
  const file = await s.create(name);
  const writable = new WritableStream<StreamTargetChunk>({ write: (c) => file.write(c.data, c.position) });
  return { target: new StreamTarget(writable, { chunked: true, chunkSize: 4 << 20 }), file };
}

/** GIFs this long take gigabytes of memory to build and are huge to play. */
const GIF_MAX_FRAMES = 1500;
const GIF_MAX_BYTES = 1 << 30;

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clean = (s: unknown, d: string) => String(s || d).replace(/[\\/:*?"<>|]+/g, "-");

/** Mediabunny's input for a file: a Blob read in place, or a scratch file read by URL a range at a time. */
export const inputSourceFor = (f: MediaFile): Source => (isDisk(f) ? new UrlSource(f.url) : new BlobSource(f));

/** What processVideo takes: a Blob, or how to make a disk file's source. */
const processable = (f: MediaFile) => (isDisk(f) ? () => inputSourceFor(f) : f);

const infos = new MediaCache<Promise<VideoInfo>>();
/** Probing reads the container header; cached per file since every preview needs it. */
function info(f: MediaFile): Promise<VideoInfo> {
  let p = infos.get(f);
  if (!p) {
    p = isDisk(f) ? probeDisk(f) : probeVideo(f);
    infos.set(f, p);
    p.catch(() => infos.delete(f));
  }
  return p;
}

/** probeVideo for a file on disk: Mediabunny only (ffmpeg.wasm would need it in memory). */
async function probeDisk(f: DiskMedia): Promise<VideoInfo> {
  const input = new Input({ source: inputSourceFor(f), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("This file has no video track");
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await input.computeDuration(),
      hasAudio: !!(await input.getPrimaryAudioTrack()),
      reader: (await track.canDecode()) ? "mediabunny" : "ffmpeg",
      codec: track.codec ?? undefined,
    };
  } finally {
    input.dispose?.();
  }
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

async function openTrack(f: MediaFile) {
  const input = new Input({ source: inputSourceFor(f), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("This file has no video track");
  if (!(await track.canDecode())) throw new Error(`This system can't decode ${track.codec ?? "this"} video here. Convert it in Media Lab first.`);
  return { input, track };
}

/**
 * Every frame of a video file (or of `range` in it), `speed` times as fast: full size, or for
 * playback (`opts`) smaller, from a later point, and leaving out frames the player is already past.
 */
async function* fileFrames(f: MediaFile, signal?: AbortSignal, range?: TimeRange, speed = 1, opts: FrameOptions = {}): AsyncGenerator<FrameItem> {
  const { input, track } = await openTrack(f);
  const start = range?.start ?? 0;
  const from = start + Math.max(0, opts.from ?? 0) * speed;
  try {
    for await (const sample of new VideoSampleSink(track).samples(from, range?.end)) {
      try {
        if (signal?.aborted) return;
        const t = sample.timestamp - start;
        // A frame that starts just before the cut only shows from the cut on.
        if (t + sample.duration <= 0) continue;
        const at = Math.max(0, t) / speed;
        // Decoded anyway (later frames need it), but not drawn or handed on.
        if (opts.skipTo && at < opts.skipTo()) continue;
        yield { value: sampleToImage(sample, opts.maxSide), timestamp: at, duration: sample.duration / speed };
      } finally {
        sample.close();
      }
    }
  } finally {
    input.dispose?.();
  }
}

async function frameAt(f: MediaFile, t: number, maxSide: number): Promise<ImageValue> {
  const { input, track } = await openTrack(f);
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
async function decodable(f: MediaFile): Promise<boolean> {
  const input = new Input({ source: inputSourceFor(f), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    return !!track && (await track.canDecode());
  } catch {
    return false;
  } finally {
    input.dispose?.();
  }
}

const readable = new MediaCache<Promise<MediaFile>>();
/**
 * Files WebCodecs can't read (AVI, WMV, old codecs) are converted once to an H.264 MP4 with the
 * desktop app's native ffmpeg. The copy stays in the scratch folder for the session and is read
 * from there a range at a time.
 */
function readableCopy(source: MediaFile, ctx: RunContext): Promise<MediaFile> {
  let p = readable.get(source);
  if (!p) {
    p = (async () => {
      const tools = nativeTools();
      if (!tools?.ffmpeg || (await decodable(source))) return source;
      const name = mediaName(source) || "input.bin";
      const ext = name.includes(".") ? name.split(".").pop()!.replace(/[^a-z0-9]/gi, "") : "bin";
      const inName = `in.${ext || "bin"}`;
      ctx.progress?.(-1, "Converting with ffmpeg");
      const r = await tools.run(
        "ffmpeg",
        // VideoToolbox decodes ProRes and the like in hardware; H.264 encodes faster in software (libx264) on Apple Silicon.
        ["-hide_banner", "-y", ...(tools.hwaccels.has("videotoolbox") ? ["-hwaccel", "videotoolbox"] : []), "-i", inName, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "out.mp4"],
        { [inName]: await toolFile(source) },
        { onProgress: (f) => ctx.progress?.(f, "Converting with ffmpeg"), keep: true },
      );
      const out = r.files["out.mp4"];
      if (r.code !== 0 || !out) throw new Error(`ffmpeg couldn't read this video: ${lastError(r.log)}`);
      // Kept for the session, like the conversion itself.
      scratchFiles()?.hold(out.path);
      return diskMedia(out.path, out.size, name.replace(/\.[^.]+$/, "") + ".mp4", "video/mp4");
    })();
    readable.set(source, p);
    p.catch(() => readable.delete(source));
  }
  return p;
}

/** A video value for a file: the frame at the playhead now, every frame on demand. */
export async function videoFromFile(source: MediaFile, params: Params, ctx: RunContext): Promise<VideoValue> {
  const file = await readableCopy(source, ctx);
  const i = await info(file);
  if (i.reader !== "mediabunny") throw new Error(`Toolbox can't decode ${i.codec ?? "this video"} in a browser. Open it in the desktop app, which converts it with ffmpeg.`);
  // Trim: Start and End in seconds (End 0 = to the end); the playhead moves within the kept part.
  const start = Math.min(Math.max(0, num(params.start, 0)), Math.max(0, i.duration - 0.05));
  const endAt = num(params.end, 0);
  const end = endAt > start ? Math.min(endAt, i.duration) : i.duration;
  const range = start > 0.001 || end < i.duration - 0.001 ? { start, end } : undefined;
  const speed = Math.min(16, Math.max(0.1, num(params.speed, 1)));
  const t = start + ((end - start) * Math.min(100, Math.max(0, num(params.at, 0)))) / 100;
  const poster = await frameAt(file, Math.min(t, Math.max(start, end - 0.05)), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
  const fps = await estimateFps(file);
  // At another speed the frames are retimed and the sound would no longer match, so it's left out.
  const sameSpeed = Math.abs(speed - 1) < 1e-6;
  return {
    kind: "video",
    of: "image",
    width: i.width,
    height: i.height,
    duration: (end - start) / speed,
    fps: fps * speed,
    poster,
    origin: sameSpeed ? file : undefined,
    range,
    audioSource: i.hasAudio && sameSpeed ? file : undefined,
    frames: (signal, opts) => fileFrames(file, signal, range, speed, opts),
  };
}

const fpsCache = new MediaCache<Promise<number>>();
function estimateFps(f: MediaFile): Promise<number> {
  let p = fpsCache.get(f);
  if (!p) {
    p = (async () => {
      const input = new Input({ source: inputSourceFor(f), formats: ALL_FORMATS });
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
    fpsCache.set(f, p);
  }
  return p;
}

/**
 * A frame at exactly w × h. Most encoders need even sizes, so a frame one pixel
 * over loses its last row or column; a frame of another size (a slideshow of
 * mixed photos) is scaled to fit and centred: on black, or on nothing when it has
 * transparency of its own.
 */
function evenFrame(img: ImageValue, w: number, h: number): Uint8ClampedArray {
  if (img.width === w && img.height === h) return img.data;
  if (img.width - w > 1 || img.height - h > 1 || img.width < w || img.height < h) {
    const s = Math.min(w / img.width, h / img.height);
    const fit = scaleImage(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)), true);
    const out = new Uint8ClampedArray(w * h * 4);
    if (!hasTransparency(img.data)) for (let i = 3; i < out.length; i += 4) out[i] = 255;
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

/**
 * `streamed`: written to disk as it's made. MP4 and MOV then put their index at the end (the
 * in-memory fast start would hold the whole file); finishMp4 moves it to the front afterwards.
 */
const formatFor = (c: Exclude<VideoContainer, "gif">, streamed = false): OutputFormat =>
  c === "mp4" ? new Mp4OutputFormat({ fastStart: streamed ? false : "in-memory" })
  : c === "mov" ? new MovOutputFormat({ fastStart: streamed ? false : "in-memory" })
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
): Promise<{ data: Bytes; codec: string; streamed: boolean }> {
  const disk = await diskTarget(`video.${VIDEO_CONTAINERS[container].ext}`);
  const format = formatFor(container, !!disk);
  const output = new Output({ format, target: disk?.target ?? new BufferTarget() });
  let video: VideoSampleSource | undefined;
  let size: { w: number; h: number } | undefined;
  let audioDone: Promise<void> = Promise.resolve();
  let codec = "";
  let last = 0;
  let alpha = false;
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
        // WebM players show VP9/AV1 alpha; a transparent first frame keeps it for the whole video.
        alpha = container === "webm" && hasTransparency(img.data);
        video = new VideoSampleSource({ codec: c, bitrate: new Quality(level), alpha: alpha ? "keep" : "discard" });
        output.addVideoTrack(video, fps > 0 ? { frameRate: fps } : undefined);
        const audio = !keepAudio
          ? undefined
          : v.audioSource
            ? await audioTrackFor(v.audioSource, format, output, v.range)
            : v.soundLater && (await laterAudioTrack(v.soundLater, format, output));
        await output.start();
        if (audio) {
          audioDone = audio();
          // Cancelling mid-way makes the sound feed fail with "Output has been canceled"; nobody awaits it then.
          audioDone.catch(() => undefined);
        }
      }
      const even = evenFrame(img, size.w, size.h);
      const sample = new VideoSample(alpha ? even : flattenOnBlack(even), {
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
    if (disk) return { data: await disk.file.close(), codec, streamed: true };
  } catch (e) {
    await output.cancel().catch(() => undefined);
    await disk?.file.abort();
    throw e;
  }
  return { data: fromBytes(new Uint8Array((output.target as BufferTarget).buffer!)), codec, streamed: false };
}

/** The audio codec for this container: AAC first in MP4 and MOV, since QuickTime doesn't play Opus there. */
async function audioCodecFor(format: OutputFormat, numberOfChannels: number, sampleRate: number) {
  const supported = format.getSupportedAudioCodecs();
  const order = (["aac", "opus", "mp3", "vorbis"] as const).filter((c) => supported.includes(c));
  return getFirstEncodableAudioCodec(order.length ? [...order] : supported, { numberOfChannels, sampleRate });
}

/** Decodes a file's sound (or the `range` of it) into an encoding track. */
async function feedSound(source: MediaFile, src: AudioSampleSource, range?: TimeRange) {
  const input = new Input({ source: inputSourceFor(source), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return;
    for await (const s of new AudioSampleSink(track).samples(range?.start, range?.end)) {
      try {
        if (range) {
          if (s.timestamp < range.start - 1e-3) continue;
          s.setTimestamp(s.timestamp - range.start);
        }
        await src.add(s);
      } finally {
        s.close();
      }
    }
  } finally {
    input.dispose?.();
  }
}

/** Adds the source's sound as a track and returns the function that feeds it. */
async function audioTrackFor(source: MediaFile, format: OutputFormat, output: Output, range?: TimeRange): Promise<(() => Promise<void>) | undefined> {
  const input = new Input({ source: inputSourceFor(source), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  const ok = !!track && (await track.canDecode());
  const codec = ok ? await audioCodecFor(format, track.numberOfChannels, track.sampleRate) : null;
  input.dispose?.();
  if (!codec) return undefined;
  const src = new AudioSampleSource({ codec, bitrate: 160_000 });
  output.addAudioTrack(src);
  return () => feedSound(source, src, range);
}

/**
 * A track for sound that arrives after the frames (a webcam's microphone).
 * The track has to exist before the file starts, so it is added now and fed at the end.
 */
async function laterAudioTrack(later: () => Promise<Blob | undefined>, format: OutputFormat, output: Output): Promise<(() => Promise<void>) | undefined> {
  const codec = await audioCodecFor(format, 1, 48000);
  if (!codec) return undefined;
  const src = new AudioSampleSource({ codec, bitrate: 128_000 });
  output.addAudioTrack(src);
  return async () => {
    const blob = await later();
    if (blob) await feedSound(blob, src);
  };
}

async function encodeGif(v: VideoValue, fps: number, progress: ((f: number, l?: string) => void) | undefined, signal?: AbortSignal): Promise<Uint8Array> {
  const gif = GIFEncoder();
  let n = 0;
  let size: { w: number; h: number } | undefined;
  for await (const f of paced(v.frames(signal), fps || 12)) {
    if (signal?.aborted) throw new Error("Cancelled");
    // gifenc builds the whole file in memory: stop before it takes gigabytes.
    if (n >= GIF_MAX_FRAMES || gif.bytesView().byteLength > GIF_MAX_BYTES) throw new Error("GIFs this long don't work well: use MP4 or WebM");
    const img = frameImage(f.value);
    // Every frame takes the first one's size: GIF frames can't be larger than the image.
    size ??= { w: img.width, h: img.height };
    const { index, palette, transparentIndex } = gifFrame(evenFrame(img, size.w, size.h), { quantize, applyPalette });
    // Every frame clears to see-through before the next, so transparent pixels never show the frame before.
    gif.writeFrame(index, size.w, size.h, {
      palette,
      delay: Math.round(f.duration * 1000),
      transparent: transparentIndex !== undefined,
      transparentIndex,
      dispose: 2,
    });
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

const extOf = (f: MediaFile, d: string) => (mediaName(f).split(".").pop() ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase() || d;

/** Native ffmpeg reads the file itself: no decoding in the window, and VideoToolbox decodes when it can. */
/** A kept tool output as a file value's bytes (it stays in the scratch folder). */
function keptFile(r: KeptResult, name: string): Bytes | undefined {
  const f = r.files[name];
  return r.code === 0 && f ? fromDisk(f.path, f.size) : undefined;
}

/** Native ffmpeg reads the file itself: no decoding in the window, and VideoToolbox decodes when it can. Its output stays on disk. */
async function nativeFromFile(tools: NativeTools, origin: MediaFile, range: TimeRange | undefined, e: Encoder, job: NativeJob, ctx: RunContext): Promise<Bytes> {
  const inName = `in.${extOf(origin, "mp4")}`;
  const out = `out.${VIDEO_CONTAINERS[job.container].ext}`;
  const label = `Encoding with ${e.name}`;
  ctx.progress?.(-1, label);
  const r = await tools.run(
    "ffmpeg",
    fileEncodeArgs(inName, tools.hwaccels, e, job.codec, job.container, job.level, job.prores, job.fps, job.audio, out, range),
    { [inName]: await toolFile(origin) },
    { onProgress: (f) => ctx.progress?.(f, label), signal: ctx.signal, keep: true },
  );
  const data = keptFile(r, out);
  if (ctx.signal?.aborted) {
    if (data) discard(data);
    throw new Error("Cancelled");
  }
  if (!data) throw new EncoderFailed(lastError(r.log));
  return data;
}

/** Frames after image nodes go to native ffmpeg as raw RGBA on its stdin; its output stays on disk. */
async function nativeFromFrames(tools: NativeTools, v: VideoValue, e: Encoder, job: NativeJob, ctx: RunContext): Promise<Bytes> {
  const out = `out.${VIDEO_CONTAINERS[job.container].ext}`;
  const rate = job.fps > 0 ? job.fps : v.fps > 0 ? v.fps : 30;
  const files: Record<string, ToolFile> = {};
  let audioName: string | undefined;
  if (job.audio && v.audioSource) {
    audioName = `sound.${extOf(v.audioSource, "mp4")}`;
    files[audioName] = await toolFile(v.audioSource);
  }
  let stream: ToolStream<KeptResult> | undefined;
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
      stream = tools.open("ffmpeg", rawEncodeArgs({ width: size.w, height: size.h, fps: rate }, e, job.codec, job.container, job.level, job.prores, audioName, out, v.range), files, { signal: ctx.signal, keep: true });
      stream.done.catch(() => undefined);
    }
    // ProRes 4444 keeps alpha; the rest drop it, so transparent pixels go black instead of showing what's under them.
    const even = evenFrame(img, size.w, size.h);
    const data = job.codec === "prores" && job.prores === "4444" ? even : flattenOnBlack(even);
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
  const video = keptFile(r, out);
  if (ctx.signal?.aborted) {
    if (video) discard(video);
    throw new Error("Cancelled");
  }
  if (!video) throw new EncoderFailed(lastError(r.log));
  const sound = job.audio && !audioName && v.soundLater ? await v.soundLater() : undefined;
  return sound ? await addSound(tools, video, out, sound, job, ctx) : video;
}

/** Puts sound that arrived after the frames (a webcam's microphone) into an encoded video, copying the picture. */
async function addSound(tools: NativeTools, video: Bytes, name: string, sound: Blob, job: NativeJob, ctx: RunContext): Promise<Bytes> {
  const soundName = `sound.${extOf(sound, "webm")}`;
  const out = `with-sound.${VIDEO_CONTAINERS[job.container].ext}`;
  const args = ["-hide_banner", "-y", "-i", name, "-i", soundName, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...audioArgs(job.codec, job.container), "-shortest", out];
  const r = await tools.run("ffmpeg", args, { [name]: toolFileOf(video), [soundName]: await toolFile(sound) }, { signal: ctx.signal, keep: true });
  const withSound = keptFile(r, out);
  // A video without its sound beats no video.
  if (!withSound) return video;
  discard(video);
  return withSound;
}

/** Tries each encoder for the codec in turn: hardware first where it's faster, software if that fails. */
async function encodeNative(tools: NativeTools, v: VideoValue, job: NativeJob, ctx: RunContext): Promise<Bytes> {
  const chain = encodersFor(job.codec, tools.encoders);
  if (!chain.length) throw new Error(`This ffmpeg has no ${job.codec === "prores" ? "ProRes" : CODEC_LABEL[job.codec]} encoder`);
  let error = "";
  for (const e of chain) {
    try {
      return v.origin && v.of === "image" ? await nativeFromFile(tools, v.origin, v.range, e, job, ctx) : await nativeFromFrames(tools, v, e, job, ctx);
    } catch (err) {
      if (!(err instanceof EncoderFailed)) throw err;
      error = err.message;
    }
  }
  throw new Error(`ffmpeg couldn't encode this video: ${error}`);
}

/** The codec of a file's sound: null without sound, undefined when it can't be read. */
async function soundCodecOf(d: Bytes): Promise<string | null | undefined> {
  // A file on disk is read through the desktop app with range requests: only its header and index.
  const input = new Input({ source: d.in === "memory" ? new BufferSource(d.bytes) : new UrlSource(scratchUrl(d.path)), formats: ALL_FORMATS });
  try {
    return (await input.getPrimaryAudioTrack())?.codec ?? null;
  } catch {
    return undefined;
  } finally {
    input.dispose?.();
  }
}

/**
 * MP4 and MOV get AAC sound: QuickTime and iPhones play Opus there as silence. WebCodecs
 * has no AAC encoder on Linux (and some Windows setups), so Mediabunny falls back to Opus;
 * the desktop app's ffmpeg then re-encodes just the sound, copying the picture.
 * A file that was `streamed` to disk has its index at the end; the same ffmpeg pass (a copy,
 * when the sound is fine) moves it to the front so the file starts playing at once.
 */
async function finishMp4(d: Bytes, container: VideoContainer, ctx: RunContext, streamed: boolean): Promise<Bytes> {
  if (container !== "mp4" && container !== "mov") return d;
  const tools = nativeTools();
  if (!tools?.ffmpeg) return d;
  const codec = await soundCodecOf(d);
  const aac = codec === "opus" || codec === "vorbis";
  if (!aac && !streamed) return d;
  const ext = VIDEO_CONTAINERS[container].ext;
  ctx.progress?.(-1, aac ? "Converting the sound to AAC" : "Finishing the file");
  const args = ["-hide_banner", "-y", "-i", `in.${ext}`, "-map", "0:v", "-map", "0:a?", "-c", "copy", ...(aac ? ["-c:a", "aac", "-b:a", "160k"] : []), "-movflags", "+faststart", `out.${ext}`];
  const files = { [`in.${ext}`]: toolFileOf(d) };
  if (d.in === "memory") {
    const r = await tools.run("ffmpeg", args, files, { signal: ctx.signal });
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    // Opus sound still beats no file.
    return r.code === 0 && r.files[`out.${ext}`] ? fromBytes(r.files[`out.${ext}`]) : d;
  }
  const r = await tools.run("ffmpeg", args, files, { signal: ctx.signal, keep: true });
  const done = keptFile(r, `out.${ext}`);
  if (ctx.signal?.aborted) {
    discard(d);
    if (done) discard(done);
    throw new Error("Cancelled");
  }
  if (!done) return d;
  discard(d);
  return done;
}

/** Encode video's Render: Media Lab's converter for untouched files, frame streaming otherwise. */
export async function encodeVideo(v: VideoValue, params: Params, ctx: RunContext): Promise<Record<string, Value>> {
  const container = (String(params.container) in VIDEO_CONTAINERS ? params.container : "mp4") as VideoContainer;
  const meta = VIDEO_CONTAINERS[container];
  const base = clean(params.name, "video");
  const fps = num(params.fps, 0);
  const level = String(params.quality || "high") as QualityLevel;
  const picked = String(params.codec || "auto");
  const file = (data: Bytes) => ({ file: { kind: "file" as const, name: `${base}.${meta.ext}`, mime: meta.mime, data } });
  if (container === "gif") return file(fromBytes(await encodeGif(v, fps, ctx.progress, ctx.signal)));

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
      trim: v.range,
    };
    // In the desktop app the file streams to disk as it's made.
    const disk = await diskTarget(`${base}.${meta.ext}`);
    let r;
    try {
      r = await processVideo(processable(v.origin), i, job, { signal: ctx.signal, onProgress: (p) => ctx.progress?.(p.fraction, p.label), target: disk && (() => disk.target) });
    } catch (e) {
      await disk?.file.abort();
      throw e;
    }
    // The ffmpeg.wasm fallback ignores the target and returns bytes.
    const streamed = !!(disk && r.streamed);
    if (disk && !streamed) await disk.file.abort();
    return file(await finishMp4(streamed ? await disk!.file.close() : fromBytes(r.bytes), container, ctx, streamed));
  }
  const r = await encodeStream(v, container, choice, level, fps, params.audio !== false, ctx.progress, ctx.signal);
  return file(await finishMp4(r.data, container, ctx, r.streamed));
}

/**
 * Split into clips for a video: one Encode video per part. An untouched file is cut
 * straight from the file; frames after image nodes are encoded once first, then cut.
 */
export async function splitVideo(v: VideoValue, ranges: (duration: number) => TimeRange[], params: Params, ctx: RunContext): Promise<FileValue[]> {
  const sourceName = mediaName(v.origin ?? v.audioSource) || undefined;
  let source: MediaFile;
  let span: TimeRange;
  let sound: MediaFile | undefined;
  /** The whole video encoded first, when it isn't needed after the cut. */
  let whole: FileValue | undefined;
  if (v.origin && v.of === "image") {
    source = v.origin;
    span = v.range ?? { start: 0, end: (await info(source)).duration };
    sound = v.audioSource;
  } else {
    const first = { ...ctx, progress: (f: number) => ctx.progress?.(Math.max(0, f) * 0.5, "Encoding the whole video first") };
    const r = await encodeVideo(v, { container: "mp4", quality: "very-high", audio: true, name: "whole" }, first);
    const f = (whole = r.file as FileValue);
    // On disk it's read where it is, a range at a time, and ffmpeg cuts it by its path.
    source = f.data.in === "disk" ? diskMedia(f.data.path, f.data.size, f.name, f.mime) : new File([await asBlob(f.data)], f.name, { type: f.mime });
    const i = await info(source);
    span = { start: 0, end: i.duration };
    sound = i.hasAudio ? source : undefined;
  }
  try {
    return await cutClips(v, source, span, sound, sourceName, ranges, params, ctx);
  } finally {
    if (whole) discard(whole.data);
  }
}

async function cutClips(
  v: VideoValue,
  source: MediaFile,
  span: TimeRange,
  sound: MediaFile | undefined,
  sourceName: string | undefined,
  ranges: (duration: number) => TimeRange[],
  params: Params,
  ctx: RunContext,
): Promise<FileValue[]> {
  const rs = ranges(span.end - span.start);
  const container = (String(params.container) in VIDEO_CONTAINERS ? params.container : "mp4") as VideoContainer;
  const base = clean(params.name, (sourceName ?? "video").replace(/\.[^.]+$/, "") || "video");
  const names = clipNames(base, rs.length, VIDEO_CONTAINERS[container].ext);
  const done = v.origin ? 0 : 0.5;
  const clips: FileValue[] = [];
  try {
    for (let n = 0; n < rs.length; n++) {
      if (ctx.signal?.aborted) throw new Error("Cancelled");
      clips.push(await cutClip(n));
    }
  } catch (e) {
    // The clips made so far are no one's now.
    for (const c of clips) discard(c.data);
    throw e;
  }
  return clips;

  async function cutClip(n: number): Promise<FileValue> {
    const range = { start: span.start + rs[n].start, end: span.start + rs[n].end };
    const clip: VideoValue = {
      ...v,
      of: "image",
      duration: range.end - range.start,
      origin: source,
      range,
      audioSource: sound,
      soundLater: undefined,
      frames: (signal, opts) => fileFrames(source, signal, range, 1, opts),
    };
    const step = { ...ctx, progress: (f: number) => ctx.progress?.(done + ((1 - done) * (n + Math.max(0, f))) / rs.length, `Clip ${n + 1} of ${rs.length}`) };
    const r = await encodeVideo(clip, { ...params, container, name: names[n].replace(/\.[^.]+$/, "") }, step);
    return r.file as FileValue;
  }
}

/**
 * A file's sound on its own (or the `range` of it), copied out without re-encoding where the
 * codec allows: a long video's sound is a few MB, where reading the whole file would be GBs.
 */
export async function soundTrack(file: MediaFile, range?: TimeRange): Promise<AudioValue> {
  const base = (mediaName(file) || "sound").replace(/\.[^.]+$/, "");
  const input = new Input({ source: inputSourceFor(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("This video has no sound");
    const webm = track.codec === "opus" || track.codec === "vorbis";
    const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({ input, output, tracks: "primary", video: { discard: true }, trim: range, showWarnings: false });
    if (!conversion.isValid) throw new Error("This video's sound can't be copied out here");
    await conversion.execute();
    const bytes = new Uint8Array((output.target as BufferTarget).buffer!);
    const duration = range ? range.end - range.start : await input.computeDuration().catch(() => undefined);
    return { kind: "audio", name: `${base}.${webm ? "webm" : "m4a"}`, mime: webm ? "audio/webm" : "audio/mp4", bytes, duration };
  } finally {
    input.dispose?.();
  }
}
