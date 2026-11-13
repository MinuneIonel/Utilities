/// <reference lib="webworker" />
// Runs graphs off the main thread. Holds the dropped files and the result cache.
import { CONVERTERS, REGISTRY } from "../nodes";
import { gridToImage } from "../nodes/ascii";
import { pruneDownloads, stopDownloads } from "../nodes/download";
import { audioCodec } from "../nodes/audio";
import { videoCodec } from "../nodes/video";
import { asBlob, fromBytes, fromDisk, READ_LIMIT, sizeOf } from "../nodes/bytes";
import type { DoneFiles } from "../folder-input";
import { folderRuns, forgetFolders, refreshFolders, relistFolders } from "../nodes/folder";
import { setFolderLister, setLocalPath, setModelFetcher, setNativeTools, setScratchFiles, type FolderAnswer, type FolderQuery, type KeptFile, type KeptResult, type NativeTool, type NativeTools, type ToolFile, type ToolOptions, type ToolResult, type ToolStream } from "../nodes/native";
import { pdfRender } from "../nodes/pdf";
import { isDisk } from "../nodes/source";
import { ResultCache, evaluate } from "./evaluate";
import { AckWindow, LATE_MS, nextAction, PlayClock } from "./pacing";
import type { Bytes, CameraFeed, FrameItem, FrameOptions, Graph, ImageValue, NodeStatus, Value, VideoValue } from "./types";

export type ToWorker =
  /** A dropped file, and where it is on disk in the desktop app. */
  | { type: "asset"; id: string; blob: Blob; path?: string }
  /** `scope` names the open graph (tab) this is: node ids are only unique within one. */
  | { type: "run"; reqId: number; mode: "preview" | "render"; graph: Graph; scope: string }
  | { type: "cancel" }
  /** Stops downloads started by pasting a link (they run during preview, where there's no Render to cancel). */
  | { type: "stop-downloads" }
  /** The window dropped what it was showing for a graph (or all of them): send every picture again, even unchanged ones. */
  | { type: "resend"; scope?: string }
  /** A graph was closed: drop what was kept for it. */
  | { type: "forget"; scope: string }
  /** A webcam frame. `t` is in seconds. */
  | { type: "cam-frame"; id: string; bitmap: ImageBitmap; t: number }
  /** Ends every webcam recording, so Render can finish the files. */
  | { type: "cam-stop" }
  /** A recording is about to start on this camera, with or without sound. */
  | { type: "cam-rec"; id: string; sound: boolean }
  /** The microphone's recording, sent after Stop (none if recording it failed). */
  | { type: "cam-audio"; id: string; blob?: Blob }
  /** Which native tools the desktop app has (none in a browser). */
  | { type: "tools"; ffmpeg: boolean; ytdlp: boolean; sips?: boolean; encoders?: string[]; hwaccels?: string[] }
  /** The files are bytes, or paths in the scratch folder when the call asked to keep them. */
  | { type: "tool-result"; callId: string; result?: { code: number; files: Record<string, Uint8Array | KeptFile>; log: string }; error?: string }
  | { type: "scratch-result"; callId: string; result?: unknown; error?: string }
  | { type: "tool-written"; writeId: number; error?: string }
  | { type: "tool-progress"; callId: string; fraction: number; label?: string }
  | { type: "folder-result"; callId: string; result?: FolderAnswer; error?: string }
  /** The window got focus back, or files were marked done: folder nodes look in their folders again. */
  | { type: "relist" }
  /** Sent first, in the desktop app only (before the first run, unlike "tools", which waits on the tools). */
  | { type: "desktop" }
  /**
   * Plays a node's output (its `port`) from `at` (0–1 of the way through): small frames paced to
   * the clock, and its sound. Render stops it.
   */
  | { type: "play"; reqId: number; graph: Graph; nodeId: string; port: string; at: number; scope: string }
  | { type: "play-stop" }
  /** The window drew a played frame. */
  | { type: "play-ack"; reqId: number }
  /**
   * What the timeline draws: the length of `base` (the value a node's times are in), with a filmstrip
   * of `source` (the video file it comes from) or the waveform of `base` if it's a sound. `whole`
   * shows all of the source's file rather than just the part it keeps. `graph` is just what feeds `base`.
   */
  | { type: "strip"; reqId: number; graph: Graph; scope: string; source: { id: string; port: string }; base: { id: string; port: string }; whole: boolean };

/** What the timeline gets: its length first, then the pictures one by one, so the strip fills in. */
export type StripMessage =
  | { type: "strip-info"; reqId: number; kind: "video" | "audio"; duration: number; fps: number; count: number }
  | { type: "strip-thumb"; reqId: number; index: number; bitmap: ImageBitmap }
  | { type: "strip-wave"; reqId: number; bitmap: ImageBitmap }
  | { type: "strip-end"; reqId: number; error?: string };

export interface SavedFile {
  name: string;
  mime: string;
  /** In memory (its buffer is handed to the window), or a path in the scratch folder the main process copies from. */
  data: Bytes;
  key?: string;
}

export interface NodeUpdate {
  type: "node";
  reqId: number;
  mode: "preview" | "render";
  /** The graph (tab) the node is in. */
  scope: string;
  id: string;
  status: NodeStatus | "running";
  ms?: number;
  error?: string;
  /** Only sent when the node's output changed since the last update. */
  bitmap?: ImageBitmap;
  size?: { width: number; height: number };
  text?: string;
  /** What a Save node writes on Render, with the cache key of what it was made from. */
  file?: SavedFile;
  /** A Save node fed a list writes several. */
  files?: SavedFile[];
  /** Name and size of a File output, for the node card. */
  fileInfo?: { name: string; bytes: number };
  /** A short description of a video, audio or document output. */
  info?: string;
  /** A waveform or page thumbnail sent after the node's update: only bitmap and size are set. */
  thumb?: boolean;
}

export interface ProgressUpdate {
  type: "progress";
  reqId: number;
  scope: string;
  id: string;
  /** 0–1, or -1 when unknown. */
  fraction: number;
  label?: string;
}

/** Asks the window to run a native tool through the desktop app. */
export type ToolRequest =
  /** `keep`: the tool's new files stay in the scratch folder and come back as paths. */
  | { type: "tool-run"; callId: string; tool: NativeTool; args: string[]; files: Record<string, ToolFile>; keep?: boolean }
  | { type: "tool-open"; callId: string; tool: NativeTool; args: string[]; files: Record<string, ToolFile>; keep?: boolean }
  | { type: "tool-write"; callId: string; writeId: number; bytes: Uint8Array }
  | { type: "tool-end"; callId: string }
  | { type: "tool-cancel"; callId: string }
  /** A model file from the desktop app's folder (downloaded there the first time). */
  | { type: "model-get"; callId: string; file: string }
  /** A file written into the scratch folder chunk by chunk (an encoded video); answered with scratch-result. */
  | { type: "scratch-call"; callId: string; op: "open"; id: string; name: string }
  | { type: "scratch-call"; callId: string; op: "write"; id: string; chunk: Uint8Array; position: number }
  | { type: "scratch-call"; callId: string; op: "close"; id: string }
  /** A folder node's folder, listed by the desktop app; answered with folder-result. */
  | { type: "folder-list"; callId: string; scope: string; nodeId: string; query: FolderQuery };

/** What playback sends the window. */
export type PlayMessage =
  /**
   * Playback started: how long the output is, whether frames follow (none for a sound), and where
   * its sound is (a Blob, or a scratch file's URL), starting `start` seconds into that file.
   */
  | { type: "play-info"; reqId: number; duration: number; frames: boolean; audio?: { blob?: Blob; url?: string; start: number } }
  /** A frame to draw now, at `t` seconds; `speed` is below 1 when the graph can't keep up. */
  | { type: "play-frame"; reqId: number; bitmap: ImageBitmap; t: number; speed: number }
  | { type: "play-end"; reqId: number; reason: "stopped" | "error"; error?: string };

export type FromWorker =
  | PlayMessage
  | StripMessage
  | NodeUpdate
  | ProgressUpdate
  | ToolRequest
  /** `folders`: after a Render, the files each folder node with "Only new files" worked on. */
  | { type: "done"; reqId: number; mode: "preview" | "render"; error?: string; folders?: { nodeId: string; done: DoneFiles }[] }
  /** Scratch files no cached result holds any more: the desktop app deletes them. */
  | { type: "scratch-free"; paths: string[] };

/** The worker's end of a webcam: the newest frame, and recordings that stream frames as they arrive. */
class Feed implements CameraFeed {
  version = 0;
  latest?: ImageValue;
  sound?: Promise<Blob | undefined>;
  private gotSound?: (b: Blob | undefined) => void;
  private listeners = new Set<(f: FrameItem | null) => void>();

  /** A new recording: with sound, encoders wait for its file after Stop. */
  expectSound(sound: boolean) {
    this.sound = sound ? new Promise((resolve) => (this.gotSound = resolve)) : undefined;
  }

  setSound(blob: Blob | undefined) {
    this.gotSound?.(blob);
    this.gotSound = undefined;
  }

  push(img: ImageValue, t: number) {
    this.latest = img;
    this.version++;
    for (const l of this.listeners) l({ value: img, timestamp: t, duration: 1 / 30 });
  }

  stop() {
    for (const l of this.listeners) l(null);
    // The window sends the sound shortly after Stop; don't let a lost message hold up the files.
    const done = this.gotSound;
    if (done) setTimeout(() => done(undefined), 10_000);
  }

  async *record(signal?: AbortSignal): AsyncGenerator<FrameItem> {
    const queue: (FrameItem | null)[] = [];
    let wake: (() => void) | undefined;
    // Frames arrive faster than slow graphs can use them; past a couple of seconds' backlog, drop them.
    const listener = (f: FrameItem | null) => {
      if (f && queue.length > 60) return;
      queue.push(f);
      wake?.();
    };
    const onAbort = () => listener(null);
    this.listeners.add(listener);
    signal?.addEventListener("abort", onAbort);
    let t0: number | undefined;
    try {
      for (;;) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = undefined;
        const f = queue.shift()!;
        if (f === null || signal?.aborted) return;
        t0 ??= f.timestamp;
        yield { ...f, timestamp: f.timestamp - t0 };
      }
    } finally {
      this.listeners.delete(listener);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

const cameras = new Map<string, Feed>();

/**
 * Marks this worker's tool and scratch-file ids. Simple view runs a second worker beside the
 * graph's, and the main process keeps both workers' calls in one table by id.
 */
const WORKER = Math.random().toString(36).slice(2, 8);

type AnyResult = ToolResult | KeptResult;
const toolCalls = new Map<string, { resolve(r: AnyResult): void; reject(e: Error): void; onProgress?(f: number, l?: string): void }>();
let toolCallN = 0;
const toolWrites = new Map<number, { resolve(): void; reject(e: Error): void }>();
let toolWriteN = 0;

/** Starts a native tool call and returns its id; the result arrives as a tool-result message. */
function callTool(kind: "tool-run" | "tool-open", tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts: ToolOptions, done: { resolve(r: AnyResult): void; reject(e: Error): void }) {
  const callId = `t${WORKER}.${++toolCallN}`;
  toolCalls.set(callId, { ...done, onProgress: opts.onProgress });
  opts.signal?.addEventListener("abort", () => post({ type: "tool-cancel", callId }), { once: true });
  post({ type: kind, callId, tool, args, files, keep: opts.keep || undefined });
  return callId;
}

const scratchCalls = new Map<string, { resolve(r: unknown): void; reject(e: Error): void }>();
let scratchN = 0;

/** One scratch-folder operation, done by the main process through the window. */
function scratchCall<T>(msg: DistributiveOmit<Extract<ToolRequest, { type: "scratch-call" }>, "type" | "callId">, transfer: Transferable[] = []): Promise<T> {
  const callId = `s${WORKER}.${++scratchN}`;
  return new Promise<T>((resolve, reject) => {
    scratchCalls.set(callId, { resolve: resolve as (r: unknown) => void, reject });
    post({ ...msg, type: "scratch-call", callId } as ToolRequest, transfer);
  });
}
const folderCalls = new Map<string, { resolve(r: FolderAnswer): void; reject(e: Error): void }>();
let folderN = 0;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A file the worker writes into the scratch folder (an encoder's output streamed to disk).
 * Writes may be in flight together; close waits for all of them first.
 */
async function createScratchFile(name: string) {
  const id = `f${WORKER}.${++scratchN}`;
  const path = await scratchCall<string>({ op: "open", id, name });
  const pending = new Set<Promise<void>>();
  let failed: Error | undefined;
  let closed = false;
  const settle = () => Promise.allSettled([...pending]);
  return {
    path,
    write(data: Uint8Array, position: number) {
      if (failed) return Promise.reject(failed);
      // Copied once and handed over: Mediabunny may reuse its buffer, and a view would otherwise send all of it.
      const chunk = data.slice();
      const p = scratchCall<void>({ op: "write", id, chunk, position }, [chunk.buffer]).catch((e: Error) => {
        failed ??= e;
        throw e;
      });
      pending.add(p);
      void p.finally(() => pending.delete(p)).catch(() => undefined);
      return p;
    },
    async close() {
      await settle();
      if (failed) throw failed;
      closed = true;
      const r = await scratchCall<{ path: string; size: number }>({ op: "close", id });
      return fromDisk(r.path, r.size);
    },
    async abort() {
      await settle();
      if (!closed) post({ type: "scratch-free", paths: [path] });
    },
  };
}

function bitmapToImage(bmp: ImageBitmap): ImageValue {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return { kind: "image", width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}

const assets = new Map<string, Blob>();
const cache = new ResultCache();
// A result on disk that no cached value holds any more (replaced by a newer render, or evicted) is deleted.
cache.onFree = (paths) => post({ type: "scratch-free", paths });
/** What each node's last update showed, keyed `scope:id`, so an unchanged picture isn't sent again. */
const sentKey = new Map<string, string>();
const forgetSent = (scope: string) => {
  for (const k of [...sentKey.keys()]) if (k.startsWith(`${scope}:`)) sentKey.delete(k);
};
let latestPreview = 0;
let renderCancelled = false;
let renderAbort = new AbortController();
let queue = Promise.resolve();

// Stopping an encode leaves Mediabunny's internal promises failing with "Output has been canceled"
// (or "Conversion was canceled"): expected after Cancel, so they don't belong in the log as errors.
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const m = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (/\b(has been|was) cancell?ed\b/i.test(m)) e.preventDefault();
});

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "asset") {
    assets.set(msg.id, msg.blob);
    if (msg.path) setLocalPath(msg.blob, msg.path);
  }
  else if (msg.type === "resend") {
    if (msg.scope === undefined) sentKey.clear();
    else forgetSent(msg.scope);
  } else if (msg.type === "forget") {
    forgetSent(msg.scope);
    cache.forget(msg.scope);
    forgetFolders(msg.scope);
  } else if (msg.type === "relist") relistFolders();
  else if (msg.type === "desktop") {
    // The desktop app lists folders for the folder nodes (through the window).
    setFolderLister(
      (scope, nodeId, query) =>
        new Promise<FolderAnswer>((resolve, reject) => {
          const callId = `d${WORKER}.${++folderN}`;
          folderCalls.set(callId, { resolve, reject });
          post({ type: "folder-list", callId, scope, nodeId, query });
        }),
    );
  }
  else if (msg.type === "folder-result") {
    const call = folderCalls.get(msg.callId);
    folderCalls.delete(msg.callId);
    if (msg.result) call?.resolve(msg.result);
    else call?.reject(new Error(msg.error ?? "Couldn't look in the folder"));
  }
  else if (msg.type === "stop-downloads") stopDownloads();
  else if (msg.type === "cancel") {
    renderCancelled = true;
    renderAbort.abort();
    for (const f of cameras.values()) f.setSound(undefined);
  } else if (msg.type === "cam-frame") {
    let feed = cameras.get(msg.id);
    if (!feed) cameras.set(msg.id, (feed = new Feed()));
    feed.push(bitmapToImage(msg.bitmap), msg.t);
  } else if (msg.type === "cam-stop") {
    for (const f of cameras.values()) f.stop();
  } else if (msg.type === "cam-rec") {
    let feed = cameras.get(msg.id);
    if (!feed) cameras.set(msg.id, (feed = new Feed()));
    feed.expectSound(msg.sound);
  } else if (msg.type === "cam-audio") {
    cameras.get(msg.id)?.setSound(msg.blob);
  } else if (msg.type === "play") {
    stopPlay();
    const s: PlaySession = { reqId: msg.reqId, abort: new AbortController(), acks: new AckWindow() };
    playing = s;
    // Waits its turn behind a preview in progress (whose results it then gets from the cache).
    queue = queue.then(() => startPlay(s, msg));
  } else if (msg.type === "strip") {
    stripAbort.abort();
    const abort = (stripAbort = new AbortController());
    // Waits for a preview in progress (whose results it then finds in the cache), without holding up the ones after it.
    void queue
      .then(() => sendStrip(msg, abort.signal))
      .then(
        () => !abort.signal.aborted && post({ type: "strip-end", reqId: msg.reqId }),
        (err) => !abort.signal.aborted && post({ type: "strip-end", reqId: msg.reqId, error: err instanceof Error ? err.message : String(err) }),
      );
  } else if (msg.type === "play-stop") {
    stopPlay();
  } else if (msg.type === "play-ack") {
    if (playing?.reqId === msg.reqId) playing.acks.acked();
  } else if (msg.type === "tools") {
    setModelFetcher(
      (file, onProgress) =>
        new Promise((resolve, reject) => {
          const callId = `t${WORKER}.${++toolCallN}`;
          toolCalls.set(callId, { resolve: (r) => resolve((r as ToolResult).files[file]), reject, onProgress });
          post({ type: "model-get", callId, file });
        }),
    );
    // Only the desktop app sends "tools", and it always has a scratch folder.
    setScratchFiles({
      create: createScratchFile,
      // Files a node made along the way; one a cached result holds stays.
      free: (paths) => {
        const unheld = paths.filter((p) => cache.refs.count(p) === 0);
        if (unheld.length) post({ type: "scratch-free", paths: unheld });
      },
      hold: (path) => cache.refs.retain([path]),
    });
    const { ffmpeg, ytdlp } = msg;
    const sips = !!msg.sips;
    setNativeTools(
      ffmpeg || ytdlp || sips
        ? {
            ffmpeg,
            ytdlp,
            sips,
            encoders: new Set(msg.encoders ?? []),
            hwaccels: new Set(msg.hwaccels ?? []),
            // With keep, the result's files are paths in the scratch folder (see NativeTools' overloads).
            run: ((tool, args, files, opts = {}) =>
              new Promise<AnyResult>((resolve, reject) => void callTool("tool-run", tool, args, files, opts, { resolve, reject }))) as NativeTools["run"],
            open: ((tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts: ToolOptions = {}): ToolStream<AnyResult> => {
              let callId = "";
              const done = new Promise<AnyResult>((resolve, reject) => (callId = callTool("tool-open", tool, args, files, opts, { resolve, reject })));
              return {
                done,
                // Each frame is copied on its way to the main process, so the caller's buffer stays usable.
                write: (bytes) =>
                  new Promise<void>((resolve, reject) => {
                    const writeId = ++toolWriteN;
                    toolWrites.set(writeId, { resolve, reject });
                    post({ type: "tool-write", callId, writeId, bytes });
                  }),
                end: () => post({ type: "tool-end", callId }),
              };
            }) as NativeTools["open"],
          }
        : undefined,
    );
  } else if (msg.type === "scratch-result") {
    const call = scratchCalls.get(msg.callId);
    scratchCalls.delete(msg.callId);
    if (msg.error) call?.reject(new Error(msg.error));
    else call?.resolve(msg.result);
  } else if (msg.type === "tool-result") {
    const call = toolCalls.get(msg.callId);
    toolCalls.delete(msg.callId);
    if (msg.result) call?.resolve(msg.result as AnyResult);
    else call?.reject(new Error(msg.error ?? "The tool failed"));
  } else if (msg.type === "tool-written") {
    const w = toolWrites.get(msg.writeId);
    toolWrites.delete(msg.writeId);
    if (msg.error) w?.reject(new Error(msg.error));
    else w?.resolve();
  } else if (msg.type === "tool-progress") {
    toolCalls.get(msg.callId)?.onProgress?.(msg.fraction, msg.label);
  } else {
    if (msg.mode === "preview") {
      latestPreview = msg.reqId;
      // The preview in progress may be waiting on a download of a link that has since changed.
      pruneDownloads(msg.graph);
    }
    else {
      // Render needs the whole computer. (The window stops playback itself when the graph changes:
      // a webcam elsewhere in the graph asks for previews all the time without changing anything.)
      stopPlay();
      renderCancelled = false;
      renderAbort = new AbortController();
    }
    queue = queue.then(() => run(msg.reqId, msg.mode, msg.graph, msg.scope));
  }
};

/** Longest side of played frames: small enough to keep up, big enough to judge the look. */
const PLAY_MAX = 960;

interface PlaySession {
  reqId: number;
  abort: AbortController;
  acks: AckWindow;
}
let playing: PlaySession | undefined;

function stopPlay() {
  const s = playing;
  if (!s) return;
  playing = undefined;
  s.abort.abort();
  post({ type: "play-end", reqId: s.reqId, reason: "stopped" });
}

function endPlay(s: PlaySession, err: unknown) {
  if (playing !== s) return;
  playing = undefined;
  s.abort.abort();
  post({ type: "play-end", reqId: s.reqId, reason: "error", error: err instanceof Error ? err.message : String(err) });
}

async function startPlay(s: PlaySession, msg: Extract<ToWorker, { type: "play" }>) {
  if (playing !== s) return;
  let value: Value | undefined;
  try {
    // The preview that just ran left everything in the cache, so this is quick.
    const results = await evaluate(msg.graph, { registry: REGISTRY, ctx: { mode: "preview", assets, cameras, scope: msg.scope }, cache, converters: CONVERTERS, scope: msg.scope, cancelled: () => playing !== s });
    const r = results.get(msg.nodeId);
    value = r?.outputs[msg.port] ?? Object.values(r?.outputs ?? {})[0];
    if (!value) throw new Error(r?.error ?? "Nothing to play yet");
  } catch (err) {
    return endPlay(s, err);
  }
  // Not awaited: frames keep coming while previews and Render queue up as usual (and stop this).
  void playValue(s, value, msg.at).catch((err) => endPlay(s, err));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

async function frameBitmap(v: Value): Promise<ImageBitmap> {
  const img = v.kind === "grid" ? gridToImage(v) : v;
  if (img.kind !== "image") throw new Error("Only pictures can play");
  return createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
}

/** Streams a video's frames to the window in time (looping), or hands it a sound to play. */
async function playValue(s: PlaySession, v: Value, at: number) {
  const { reqId } = s;
  const signal = s.abort.signal;
  if (v.kind === "audio") {
    // The window plays the sound itself; this session just waits to be stopped.
    post({ type: "play-info", reqId, duration: v.duration ?? 0, frames: false, audio: { blob: new Blob([v.bytes as Uint8Array<ArrayBuffer>], { type: v.mime }), start: 0 } });
    return;
  }
  if (v.kind !== "video" || (v.of !== "image" && v.of !== "grid")) throw new Error("Only videos and sound can play");
  if (!(v.duration > 0)) throw new Error("This is live already");
  const video: VideoValue = v;
  const src = video.audioSource;
  // A file on disk plays straight from the scratch folder; a dropped file's Blob is cheap to hand over.
  const audio = src && { ...(isDisk(src) ? { url: src.url } : { blob: src }), start: video.range?.start ?? 0 };
  post({ type: "play-info", reqId, duration: video.duration, frames: true, audio });
  let from = at >= 0.995 ? 0 : Math.max(0, at) * video.duration;
  let prev: PlayClock | undefined;
  for (;;) {
    const clock = new PlayClock(from, video.fps, prev);
    prev = clock;
    const opts: FrameOptions = { maxSide: PLAY_MAX, from, skipTo: () => clock.skipTo(performance.now()) };
    let count = 0;
    let lastPost = performance.now();
    let lastShown = lastPost;
    for await (const f of video.frames(signal, opts)) {
      if (signal.aborted) return;
      count++;
      const got = performance.now();
      if (!clock.started) clock.start(got, f.timestamp);
      const act = nextAction(clock.at(got) * 1000, f.timestamp * 1000, LATE_MS, got - lastShown);
      if (act === "skip") continue;
      if (act === "wait") await sleep(clock.until(got, f.timestamp), signal);
      // At most MAX_UNACKED frames wait for the window, so bitmaps never pile up.
      const waitFrom = performance.now();
      await s.acks.ready(signal);
      const ackMs = performance.now() - waitFrom;
      const bitmap = await frameBitmap(f.value);
      if (signal.aborted) return bitmap.close();
      post({ type: "play-frame", reqId, bitmap, t: f.timestamp, speed: clock.rate }, [bitmap]);
      s.acks.sent();
      const now = performance.now();
      clock.shown(now, got - lastPost + ackMs);
      lastPost = lastShown = now;
    }
    if (signal.aborted) return;
    if (!count && !from) throw new Error("No frames to play");
    // Round again from the start.
    from = 0;
  }
}

/** Pictures in the timeline's filmstrip: enough to tell the scenes apart, few enough to decode in a moment. */
const STRIP_THUMBS = 24;
let stripAbort = new AbortController();

const imageBitmap = (img: ImageValue) => createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));

async function sendStrip(msg: Extract<ToWorker, { type: "strip" }>, signal: AbortSignal) {
  const { reqId } = msg;
  const ctx = { mode: "preview" as const, assets, cameras };
  // The preview that ran before left these in the cache, so this is quick.
  const results = await evaluate(msg.graph, { registry: REGISTRY, ctx, cache, converters: CONVERTERS, scope: msg.scope, cancelled: () => signal.aborted });
  if (signal.aborted) return;
  const output = (p: { id: string; port: string }) => {
    const r = results.get(p.id);
    return { value: r?.outputs[p.port], error: r?.error };
  };
  const base = output(msg.base);
  if (!base.value) throw new Error(base.error ?? "Nothing to show yet");
  if (base.value.kind === "audio") {
    const a = base.value;
    const codec = await audioCodec();
    const duration = a.duration ?? (await codec.duration(a.bytes)) ?? 0;
    post({ type: "strip-info", reqId, kind: "audio", duration, fps: 0, count: 0 });
    const img = await codec.waveform(a, 2000, 96);
    if (!img || signal.aborted) return;
    const bitmap = await imageBitmap(img);
    post({ type: "strip-wave", reqId, bitmap }, [bitmap]);
    return;
  }
  if (base.value.kind !== "video") throw new Error("Only videos and sounds have a timeline");
  const src = output(msg.source).value;
  if (src?.kind !== "video") throw new Error("Nothing to show yet");
  const codec = await videoCodec();
  let file = src.origin ?? src.audioSource;
  // At another speed the value keeps no file of its own: the Video file node's file is still it.
  const node = msg.graph.nodes.find((n) => n.id === msg.source.id);
  const asset = node?.type === "input.video" ? assets.get(String(node.params.assetId)) : undefined;
  if (!file && asset) file = await codec.readableFile(asset, ctx);
  const timing = file ? await codec.fileTiming(file) : { duration: src.duration, fps: src.fps };
  // The whole file, in its own seconds; or the part the source keeps, from 0.
  const from = msg.whole ? 0 : (src.range?.start ?? 0);
  const span = msg.whole ? timing.duration : src.range ? src.range.end - src.range.start : timing.duration;
  const duration = msg.whole ? timing.duration : base.value.duration;
  post({ type: "strip-info", reqId, kind: "video", duration, fps: timing.fps || src.fps, count: file ? STRIP_THUMBS : 0 });
  if (!file || !(span > 0)) return;
  const sends: Promise<void>[] = [];
  await codec.stripFor(
    file,
    from,
    span,
    STRIP_THUMBS,
    (index, img) =>
      void sends.push(
        imageBitmap(img).then((bitmap) => (signal.aborted ? bitmap.close() : post({ type: "strip-thumb", reqId, index, bitmap }, [bitmap]))),
      ),
    signal,
  );
  await Promise.all(sends);
}

async function run(reqId: number, mode: "preview" | "render", graph: Graph, scope: string) {
  // A newer preview makes this one pointless; a render only stops when asked to.
  const cancelled = () => (mode === "preview" ? reqId !== latestPreview : renderCancelled);
  if (cancelled()) return post({ type: "done", reqId, mode });
  const pending: Promise<void>[] = [];
  const lastProgress = new Map<string, number>();
  try {
    // What's in the folders a graph reads from is part of its cache keys, so it's looked at first.
    await refreshFolders(graph, scope, mode === "render");
    const results = await evaluate(graph, {
      registry: REGISTRY,
      ctx: { mode, assets, cameras, scope, signal: mode === "render" ? renderAbort.signal : undefined },
      cache,
      converters: CONVERTERS,
      cancelled,
      scope,
      // Previews are quick and constant with a webcam; only Render shows nodes as running.
      onStart: (id) => mode === "render" && post({ type: "node", reqId, mode, scope, id, status: "running" }),
      onProgress: (id, fraction, label) => {
        // At most ten updates a second per node.
        const now = Date.now();
        if (now - (lastProgress.get(id) ?? 0) < 100) return;
        lastProgress.set(id, now);
        post({ type: "progress", reqId, scope, id, fraction, label });
      },
      onNode: (id, r) => {
        const saves = !!REGISTRY.get(graph.nodes.find((n) => n.id === id)?.type ?? "")?.saves;
        pending.push(report(reqId, mode, scope, id, saves, r.status, r.outputs, r.key, r.ms, r.error));
      },
    });
    await Promise.all(pending);
    const stopped = cancelled() && mode === "render";
    const folders = mode === "render" && !stopped ? folderRuns(graph, scope, results) : [];
    post({ type: "done", reqId, mode, error: stopped ? "Render cancelled" : undefined, ...(folders.length ? { folders } : {}) });
  } catch (err) {
    await Promise.all(pending);
    post({ type: "done", reqId, mode, error: err instanceof Error ? err.message : String(err) });
  }
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function report(
  reqId: number,
  mode: "preview" | "render",
  scope: string,
  id: string,
  saves: boolean,
  status: NodeStatus,
  outputs: Record<string, Value>,
  key: string | undefined,
  ms: number | undefined,
  error: string | undefined,
) {
  const msg: NodeUpdate = { type: "node", reqId, mode, scope, id, status, ms, error };
  const transfer: Transferable[] = [];
  let first: Value | undefined = Object.values(outputs)[0];
  const sent = `${scope}:${id}`;
  const changed = key !== undefined && sentKey.get(sent) !== key;
  if (key === undefined) sentKey.delete(sent);
  else sentKey.set(sent, key);
  const sendImage = async (img: ImageValue) => {
    msg.size = { width: img.width, height: img.height };
    if (changed) {
      msg.bitmap = await createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
      transfer.push(msg.bitmap);
    }
  };
  /**
   * Waveforms and PDF thumbnails can take seconds (a long file decodes in full), so
   * they follow in a second update instead of holding up the preview. Skipped if
   * the node has a newer output by then.
   */
  const later = (draw: () => Promise<ImageValue | undefined>) =>
    void draw()
      .then(async (img) => {
        if (!img || sentKey.get(sent) !== key) return;
        const bitmap = await createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
        post({ type: "node", reqId, mode, scope, id, status, thumb: true, bitmap, size: { width: img.width, height: img.height } }, [bitmap]);
      })
      .catch(() => undefined);
  if (first?.kind === "video") {
    const v = first;
    // A list of files (Split into clips) has no picture size of its own.
    const parts = v.of === "file" && !v.width ? [] : [`${v.width}×${v.height}`];
    if (v.duration > 0) parts.push(v.fps === 1 ? `${v.duration} item${v.duration === 1 ? "" : "s"}` : `${v.duration.toFixed(1)} s`);
    else if (v.duration === 0 && !v.origin) parts.push("live");
    msg.info = v.about ?? parts.join(" · ");
    first = v.poster;
  }
  if (first?.kind === "grid" && changed) first = gridToImage(first);
  if (first?.kind === "image") await sendImage(first);
  else if (first?.kind === "text") msg.text = first.text.length > 20000 ? first.text.slice(0, 20000) + "\n…" : first.text;
  else if (first?.kind === "audio") {
    msg.info = [first.name, first.duration ? `${first.duration.toFixed(1)} s` : "", kb(first.bytes.byteLength)].filter(Boolean).join(" · ");
    const a = first;
    if (changed) later(async () => (await audioCodec()).waveform(a));
    if (mode === "render" && saves) {
      const bytes = first.bytes.slice();
      msg.file = { name: first.name, mime: first.mime, data: fromBytes(bytes), key };
      transfer.push(bytes.buffer);
    }
  } else if (first?.kind === "document") {
    msg.info = `${first.pageCount} page${first.pageCount === 1 ? "" : "s"} · ${kb(first.bytes.byteLength)}`;
    const d = first;
    if (changed) later(async () => (await pdfRender()).pdfThumbnail(d));
  } else if (first?.kind === "file") {
    msg.fileInfo = { name: first.name, bytes: sizeOf(first.data) };
    if (first.batch) msg.info = `${first.batch.length} files · ${kb(first.batch.reduce((n, f) => n + sizeOf(f.data), 0))}`;
    // Show encoded images as they decode, so compression artefacts are visible.
    if (changed && first.mime.startsWith("image/") && sizeOf(first.data) <= READ_LIMIT) {
      try {
        msg.bitmap = await createImageBitmap(await asBlob(first.data, first.mime));
        msg.size = { width: msg.bitmap.width, height: msg.bitmap.height };
        transfer.push(msg.bitmap);
      } catch {
        /* a format this browser can't decode (e.g. AVIF on old systems) just has no thumbnail */
      }
    }
    if (mode === "render" && saves) {
      // Bytes in memory are copied and handed over; a file on disk goes as its path, and the main process copies it.
      msg.files = (first.batch ?? [first]).map((f) => ({ name: f.name, mime: f.mime, data: f.data.in === "memory" ? fromBytes(f.data.bytes.slice()) : f.data, key }));
      for (const f of msg.files) if (f.data.in === "memory") transfer.push(f.data.bytes.buffer);
    }
  }
  post(msg, transfer);
}
