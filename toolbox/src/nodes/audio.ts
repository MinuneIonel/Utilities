// Audio nodes: an audio file and Audio Lab's converter (ffmpeg.wasm), plus the
// waveform drawn on audio node cards. The work happens in audio-codec.ts, loaded
// on first use.
import { FORMAT_LIST, FORMATS, isAudioFormat } from "../../../audio/src/engine";
import type { AudioValue, Converter, FileValue, NodeDef } from "../runtime/types";

/** ffmpeg.wasm, Mediabunny and Audio Lab's job builder, loaded on first use. */
export const audioCodec = () => import("./audio-codec");

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
    const audio: AudioValue = { kind: "audio", name: String(params.name || "audio"), mime: blob.type, bytes, duration: await (await audioCodec()).duration(bytes) };
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
    return (await audioCodec()).convert(inputs.audio as AudioValue, params, ctx);
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
