import assert from "node:assert/strict";
import { test } from "node:test";
import { encodersFor, fileEncodeArgs, rawEncodeArgs } from "../src/nodes/ffmpeg-video.ts";

const mac = new Set(["libx264", "h264_videotoolbox", "libx265", "hevc_videotoolbox", "prores_ks", "prores_videotoolbox"]);
const linux = new Set(["libx264", "libx265", "prores_ks"]);

test("hardware first for ProRes and HEVC, software first for H.264", () => {
  assert.deepEqual(encodersFor("prores", mac).map((e) => e.name), ["prores_videotoolbox", "prores_ks"]);
  assert.deepEqual(encodersFor("hevc", mac).map((e) => e.name), ["hevc_videotoolbox", "libx265"]);
  assert.deepEqual(encodersFor("avc", mac).map((e) => e.name), ["libx264", "h264_videotoolbox"]);
});

test("without VideoToolbox only the software encoders are left", () => {
  assert.deepEqual(encodersFor("prores", linux).map((e) => e.name), ["prores_ks"]);
  assert.deepEqual(encodersFor("hevc", new Set()), []);
});

test("raw frames: rgba on stdin, sound mapped from the second input, PCM next to ProRes", () => {
  const [e] = encodersFor("prores", mac);
  const args = rawEncodeArgs({ width: 1920, height: 1080, fps: 25 }, e, "prores", "mov", "high", "hq", "sound.mp4", "out.mov");
  assert.deepEqual(args.slice(0, 13), ["-hide_banner", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-framerate", "25", "-i", "pipe:0", "-i"]);
  assert.ok(args.join(" ").includes("-map 0:v:0 -map 1:a:0? -shortest"));
  assert.ok(args.join(" ").includes("-c:v prores_videotoolbox -profile:v hq -pix_fmt yuv422p10le"));
  assert.ok(args.join(" ").includes("-c:a pcm_s16le"));
  assert.equal(args.at(-1), "out.mov");
});

test("software ProRes uses prores_ks profile numbers, 4444 keeps alpha", () => {
  const ks = encodersFor("prores", linux)[0];
  const args = rawEncodeArgs({ width: 64, height: 64, fps: 30 }, ks, "prores", "mov", "high", "4444", undefined, "out.mov").join(" ");
  assert.ok(args.includes("-c:v prores_ks -profile:v 4 -vendor apl0 -pix_fmt yuva444p10le"));
  assert.ok(!args.includes("-c:a"), "no sound without an audio file");
});

test("a file input decodes with VideoToolbox when ffmpeg has it", () => {
  const [e] = encodersFor("hevc", mac);
  const args = fileEncodeArgs("in.mov", new Set(["videotoolbox"]), e, "hevc", "mp4", "medium", "hq", 0, false, "out.mp4").join(" ");
  assert.ok(args.startsWith("-hide_banner -y -hwaccel videotoolbox -i in.mov -map 0:v:0 -c:v hevc_videotoolbox -q:v 55 -tag:v hvc1"));
  assert.ok(args.includes("-an"));
  const plain = fileEncodeArgs("in.mov", new Set(), e, "hevc", "mp4", "medium", "hq", 24, true, "out.mp4").join(" ");
  assert.ok(!plain.includes("-hwaccel"));
  assert.ok(plain.includes("-map 0:a:0? -r 24"));
  assert.ok(plain.includes("-c:a aac"));
});
