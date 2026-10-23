/** Output formats the engine can write, and how ffmpeg encodes each one. */
export type AudioFormat = "mp3" | "m4a" | "opus" | "ogg" | "flac" | "wav";

export interface FormatDef {
  id: AudioFormat;
  label: string;
  ext: string;
  mime: string;
  lossy: boolean;
  /** Bitrates offered in the UI, in kbps (lossy formats only). */
  bitrates: number[];
  defaultBitrate: number;
  /** Sample rates the encoder accepts natively; ffmpeg resamples to the nearest otherwise. */
  sampleRates: number[];
  /** Encoder arguments for a given bitrate in kbps. */
  codecArgs(bitrate: number): string[];
}

const COMMON_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000];

export const FORMATS: Record<AudioFormat, FormatDef> = {
  mp3: {
    id: "mp3", label: "MP3", ext: "mp3", mime: "audio/mpeg", lossy: true,
    bitrates: [64, 96, 128, 160, 192, 256, 320], defaultBitrate: 192,
    sampleRates: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
    codecArgs: (b) => ["-c:a", "libmp3lame", "-b:a", `${b}k`],
  },
  m4a: {
    id: "m4a", label: "AAC (M4A)", ext: "m4a", mime: "audio/mp4", lossy: true,
    bitrates: [64, 96, 128, 160, 192, 256, 320], defaultBitrate: 160,
    sampleRates: COMMON_RATES.concat(96000),
    codecArgs: (b) => ["-c:a", "aac", "-b:a", `${b}k`, "-movflags", "+faststart"],
  },
  opus: {
    id: "opus", label: "Opus", ext: "opus", mime: "audio/ogg; codecs=opus", lossy: true,
    bitrates: [24, 32, 48, 64, 96, 128, 160, 192, 256], defaultBitrate: 96,
    sampleRates: [8000, 12000, 16000, 24000, 48000],
    codecArgs: (b) => ["-c:a", "libopus", "-b:a", `${b}k`],
  },
  ogg: {
    id: "ogg", label: "Ogg Vorbis", ext: "ogg", mime: "audio/ogg", lossy: true,
    bitrates: [64, 96, 128, 160, 192, 256, 320], defaultBitrate: 160,
    sampleRates: COMMON_RATES.concat(96000),
    codecArgs: (b) => ["-c:a", "libvorbis", "-b:a", `${b}k`],
  },
  flac: {
    id: "flac", label: "FLAC", ext: "flac", mime: "audio/flac", lossy: false,
    bitrates: [], defaultBitrate: 0,
    sampleRates: COMMON_RATES.concat(88200, 96000, 192000),
    codecArgs: () => ["-c:a", "flac", "-compression_level", "8"],
  },
  wav: {
    id: "wav", label: "WAV", ext: "wav", mime: "audio/wav", lossy: false,
    bitrates: [], defaultBitrate: 0,
    sampleRates: COMMON_RATES.concat(88200, 96000, 192000),
    codecArgs: () => ["-c:a", "pcm_s16le"],
  },
};

export const FORMAT_LIST = Object.values(FORMATS);

export function isAudioFormat(v: string): v is AudioFormat {
  return v in FORMATS;
}
