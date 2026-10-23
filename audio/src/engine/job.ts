import { FORMATS, type AudioFormat } from "./formats.ts";

/** Audio bytes going into the engine. */
export interface AudioInput {
  name: string;
  bytes: Uint8Array;
  /** Source duration in seconds, needed for fade-out and size estimates. */
  duration?: number;
}

/** Encoded audio coming out of the engine. */
export interface AudioOutput {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface TrimRange {
  /** Seconds from the start of the source. */
  start: number;
  end: number;
}

export interface AudioSettings {
  format: AudioFormat;
  /** kbps; ignored by lossless formats. 0 means the format's default. */
  bitrate: number;
  /** Hz; null keeps the source rate. */
  sampleRate: number | null;
  /** null keeps the source channel layout. */
  channels: 1 | 2 | null;
  /** null keeps the whole file. */
  trim: TrimRange | null;
  fadeIn: number;
  fadeOut: number;
  /** EBU R128 loudness normalization to -16 LUFS. */
  normalize: boolean;
  /** Gain in dB applied last. */
  gainDb: number;
}

export function defaultSettings(): AudioSettings {
  return {
    format: "mp3",
    bitrate: FORMATS.mp3.defaultBitrate,
    sampleRate: null,
    channels: null,
    trim: null,
    fadeIn: 0,
    fadeOut: 0,
    normalize: false,
    gainDb: 0,
  };
}

/** Length of the output in seconds, or undefined when the source length is unknown. */
export function outputDuration(settings: AudioSettings, sourceDuration?: number): number | undefined {
  if (settings.trim) return Math.max(0, settings.trim.end - settings.trim.start);
  return sourceDuration;
}

export function outputName(inputName: string, settings: AudioSettings): string {
  const base = inputName.replace(/\.[^./\\]+$/, "") || "audio";
  const suffix = settings.trim ? "-trim" : "";
  return `${base}${suffix}.${FORMATS[settings.format].ext}`;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * ffmpeg arguments that turn `inPath` into `outPath` with these settings.
 * Pure, so the same job runs in ffmpeg.wasm, native ffmpeg, or a test.
 */
export function buildArgs(inPath: string, outPath: string, settings: AudioSettings, sourceDuration?: number): string[] {
  const def = FORMATS[settings.format];
  const args = ["-hide_banner", "-y", "-i", inPath];

  if (settings.trim) {
    const { start, end } = settings.trim;
    if (!(end > start) || start < 0) throw new Error(`Invalid trim range ${start}–${end}`);
    // Output-side seek is sample accurate; audio decodes fast enough that it doesn't matter.
    args.push("-ss", fmt(start), "-t", fmt(end - start));
  }

  // Drop cover art and any video track; keep tags.
  args.push("-vn", "-map", "0:a:0", "-map_metadata", "0");

  const filters: string[] = [];
  const length = outputDuration(settings, sourceDuration);
  if (settings.fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fmt(settings.fadeIn)}`);
  if (settings.fadeOut > 0 && length !== undefined) {
    const d = Math.min(settings.fadeOut, length);
    filters.push(`afade=t=out:st=${fmt(Math.max(0, length - d))}:d=${fmt(d)}`);
  }
  if (settings.normalize) filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  if (settings.gainDb !== 0) filters.push(`volume=${fmt(settings.gainDb)}dB`);
  if (filters.length) args.push("-af", filters.join(","));

  // loudnorm works at 192 kHz internally, so pin a sane rate when the user kept the source rate.
  const rate = settings.sampleRate ?? (settings.normalize ? 48000 : null);
  if (rate) args.push("-ar", String(rate));
  if (settings.channels) args.push("-ac", String(settings.channels));

  args.push(...def.codecArgs(settings.bitrate || def.defaultBitrate), outPath);
  return args;
}

/** Rough output size in bytes, for the "about 3.2 MB" hint. */
export function estimateSize(settings: AudioSettings, sourceDuration?: number, sourceChannels = 2, sourceRate = 44100): number | undefined {
  const length = outputDuration(settings, sourceDuration);
  if (length === undefined) return undefined;
  const def = FORMATS[settings.format];
  if (def.lossy) return ((settings.bitrate || def.defaultBitrate) * 1000 * length) / 8;
  const ch = settings.channels ?? sourceChannels;
  const rate = settings.sampleRate ?? (settings.normalize ? 48000 : sourceRate);
  const pcm = rate * ch * 2 * length;
  return settings.format === "flac" ? pcm * 0.6 : pcm + 44;
}
