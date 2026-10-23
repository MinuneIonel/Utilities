import { FORMATS } from "./formats.ts";
import { buildArgs, outputName, type AudioInput, type AudioOutput, type AudioSettings } from "./job.ts";

/**
 * The slice of ffmpeg.wasm's FFmpeg class the engine needs. Anything with this
 * shape works: ffmpeg.wasm in a browser, or a shim over native ffmpeg in Node.
 */
export interface FfmpegLike {
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<unknown>;
  exec(args: string[]): Promise<number>;
}

let jobCounter = 0;

/** Converts, compresses, resamples and trims one audio file. */
export async function convertAudio(ff: FfmpegLike, input: AudioInput, settings: AudioSettings): Promise<AudioOutput> {
  const id = ++jobCounter;
  const inExt = /\.([a-z0-9]+)$/i.exec(input.name)?.[1] ?? "bin";
  const inPath = `in${id}.${inExt}`;
  const outPath = `out${id}.${FORMATS[settings.format].ext}`;

  await ff.writeFile(inPath, input.bytes);
  try {
    const code = await ff.exec(buildArgs(inPath, outPath, settings, input.duration));
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    const data = await ff.readFile(outPath);
    if (typeof data === "string") throw new Error("ffmpeg returned text instead of audio");
    return { name: outputName(input.name, settings), bytes: data, mime: FORMATS[settings.format].mime };
  } finally {
    await ff.deleteFile(inPath).catch(() => {});
    await ff.deleteFile(outPath).catch(() => {});
  }
}
