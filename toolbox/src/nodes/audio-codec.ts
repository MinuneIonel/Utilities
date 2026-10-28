// The heavy half of the audio nodes: ffmpeg.wasm for Convert audio, Cut audio and
// Split into clips, and Mediabunny for durations and waveforms. Loaded on first
// use, so only the graph worker pulls these libraries in.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import { ALL_FORMATS, AudioSampleSink, BufferSource, Input } from "mediabunny";
import { convertAudio, defaultSettings, FORMATS, isAudioFormat, type AudioFormat, type AudioSettings } from "../../../audio/src/engine";
import type { AudioValue, FileValue, ImageValue, Params, RunContext, Value } from "../runtime/types";
import { audioFormatOf, clipNames } from "./clips";
import type { TimeRange } from "./ffmpeg-video";
import { NativeFfmpeg, nativeTools } from "./native";

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

export async function duration(bytes: Uint8Array): Promise<number | undefined> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    return (await input.computeDuration()) || undefined;
  } catch {
    return undefined;
  } finally {
    input.dispose?.();
  }
}

const clean = (s: unknown) => String(s).replace(/[\\/:*?"<>|]+/g, "-");
const stem = (name: string) => name.replace(/\.[^./\\]+$/, "") || "audio";

/** Convert audio's Render: native ffmpeg in the desktop app, ffmpeg.wasm otherwise. */
export async function convert(a: AudioValue, params: Params, ctx: RunContext): Promise<Record<string, Value>> {
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
  return { audio: await encode(a, settings, params.name ? `${clean(params.name)}.${FORMATS[format].ext}` : undefined, ctx, "Converting") };
}

/** Cut audio's Render: keep one part of the sound, or take one out and join the rest. */
export async function cut(a: AudioValue, params: Params, ctx: RunContext): Promise<Record<string, Value>> {
  const format = isAudioFormat(String(params.format)) ? (params.format as AudioFormat) : audioFormatOf(a.name);
  const total = a.duration ?? (await duration(a.bytes));
  const start = Math.max(0, num(params.start, 0));
  const endAt = num(params.end, 0);
  const end = endAt > 0 ? (total ? Math.min(endAt, total) : endAt) : (total ?? 1e6);
  if (!(end > start)) throw new Error("End has to come after Start");
  const range = { start, end };
  const remove = params.mode === "remove";
  const settings: AudioSettings = { ...defaultSettings(), format, bitrate: 0, trim: remove ? null : range, cut: remove ? range : null };
  const name = params.name ? `${clean(params.name)}.${FORMATS[format].ext}` : `${stem(a.name)}-${remove ? "cut" : "part"}.${FORMATS[format].ext}`;
  return { audio: await encode({ ...a, duration: total }, settings, name, ctx, "Cutting") };
}

/** Split into clips for a sound: one file per part. */
export async function split(a: AudioValue, ranges: (duration: number) => TimeRange[], format: string, base: string, ctx: RunContext): Promise<FileValue[]> {
  const total = a.duration ?? (await duration(a.bytes));
  if (!total) throw new Error("This sound's length isn't known, so it can't be split");
  const fmt = isAudioFormat(format) ? format : audioFormatOf(a.name);
  const rs = ranges(total);
  const names = clipNames(base || stem(a.name), rs.length, FORMATS[fmt].ext);
  const clips: FileValue[] = [];
  for (let i = 0; i < rs.length; i++) {
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    const step = { ...ctx, progress: (f: number) => ctx.progress?.((i + Math.max(0, f)) / rs.length, `Clip ${i + 1} of ${rs.length}`) };
    const settings: AudioSettings = { ...defaultSettings(), format: fmt, bitrate: 0, trim: rs[i] };
    const out = await encode({ ...a, duration: total }, settings, names[i], step, "Cutting");
    clips.push({ kind: "file", name: out.name, mime: out.mime, bytes: out.bytes });
  }
  return clips;
}

/** Runs one Audio Lab job: native ffmpeg in the desktop app, ffmpeg.wasm otherwise. */
async function encode(a: AudioValue, settings: AudioSettings, name: string | undefined, ctx: RunContext, verb: string): Promise<AudioValue> {
  const finish = async (out: { name: string; bytes: Uint8Array; mime: string }): Promise<AudioValue> =>
    ({ kind: "audio", name: name ?? out.name, mime: out.mime, bytes: out.bytes, duration: await duration(out.bytes) });
  const input = { name: a.name, bytes: a.bytes, duration: a.duration };

  // The desktop app's native ffmpeg is several times faster and needs no 31 MB download.
  const tools = nativeTools();
  if (tools?.ffmpeg) {
    const ff = new NativeFfmpeg(tools, { onProgress: (f) => ctx.progress?.(f, `${verb} (ffmpeg)`), signal: ctx.signal });
    try {
      return await finish(await convertAudio(ff, input, settings));
    } catch (e) {
      if (ctx.signal?.aborted) throw new Error("Cancelled");
      throw e;
    }
  }

  ctx.progress?.(-1, "Loading ffmpeg…");
  const ff = await getFfmpeg();
  const onProgress = ({ progress }: { progress: number }) => ctx.progress?.(Math.min(0.99, Math.max(0, progress)), verb);
  const onAbort = () => killFfmpeg();
  ff.on("progress", onProgress);
  ctx.signal?.addEventListener("abort", onAbort);
  try {
    return await finish(await convertAudio(ff, input, settings));
  } catch (e) {
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    throw e;
  } finally {
    ff.off("progress", onProgress);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

const waveforms = new WeakMap<Uint8Array, Promise<ImageValue | undefined>>();

/** A waveform picture of the sound, for node cards and the backdrop. Drawn once per audio. */
export function waveform(a: AudioValue): Promise<ImageValue | undefined> {
  let p = waveforms.get(a.bytes);
  if (!p) {
    p = drawWaveform(a);
    waveforms.set(a.bytes, p);
  }
  return p;
}

async function drawWaveform(a: AudioValue, width = 640, height = 160): Promise<ImageValue | undefined> {
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
