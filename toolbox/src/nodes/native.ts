// Native ffmpeg and yt-dlp, as seen from the graph worker. The desktop app runs
// them in its main process; the worker reaches them through the window. In a
// browser tab there are none, and nodes fall back to ffmpeg.wasm or explain why.
import type { FfmpegLike } from "../../../audio/src/engine";
import type { Bytes, MediaFile } from "../runtime/types";

export type NativeTool = "ffmpeg" | "yt-dlp" | "sips";

export interface ToolResult {
  code: number;
  files: Record<string, Uint8Array>;
  log: string;
}

/** A tool's output file, moved into the scratch folder instead of being read (`keep: true`). */
export interface KeptFile {
  path: string;
  size: number;
}

/** A tool's result with `keep: true`: its new files stay on disk. */
export interface KeptResult {
  code: number;
  files: Record<string, KeptFile>;
  log: string;
}

/** A file for a tool's temp folder: its bytes, or (in the desktop app) where it already is on disk. */
export type ToolFile = Uint8Array | { path: string };

const paths = new WeakMap<Blob, string>();

/** Remembers where a dropped file lives, so tools can read it there instead of being sent its bytes. */
export function setLocalPath(blob: Blob, path: string) {
  paths.set(blob, path);
}

/** A file for a tool: its path on disk when known (always, for a scratch file), otherwise its bytes. */
export async function toolFile(f: MediaFile): Promise<ToolFile> {
  if (!(f instanceof Blob)) return { path: f.path };
  const p = paths.get(f);
  return p ? { path: p } : new Uint8Array(await f.arrayBuffer());
}

/** A file value's bytes for a tool: a scratch file goes by its path, with no copy. */
export const toolFileOf = (d: Bytes): ToolFile => (d.in === "disk" ? { path: d.path } : d.bytes);

export interface ToolOptions {
  onProgress?: (fraction: number, label?: string) => void;
  signal?: AbortSignal;
  /**
   * Leaves the new files on disk: they're moved into the scratch folder and come back as paths
   * (desktop app). For results that can be any size, such as videos.
   */
  keep?: boolean;
}

/** A job reading its input from stdin (raw video frames). */
export interface ToolStream<R = ToolResult> {
  /** Resolves once the process has taken the bytes; rejects if it stopped reading. */
  write(bytes: Uint8Array): Promise<void>;
  /** Closes stdin, so the process finishes. */
  end(): void;
  /** The process's result, once it exits. */
  done: Promise<R>;
}

export interface NativeTools {
  ffmpeg: boolean;
  ytdlp: boolean;
  /** macOS's image converter, which reads iPhone (HEIC) photos. */
  sips: boolean;
  /** ffmpeg's encoders and hardware decoders (h264_videotoolbox, videotoolbox, …). */
  encoders: ReadonlySet<string>;
  hwaccels: ReadonlySet<string>;
  run(tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts: ToolOptions & { keep: true }): Promise<KeptResult>;
  run(tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts?: ToolOptions): Promise<ToolResult>;
  open(tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts: ToolOptions & { keep: true }): ToolStream<KeptResult>;
  open(tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts?: ToolOptions): ToolStream;
}

let tools: NativeTools | undefined;

/** Set by the worker once the window says which tools the desktop app has. */
export function setNativeTools(t: NativeTools | undefined) {
  tools = t;
}

export const nativeTools = () => tools;

/** A file being written into the scratch folder, a chunk at a time. */
export interface ScratchWriter {
  path: string;
  /** Writes `data` at `position`; chunks may come in any order. */
  write(data: Uint8Array, position: number): Promise<void>;
  /** Finishes the file once every write is done. */
  close(): Promise<Bytes>;
  /** Stops and deletes the file (a cancelled or failed encode). */
  abort(): Promise<void>;
}

/** The desktop app's scratch folder, as the nodes see it. */
export interface ScratchFiles {
  create(name: string): Promise<ScratchWriter>;
  /** Deletes scratch files a node made along the way, unless a cached result holds them. */
  free(paths: string[]): void;
  /** Keeps a scratch file for the rest of the session (a download, a converted copy). */
  hold(path: string): void;
}

let scratch: ScratchFiles | undefined;

/** Set by the worker in the desktop app; a browser tab has no scratch folder. */
export function setScratchFiles(s: ScratchFiles | undefined) {
  scratch = s;
}

export const scratchFiles = () => scratch;

/** Gets a model file by name (downloading it once, in the desktop app); progress is -1 while unknown. */
export type ModelFetcher = (file: string, onProgress?: (fraction: number, label?: string) => void) => Promise<Uint8Array>;

let models: ModelFetcher | undefined;

/** Set by the worker in the desktop app, which keeps models in its own folder so they work offline. */
export function setModelFetcher(f: ModelFetcher | undefined) {
  models = f;
}

export const modelFetcher = () => models;

/** The last useful line of a tool's log, for error messages. */
export function lastError(log: string): string {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  // ffmpeg ends with thread bookkeeping ("Task finished with error code: -22 (Invalid argument)");
  // the line that says what was wrong with the file comes earlier.
  const line =
    lines.find((l) => /Invalid data found|moov atom not found|does not contain any stream|Unsupported codec|No such file/i.test(l)) ??
    lines.find((l) => /error/i.test(l) && !/Task finished|Terminating thread|Conversion failed/i.test(l)) ??
    lines.find((l) => /error/i.test(l)) ??
    lines[lines.length - 1] ??
    "unknown error";
  const plain = (/(?:error|return) code:? -?\d+ \((.+)\)\s*$/.exec(line)?.[1] ?? line).replace(/^(\[[^\]]*\]\s*)+/, "");
  // yt-dlp appends a bug-report plea and proxy internals; keep the part a person can act on.
  const short = plain.replace(/^ERROR:\s*/, "").split(/; please report|\(caused by/)[0].trim();
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
