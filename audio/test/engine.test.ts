// Runs every engine job through native ffmpeg, so the arguments the browser
// sends to ffmpeg.wasm are checked against a real encoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT_LIST, buildArgs, convertAudio, defaultSettings, outputName, type FfmpegLike } from "../src/engine/index.ts";

const dir = mkdtempSync(join(tmpdir(), "audio-test-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const nativeFfmpeg: FfmpegLike = {
  async writeFile(p, data) { writeFileSync(join(dir, p), data); },
  async readFile(p) { return new Uint8Array(readFileSync(join(dir, p))); },
  async deleteFile(p) { rmSync(join(dir, p), { force: true }); },
  async exec(args) {
    const abs = args.map((a, i) => (args[i - 1] === "-i" || i === args.length - 1 ? join(dir, a) : a));
    try { execFileSync("ffmpeg", ["-loglevel", "error", ...abs]); return 0; } catch { return 1; }
  },
};

function probe(bytes: Uint8Array, ext: string) {
  const p = join(dir, `probe.${ext}`);
  writeFileSync(p, bytes);
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", p]);
  const j = JSON.parse(String(out));
  return { codec: j.streams[0].codec_name as string, rate: Number(j.streams[0].sample_rate), channels: Number(j.streams[0].channels), duration: Number(j.format.duration) };
}

// 10 s stereo 44.1 kHz test tone as WAV.
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10:sample_rate=44100", "-ac", "2", join(dir, "src.wav")]);
const source = { name: "tone.wav", bytes: new Uint8Array(readFileSync(join(dir, "src.wav"))), duration: 10 };

const codecs: Record<string, string> = { mp3: "mp3", m4a: "aac", opus: "opus", ogg: "vorbis", flac: "flac", wav: "pcm_s16le" };

for (const f of FORMAT_LIST) {
  test(`converts to ${f.label}`, async () => {
    const out = await convertAudio(nativeFfmpeg, source, { ...defaultSettings(), format: f.id, bitrate: f.defaultBitrate });
    assert.equal(out.name, `tone.${f.ext}`);
    const info = probe(out.bytes, f.ext);
    assert.equal(info.codec, codecs[f.id]);
    assert.ok(Math.abs(info.duration - 10) < 0.15, `duration ${info.duration}`);
  });
}

test("trims, resamples, downmixes and fades", async () => {
  const settings = { ...defaultSettings(), format: "mp3" as const, bitrate: 64, sampleRate: 22050, channels: 1 as const, trim: { start: 2.5, end: 6 }, fadeIn: 0.5, fadeOut: 1 };
  const out = await convertAudio(nativeFfmpeg, source, settings);
  assert.equal(out.name, "tone-trim.mp3");
  const info = probe(out.bytes, "mp3");
  assert.equal(info.rate, 22050);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.duration - 3.5) < 0.1, `duration ${info.duration}`);
});

test("normalizes with a fixed output rate", async () => {
  const out = await convertAudio(nativeFfmpeg, source, { ...defaultSettings(), format: "flac", normalize: true, gainDb: -3 });
  assert.equal(probe(out.bytes, "flac").rate, 48000);
});

test("rejects an empty trim range", () => {
  assert.throws(() => buildArgs("a.wav", "b.mp3", { ...defaultSettings(), trim: { start: 3, end: 3 } }));
});

test("output names keep dots in the base name", () => {
  assert.equal(outputName("my.song.v2.flac", defaultSettings()), "my.song.v2.mp3");
});

test("cuts a part out of the middle and joins the rest", async () => {
  const out = await convertAudio(nativeFfmpeg, source, { ...defaultSettings(), format: "wav", cut: { start: 2, end: 5 }, fadeOut: 1 });
  assert.equal(out.name, "tone-cut.wav");
  const info = probe(out.bytes, "wav");
  assert.ok(Math.abs(info.duration - 7) < 0.05, `duration ${info.duration}`);
});

test("cuts the start or the end off", async () => {
  const head = await convertAudio(nativeFfmpeg, source, { ...defaultSettings(), format: "flac", cut: { start: 0, end: 4 } });
  assert.ok(Math.abs(probe(head.bytes, "flac").duration - 6) < 0.05);
  const tail = await convertAudio(nativeFfmpeg, source, { ...defaultSettings(), format: "flac", cut: { start: 8, end: 10 } });
  assert.ok(Math.abs(probe(tail.bytes, "flac").duration - 8) < 0.05);
});

test("rejects a cut that takes out everything", () => {
  assert.throws(() => buildArgs("a.wav", "b.mp3", { ...defaultSettings(), cut: { start: 0, end: 10 } }, 10), /whole sound/);
});
