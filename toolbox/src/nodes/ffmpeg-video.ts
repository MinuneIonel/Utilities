// Native ffmpeg video encoding: which encoder to use and its arguments. On a
// Mac the VideoToolbox encoders use the media engines in Apple Silicon. Plain
// data, no I/O, so it is tested in Node.
import type { QualityLevel } from "../../../media/src/engine/types";

export type NativeCodec = "avc" | "hevc" | "prores";
export type ProresProfile = "proxy" | "lt" | "standard" | "hq" | "4444";

export const PRORES_LABEL: Record<ProresProfile, string> = {
  proxy: "ProRes 422 Proxy",
  lt: "ProRes 422 LT",
  standard: "ProRes 422",
  hq: "ProRes 422 HQ",
  "4444": "ProRes 4444",
};

export interface Encoder {
  name: string;
  hardware: boolean;
}

/**
 * Encoders to try, best first. Measured on an M5 at 1080p: hardware ProRes is
 * about 8× faster than prores_ks and hardware HEVC about 3.7× faster than
 * libx265, but libx264 beats h264_videotoolbox, so H.264 stays in software.
 */
const ORDER: Record<NativeCodec, Encoder[]> = {
  prores: [
    { name: "prores_videotoolbox", hardware: true },
    { name: "prores_ks", hardware: false },
  ],
  hevc: [
    { name: "hevc_videotoolbox", hardware: true },
    { name: "libx265", hardware: false },
  ],
  avc: [
    { name: "libx264", hardware: false },
    { name: "h264_videotoolbox", hardware: true },
  ],
};

/** The encoders this ffmpeg has for a codec, in the order to try them. */
export function encodersFor(codec: NativeCodec, available: ReadonlySet<string>): Encoder[] {
  return ORDER[codec].filter((e) => available.has(e.name));
}

/** VideoToolbox's constant quality, 1–100. */
const VT_QUALITY: Record<QualityLevel, number> = { "very-low": 35, low: 45, medium: 55, high: 65, "very-high": 80 };
const X264_CRF: Record<QualityLevel, number> = { "very-low": 30, low: 26, medium: 23, high: 19, "very-high": 16 };
const X265_CRF: Record<QualityLevel, number> = { "very-low": 32, low: 28, medium: 25, high: 22, "very-high": 18 };
const KS_PROFILE: Record<ProresProfile, string> = { proxy: "0", lt: "1", standard: "2", hq: "3", "4444": "4" };

/** Output arguments for one encoder (everything after the inputs except the file name). */
export function encoderArgs(e: Encoder, quality: QualityLevel, prores: ProresProfile): string[] {
  // 4444 keeps alpha; the 422 flavours are 10-bit 4:2:2, the rest 8-bit 4:2:0 for players.
  const proresPix = prores === "4444" ? "yuva444p10le" : "yuv422p10le";
  switch (e.name) {
    case "prores_videotoolbox":
      return ["-c:v", e.name, "-profile:v", prores, "-pix_fmt", proresPix];
    case "prores_ks":
      return ["-c:v", e.name, "-profile:v", KS_PROFILE[prores], "-vendor", "apl0", "-pix_fmt", proresPix];
    case "hevc_videotoolbox":
      return ["-c:v", e.name, "-q:v", String(VT_QUALITY[quality]), "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
    case "libx265":
      return ["-c:v", e.name, "-preset", "fast", "-crf", String(X265_CRF[quality]), "-tag:v", "hvc1", "-pix_fmt", "yuv420p"];
    case "h264_videotoolbox":
      return ["-c:v", e.name, "-q:v", String(VT_QUALITY[quality]), "-pix_fmt", "yuv420p"];
    default:
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(X264_CRF[quality]), "-pix_fmt", "yuv420p"];
  }
}

/** Sound for each kind of file: PCM next to ProRes (what editors expect), AAC otherwise. */
export function audioArgs(codec: NativeCodec, container: string): string[] {
  if (codec === "prores" && container === "mov") return ["-c:a", "pcm_s16le"];
  return ["-c:a", "aac", "-b:a", "192k"];
}

export interface RawInput {
  width: number;
  height: number;
  fps: number;
}

/**
 * The whole command for raw RGBA frames on stdin, with the sound taken from
 * `audioFile` when there is one.
 */
export function rawEncodeArgs(input: RawInput, e: Encoder, codec: NativeCodec, container: string, quality: QualityLevel, prores: ProresProfile, audioFile: string | undefined, out: string): string[] {
  const args = ["-hide_banner", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${input.width}x${input.height}`, "-framerate", String(input.fps), "-i", "pipe:0"];
  if (audioFile) args.push("-i", audioFile, "-map", "0:v:0", "-map", "1:a:0?", "-shortest");
  args.push(...encoderArgs(e, quality, prores));
  if (audioFile) args.push(...audioArgs(codec, container));
  if (container === "mp4" || container === "mov") args.push("-movflags", "+faststart");
  args.push(out);
  return args;
}

/** The whole command for a file ffmpeg reads itself, decoding with VideoToolbox when it can. */
export function fileEncodeArgs(inName: string, hwaccels: ReadonlySet<string>, e: Encoder, codec: NativeCodec, container: string, quality: QualityLevel, prores: ProresProfile, fps: number, audio: boolean, out: string): string[] {
  const args = ["-hide_banner", "-y"];
  // ffmpeg falls back to software decoding by itself when VideoToolbox can't take the stream.
  if (hwaccels.has("videotoolbox")) args.push("-hwaccel", "videotoolbox");
  args.push("-i", inName, "-map", "0:v:0");
  if (audio) args.push("-map", "0:a:0?");
  if (fps > 0) args.push("-r", String(fps));
  args.push(...encoderArgs(e, quality, prores));
  args.push(...(audio ? audioArgs(codec, container) : ["-an"]));
  if (container === "mp4" || container === "mov") args.push("-movflags", "+faststart");
  args.push(out);
  return args;
}
