// Audio nodes: an audio file and Audio Lab's converter (ffmpeg.wasm), plus the
// waveform drawn on audio node cards.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { ALL_FORMATS, AudioSampleSink, BufferSource, Input } from "mediabunny";
import { convertAudio, defaultSettings, FORMAT_LIST, FORMATS, isAudioFormat, type AudioSettings } from "../../../audio/src/engine";
import type { AudioValue, Converter, FileValue, ImageValue, NodeDef } from "../runtime/types";

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

let ffmpeg: Promise<FFmpeg> | null = null;
/** ffmpeg.wasm (about 31 MB), loaded the first time an audio job runs. */
function getFfmpeg(): Promise<FFmpeg> {
  ffmpeg ??= (async () => {
    const ff = new FFmpeg();
    await ff.load({ coreURL, wasmURL });
    return ff;
  })().catch((err) => {
    ffmpeg = null;
    throw err;
  });
  return ffmpeg;
}

/** Stops a running job. The next one loads a fresh ffmpeg. */
function killFfmpeg() {
  ffmpeg?.then((ff) => ff.terminate()).catch(() => undefined);
  ffmpeg = null;
}

async function duration(bytes: Uint8Array): Promise<number | undefined> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    return (await input.computeDuration()) || undefined;
  } catch {
    return undefined;
  } finally {
    input.dispose?.();
  }
}

export const audioInput: NodeDef = {
  type: "input.audio",
  title: "Audio file",
  category: "input",
  description: "A sound file dropped into Toolbox (MP3, WAV, FLAC, M4A, Ogg…).",
  inputs: [],
  outputs: [{ key: "audio", label: "Audio", type: "audio" }],
  params: [],
  defaults: () => ({ assetId: "", name: "" }),
  kind: "frame",
  async run(_inputs, params, ctx) {
    const blob = ctx.assets.get(String(params.assetId));
    if (!blob) throw new Error("Drop an audio file here");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const audio: AudioValue = { kind: "audio", name: String(params.name || "audio"), mime: blob.type, bytes, duration: await duration(bytes) };
    return { audio };
  },
};

export const audioConvert: NodeDef = {
  type: "audio.convert",
  title: "Convert audio",
  category: "audio",
  description: "Audio Lab: change format, bitrate, sample rate and channels, trim, fade, normalize loudness. Runs on Render.",
  inputs: [{ key: "audio", label: "Audio", type: "audio" }],
  outputs: [{ key: "audio", label: "Audio", type: "audio" }],
  params: [
    { key: "format", label: "Format", kind: "select", options: FORMAT_LIST.map((f) => ({ value: f.id, label: f.label })) },
    { key: "bitrate", label: "Bitrate kbps (0 = default)", kind: "number", min: 0, max: 320, step: 8 },
    {
      key: "sampleRate",
      label: "Sample rate",
      kind: "select",
      options: [
        { value: "", label: "Keep" },
        ...[22050, 32000, 44100, 48000].map((r) => ({ value: String(r), label: `${r / 1000} kHz` })),
      ],
    },
    {
      key: "channels",
      label: "Channels",
      kind: "select",
      options: [
        { value: "", label: "Keep" },
        { value: "1", label: "Mono" },
        { value: "2", label: "Stereo" },
      ],
    },
    { key: "trimStart", label: "Start s", kind: "number", min: 0, max: 3600, step: 0.1 },
    { key: "trimEnd", label: "End s (0 = to the end)", kind: "number", min: 0, max: 3600, step: 0.1 },
    { key: "fadeIn", label: "Fade in s", kind: "number", min: 0, max: 30, step: 0.1 },
    { key: "fadeOut", label: "Fade out s", kind: "number", min: 0, max: 30, step: 0.1 },
    { key: "normalize", label: "Normalize loudness", kind: "toggle" },
    { key: "gainDb", label: "Gain dB", kind: "number", min: -24, max: 24, step: 0.5 },
    { key: "name", label: "File name", kind: "text" },
  ],
  defaults: () => ({
    format: "mp3", bitrate: 0, sampleRate: "", channels: "", trimStart: 0, trimEnd: 0,
    fadeIn: 0, fadeOut: 0, normalize: false, gainDb: 0, name: "",
  }),
  visible: (key, p) => key !== "bitrate" || FORMATS[isAudioFormat(String(p.format)) ? (p.format as "mp3") : "mp3"].lossy,
  kind: "job",
  async run(inputs, params, ctx) {
    const a = inputs.audio as AudioValue;
    const format = isAudioFormat(String(params.format)) ? (params.format as AudioSettings["format"]) : "mp3";
    const start = num(params.trimStart, 0);
    const end = num(params.trimEnd, 0);
    const settings: AudioSettings = {
      ...defaultSettings(),
      format,
      bitrate: num(params.bitrate, 0),
      sampleRate: params.sampleRate ? num(params.sampleRate, 44100) : null,
      channels: params.channels === "1" ? 1 : params.channels === "2" ? 2 : null,
      trim: start > 0 || end > 0 ? { start, end: end > 0 ? end : (a.duration ?? 1e6) } : null,
      fadeIn: num(params.fadeIn, 0),
      fadeOut: num(params.fadeOut, 0),
      normalize: params.normalize === true,
      gainDb: num(params.gainDb, 0),
    };
    ctx.progress?.(-1, "Loading ffmpeg…");
    const ff = await getFfmpeg();
    const onProgress = ({ progress }: { progress: number }) => ctx.progress?.(Math.min(0.99, Math.max(0, progress)), "Converting");
    const onAbort = () => killFfmpeg();
    ff.on("progress", onProgress);
    ctx.signal?.addEventListener("abort", onAbort);
    try {
      const out = await convertAudio(ff, { name: a.name, bytes: a.bytes, duration: a.duration }, settings);
      const name = params.name ? `${String(params.name).replace(/[\\/:*?"<>|]+/g, "-")}.${FORMATS[format].ext}` : out.name;
      const audio: AudioValue = { kind: "audio", name, mime: out.mime, bytes: out.bytes, duration: await duration(out.bytes) };
      return { audio };
    } catch (e) {
      if (ctx.signal?.aborted) throw new Error("Cancelled");
      throw e;
    } finally {
      ff.off("progress", onProgress);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};

export const AUDIO_CONVERTERS: Converter[] = [
  {
    from: "audio",
    to: "file",
    label: "file",
    async convert(v) {
      const a = v as AudioValue;
      const f: FileValue = { kind: "file", name: a.name, mime: a.mime || "application/octet-stream", bytes: a.bytes };
      return f;
    },
  },
];

/** A waveform picture of the sound, for node cards and the backdrop. */
export async function waveform(a: AudioValue, width = 640, height = 160): Promise<ImageValue | undefined> {
  const input = new Input({ source: new BufferSource(a.bytes), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return undefined;
    const total = (await input.computeDuration()) || 1;
    const peaks = new Float32Array(width);
    let buf = new Float32Array(0);
    for await (const s of new AudioSampleSink(track).samples()) {
      try {
        if (buf.length < s.numberOfFrames) buf = new Float32Array(s.numberOfFrames);
        s.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
        const start = s.timestamp / total;
        const per = s.duration / total / s.numberOfFrames;
        for (let i = 0; i < s.numberOfFrames; i++) {
          const x = Math.floor((start + i * per) * width);
          if (x >= 0 && x < width) peaks[x] = Math.max(peaks[x], Math.abs(buf[i]));
        }
      } finally {
        s.close();
      }
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 22;
      data[i + 1] = 24;
      data[i + 2] = 30;
      data[i + 3] = 255;
    }
    const mid = height / 2;
    // Scaled to the loudest peak, so quiet recordings still show their shape.
    let top = 0.05;
    for (const p of peaks) top = Math.max(top, p);
    for (let x = 0; x < width; x++) {
      const h = Math.max(1, Math.round(Math.min(1, peaks[x] / top) * (mid - 2)));
      for (let y = Math.floor(mid - h); y < Math.ceil(mid + h); y++) {
        const o = (y * width + x) * 4;
        data[o] = 120;
        data[o + 1] = 200;
        data[o + 2] = 160;
      }
    }
    return { kind: "image", width, height, data };
  } catch {
    return undefined;
  } finally {
    input.dispose?.();
  }
}
