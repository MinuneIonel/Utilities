import { FFmpeg } from "@ffmpeg/ffmpeg";
// Self-hosted core: the app works without reaching a CDN.
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

let instance: Promise<FFmpeg> | null = null;

/** Loads ffmpeg.wasm once (about 31 MB) and reuses it for every job. */
export function getFfmpeg(): Promise<FFmpeg> {
  instance ??= (async () => {
    const ff = new FFmpeg();
    await ff.load({ coreURL, wasmURL });
    return ff;
  })().catch((err) => {
    instance = null;
    throw err;
  });
  return instance;
}
