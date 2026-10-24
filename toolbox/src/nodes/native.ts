// Native ffmpeg and yt-dlp, as seen from the graph worker. The desktop app runs
// them in its main process; the worker reaches them through the window. In a
// browser tab there are none, and nodes fall back to ffmpeg.wasm or explain why.
import type { FfmpegLike } from "../../../audio/src/engine";

export type NativeTool = "ffmpeg" | "yt-dlp";

export interface ToolResult {
  code: number;
  files: Record<string, Uint8Array>;
  log: string;
}

export interface ToolOptions {
  onProgress?: (fraction: number, label?: string) => void;
  signal?: AbortSignal;
}

export interface NativeTools {
  ffmpeg: boolean;
  ytdlp: boolean;
  run(tool: NativeTool, args: string[], files: Record<string, Uint8Array>, opts?: ToolOptions): Promise<ToolResult>;
}

let tools: NativeTools | undefined;

/** Set by the worker once the window says which tools the desktop app has. */
export function setNativeTools(t: NativeTools | undefined) {
  tools = t;
}

export const nativeTools = () => tools;

/** The last useful line of a tool's log, for error messages. */
export function lastError(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.reverse().find((l) => /error/i.test(l)) ?? lines[0] ?? "unknown error";
  // yt-dlp appends a bug-report plea and proxy internals; keep the part a person can act on.
  const short = line.replace(/^ERROR:\s*/, "").split(/; please report|\(caused by/)[0].trim();
  return short.length > 220 ? short.slice(0, 217) + "…" : short;
}

/**
 * Audio Lab's engine talks to ffmpeg through FfmpegLike; this runs each exec
 * with native ffmpeg in a temp folder holding the files written so far.
 */
export class NativeFfmpeg implements FfmpegLike {
  private files = new Map<string, Uint8Array>();
  log = "";

  constructor(
    private t: NativeTools,
    private opts: ToolOptions = {},
  ) {}

  async writeFile(path: string, data: Uint8Array) {
    this.files.set(path, data);
  }

  async readFile(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`ffmpeg didn't write ${path}: ${lastError(this.log)}`);
    return f;
  }

  async deleteFile(path: string) {
    this.files.delete(path);
  }

  async exec(args: string[]) {
    const r = await this.t.run("ffmpeg", args, Object.fromEntries(this.files), this.opts);
    this.log = r.log;
    for (const [k, v] of Object.entries(r.files)) this.files.set(k, v);
    return r.code;
  }
}
