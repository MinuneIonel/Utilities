// Video nodes: a video file, a webcam, Encode video and Extract audio. Frames are
// decoded with Mediabunny (WebCodecs), which works in the graph worker; that code
// lives in video-codec.ts and loads on first use, so the window never parses it.
import { VIDEO_CONTAINERS, type VideoCodecChoice, type VideoContainer } from "../../../media/src/engine/types";
import type { AudioValue, ImageValue, NodeDef, Value, VideoValue } from "../runtime/types";
import { gridToImage } from "./ascii";
import { PRORES_LABEL, type ProresProfile } from "./ffmpeg-video";
import { PREVIEW_MAX } from "./file";
import { scaleImage } from "./image";

/** Mediabunny, gifenc and Media Lab's video engine, loaded on first use. */
export const videoCodec = () => import("./video-codec");

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
    return { video: await (await videoCodec()).videoFromBlob(blob, params, ctx) };
  },
};

export const webcam: NodeDef = {
  type: "input.webcam",
  title: "Webcam",
  category: "input",
  description: "Your camera, live. Render records until you press Stop, running every frame through the nodes after it. Encode video adds the microphone's sound.",
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
    { key: "sound", label: "Record sound", kind: "toggle" },
  ],
  defaults: () => ({ resolution: "1280x720", mirror: true, sound: true }),
  kind: "frame",
  live: true,
  // Each new camera frame is a new input.
  cacheKey: (_p, ctx) => `${ctx.mode}:${ctx.cameras?.get(ctx.nodeId ?? "")?.version ?? 0}`,
  async run(_inputs, _params, ctx) {
    const feed = ctx.cameras?.get(ctx.nodeId ?? "");
    const latest = feed?.latest;
    if (!feed || !latest) throw new Error("Waiting for the camera…");
    const sound = ctx.mode === "render" ? feed.sound : undefined;
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
      soundLater: sound && (() => sound),
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

export const CODEC_LABEL: Record<VideoCodecChoice, string> = {
  auto: "Auto (best for the format)",
  avc: "H.264",
  hevc: "H.265 / HEVC",
  vp9: "VP9",
  av1: "AV1",
  vp8: "VP8",
};

export const videoEncode: NodeDef = {
  type: "video.encode",
  title: "Encode video",
  category: "video",
  description: "Writes a video (MP4, WebM, MOV, MKV) or an animated GIF on Render, streaming frame by frame. ProRes and HEVC use the Mac's hardware encoders in the desktop app. Feed it to Save file.",
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
      key: "codec",
      label: "Codec",
      kind: "select",
      options: [
        ...(Object.keys(CODEC_LABEL) as VideoCodecChoice[]).map((c) => ({ value: c, label: CODEC_LABEL[c] })),
        { value: "prores", label: "ProRes (MOV, desktop app)" },
      ],
    },
    {
      key: "prores",
      label: "ProRes flavour",
      kind: "select",
      options: (Object.keys(PRORES_LABEL) as ProresProfile[]).map((p) => ({ value: p, label: PRORES_LABEL[p] })),
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
  defaults: () => ({ container: "mp4", codec: "auto", prores: "hq", quality: "high", fps: 0, audio: true, name: "video" }),
  visible: (key, p) => {
    if (key === "prores") return p.codec === "prores" && p.container !== "gif";
    // ProRes flavours are fixed bitrates, so Quality doesn't apply.
    if (key === "quality") return p.container !== "gif" && p.codec !== "prores";
    return !(key === "audio" || key === "codec") || p.container !== "gif";
  },
  kind: "job",
  async run(inputs, params, ctx) {
    return (await videoCodec()).encodeVideo(inputs.video as VideoValue, params, ctx);
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
    return { audio: await soundOf(v.audioSource, v.duration || undefined) };
  },
};

const sounds = new WeakMap<Blob, Promise<AudioValue>>();
/**
 * A file's sound as an audio value, read once per file. Moving a video's playhead
 * re-runs everything after it; handing back the same bytes lets the waveform
 * (which decodes the whole track) come from its cache instead.
 */
export function soundOf(blob: Blob, duration?: number): Promise<AudioValue> {
  let p = sounds.get(blob);
  if (!p) {
    p = blob.arrayBuffer().then((b) => ({
      kind: "audio" as const,
      name: (blob as File).name || "video.mp4",
      mime: blob.type || "video/mp4",
      bytes: new Uint8Array(b),
      duration,
    }));
    sounds.set(blob, p);
    p.catch(() => sounds.delete(blob));
  }
  return p;
}
