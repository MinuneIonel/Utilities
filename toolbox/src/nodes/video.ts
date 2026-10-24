// Video nodes: a video file, a webcam, Encode video and Extract audio. Frames are
// decoded with Mediabunny (WebCodecs), which works in the graph worker.
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
import { probeVideo, processVideo, VIDEO_CONTAINERS, type VideoInfo } from "../../../media/src/engine/video";
import type { QualityLevel, VideoContainer, VideoJob } from "../../../media/src/engine/types";
import type { AudioValue, FrameItem, ImageValue, NodeDef, Value, VideoValue } from "../runtime/types";
import { gridToImage } from "./ascii";
import { PREVIEW_MAX } from "./file";
import { scaleImage } from "./image";

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

export const videoInput: NodeDef = {
  type: "input.video",
  title: "Video file",
  category: "input",
  description: "A video dropped into Toolbox. Image nodes wired after it run on every frame; the preview shows the frame at the playhead.",
  inputs: [],
  outputs: [{ key: "video", label: "Video", type: "video" }],
  params: [{ key: "at", label: "Preview at %", kind: "number", min: 0, max: 100, step: 0.5 }],
  defaults: () => ({ assetId: "", name: "", at: 10 }),
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  async run(_inputs, params, ctx) {
    const blob = ctx.assets.get(String(params.assetId));
    if (!blob) throw new Error("Drop a video here");
    const i = await info(blob);
    if (i.reader !== "mediabunny") throw new Error(`Toolbox can't decode ${i.codec ?? "this video"} yet. Convert it in Media Lab first.`);
    const t = (i.duration * Math.min(100, Math.max(0, num(params.at, 0)))) / 100;
    const poster = await frameAt(blob, Math.min(t, Math.max(0, i.duration - 0.05)), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
    const fps = await estimateFps(blob);
    const video: VideoValue = {
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
    return { video };
  },
};

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

export const webcam: NodeDef = {
  type: "input.webcam",
  title: "Webcam",
  category: "input",
  description: "Your camera, live. Render records until you press Stop, running every frame through the nodes after it.",
  inputs: [],
  outputs: [{ key: "video", label: "Video", type: "video" }],
  params: [
    {
      key: "resolution",
      label: "Resolution",
      kind: "select",
      options: [
        { value: "640x480", label: "640 × 480" },
        { value: "1280x720", label: "1280 × 720" },
        { value: "1920x1080", label: "1920 × 1080" },
      ],
    },
    { key: "mirror", label: "Mirror", kind: "toggle" },
  ],
  defaults: () => ({ resolution: "1280x720", mirror: true }),
  kind: "frame",
  // Each new camera frame is a new input.
  cacheKey: (_p, ctx) => `${ctx.mode}:${ctx.cameras?.get(ctx.nodeId ?? "")?.version ?? 0}`,
  async run(_inputs, _params, ctx) {
    const feed = ctx.cameras?.get(ctx.nodeId ?? "");
    const latest = feed?.latest;
    if (!feed || !latest) throw new Error("Waiting for the camera…");
    const s = Math.min(1, PREVIEW_MAX / Math.max(latest.width, latest.height));
    const poster =
      ctx.mode === "preview" && s < 1 ? { ...scaleImage(latest, Math.round(latest.width * s), Math.round(latest.height * s), true), scale: s } : latest;
    const video: VideoValue = {
      kind: "video",
      of: "image",
      width: latest.width,
      height: latest.height,
      duration: 0,
      fps: 30,
      poster,
      frames: (signal) => feed.record(signal),
    };
    return { video };
  },
};

/** A frame as an image, whatever the frames are. */
export function frameImage(v: Value): ImageValue {
  if (v.kind === "image") return v;
  if (v.kind === "grid") return gridToImage(v);
  throw new Error(`Can't encode ${v.kind} frames as video`);
}

/** Most encoders need even sizes; trims the last row or column if needed. */
function evenFrame(img: ImageValue, w: number, h: number): Uint8ClampedArray {
  if (img.width === w && img.height === h) return img.data;
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

async function encodeStream(
  v: VideoValue,
  container: Exclude<VideoContainer, "gif">,
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
        const wanted = PREFERRED[container].filter((c) => format.getSupportedVideoCodecs().includes(c));
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
  for await (const f of paced(v.frames(signal), fps || 12)) {
    if (signal?.aborted) throw new Error("Cancelled");
    const img = frameImage(f.value);
    const palette = quantize(img.data, 256);
    gif.writeFrame(applyPalette(img.data, palette), img.width, img.height, { palette, delay: Math.round(f.duration * 1000) });
    n++;
    if (v.duration > 0) progress?.(Math.min(0.99, f.timestamp / v.duration), `GIF frame ${n}`);
  }
  if (signal?.aborted) throw new Error("Cancelled");
  if (!n) throw new Error("The video has no frames");
  gif.finish();
  return gif.bytes();
}

export const videoEncode: NodeDef = {
  type: "video.encode",
  title: "Encode video",
  category: "video",
  description: "Writes a video (MP4, WebM, MOV, MKV) or an animated GIF on Render, streaming frame by frame. Feed it to Save file.",
  inputs: [{ key: "video", label: "Video", type: "video" }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [
    {
      key: "container",
      label: "Format",
      kind: "select",
      options: (Object.keys(VIDEO_CONTAINERS) as VideoContainer[]).map((c) => ({ value: c, label: VIDEO_CONTAINERS[c].label })),
    },
    {
      key: "quality",
      label: "Quality",
      kind: "select",
      options: [
        { value: "very-low", label: "Very low" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "very-high", label: "Very high" },
      ],
    },
    { key: "fps", label: "Frame rate (0 = source)", kind: "number", min: 0, max: 60, step: 1 },
    { key: "audio", label: "Keep sound", kind: "toggle" },
    { key: "name", label: "File name", kind: "text" },
  ],
  defaults: () => ({ container: "mp4", quality: "high", fps: 0, audio: true, name: "video" }),
  visible: (key, p) => !(key === "quality" || key === "audio") || p.container !== "gif",
  kind: "job",
  async run(inputs, params, ctx) {
    const v = inputs.video as VideoValue;
    const container = (String(params.container) in VIDEO_CONTAINERS ? params.container : "mp4") as VideoContainer;
    const meta = VIDEO_CONTAINERS[container];
    const base = clean(params.name, "video");
    const fps = num(params.fps, 0);
    const level = String(params.quality || "high") as QualityLevel;
    const file = (bytes: Uint8Array) => ({ file: { kind: "file" as const, name: `${base}.${meta.ext}`, mime: meta.mime, bytes } });
    if (container === "gif") return file(await encodeGif(v, fps, ctx.progress, ctx.signal));

    // Untouched video: Media Lab's converter copies or transcodes without a round trip through pixels.
    if (v.origin && v.of === "image") {
      const i = await info(v.origin);
      const job: VideoJob = {
        rotate: 0, flipH: false, flipV: false, resize: { mode: "none" },
        container, codec: "auto", rate: { mode: "quality", level }, fps, audio: params.audio === false ? "remove" : "keep", audioKbps: 160,
      };
      const r = await processVideo(v.origin, i, job, { signal: ctx.signal, onProgress: (p) => ctx.progress?.(p.fraction, p.label) });
      return file(r.bytes);
    }
    const r = await encodeStream(v, container, level, fps, params.audio !== false, ctx.progress, ctx.signal);
    return file(r.bytes);
  },
};

export const extractAudio: NodeDef = {
  type: "video.extract-audio",
  title: "Extract audio",
  category: "audio",
  description: "The sound of a video, for the audio nodes. Still there after image nodes have changed the frames.",
  inputs: [{ key: "video", label: "Video", type: "video" }],
  outputs: [{ key: "audio", label: "Audio", type: "audio" }],
  params: [],
  defaults: () => ({}),
  kind: "frame",
  async run(inputs) {
    const v = inputs.video as VideoValue;
    if (!v.audioSource) throw new Error("This video has no sound");
    const name = (v.audioSource as File).name || "video.mp4";
    const audio: AudioValue = {
      kind: "audio",
      name,
      mime: v.audioSource.type || "video/mp4",
      bytes: new Uint8Array(await v.audioSource.arrayBuffer()),
      duration: v.duration || undefined,
    };
    return { audio };
  },
};
