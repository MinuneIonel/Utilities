/// <reference lib="webworker" />
// Runs graphs off the main thread. Holds the dropped files and the result cache.
import { CONVERTERS, REGISTRY } from "../nodes";
import { gridToImage } from "../nodes/ascii";
import { audioCodec } from "../nodes/audio";
import { setNativeTools, type NativeTool, type ToolOptions, type ToolResult, type ToolStream } from "../nodes/native";
import { pdfRender } from "../nodes/pdf";
import { ResultCache, evaluate } from "./evaluate";
import type { CameraFeed, FrameItem, Graph, ImageValue, NodeStatus, Value } from "./types";

export type ToWorker =
  | { type: "asset"; id: string; blob: Blob }
  | { type: "run"; reqId: number; mode: "preview" | "render"; graph: Graph }
  | { type: "cancel" }
  /** A webcam frame. `t` is in seconds. */
  | { type: "cam-frame"; id: string; bitmap: ImageBitmap; t: number }
  /** Ends every webcam recording, so Render can finish the files. */
  | { type: "cam-stop" }
  /** Which native tools the desktop app has (none in a browser). */
  | { type: "tools"; ffmpeg: boolean; ytdlp: boolean; encoders?: string[]; hwaccels?: string[] }
  | { type: "tool-result"; callId: string; result?: ToolResult; error?: string }
  | { type: "tool-written"; writeId: number; error?: string }
  | { type: "tool-progress"; callId: string; fraction: number; label?: string };

export interface NodeUpdate {
  type: "node";
  reqId: number;
  mode: "preview" | "render";
  id: string;
  status: NodeStatus | "running";
  ms?: number;
  error?: string;
  /** Only sent when the node's output changed since the last update. */
  bitmap?: ImageBitmap;
  size?: { width: number; height: number };
  text?: string;
  file?: { name: string; mime: string; bytes: Uint8Array };
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
  id: string;
  /** 0–1, or -1 when unknown. */
  fraction: number;
  label?: string;
}

/** Asks the window to run a native tool through the desktop app. */
export type ToolRequest =
  | { type: "tool-run"; callId: string; tool: NativeTool; args: string[]; files: Record<string, Uint8Array> }
  | { type: "tool-open"; callId: string; tool: NativeTool; args: string[]; files: Record<string, Uint8Array> }
  | { type: "tool-write"; callId: string; writeId: number; bytes: Uint8Array }
  | { type: "tool-end"; callId: string }
  | { type: "tool-cancel"; callId: string };

export type FromWorker = NodeUpdate | ProgressUpdate | ToolRequest | { type: "done"; reqId: number; mode: "preview" | "render"; error?: string };

/** The worker's end of a webcam: the newest frame, and recordings that stream frames as they arrive. */
class Feed implements CameraFeed {
  version = 0;
  latest?: ImageValue;
  private listeners = new Set<(f: FrameItem | null) => void>();

  push(img: ImageValue, t: number) {
    this.latest = img;
    this.version++;
    for (const l of this.listeners) l({ value: img, timestamp: t, duration: 1 / 30 });
  }

  stop() {
    for (const l of this.listeners) l(null);
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

const toolCalls = new Map<string, { resolve(r: ToolResult): void; reject(e: Error): void; onProgress?(f: number, l?: string): void }>();
let toolCallN = 0;
const toolWrites = new Map<number, { resolve(): void; reject(e: Error): void }>();
let toolWriteN = 0;

/** Starts a native tool call and returns its id; the result arrives as a tool-result message. */
function callTool(kind: "tool-run" | "tool-open", tool: NativeTool, args: string[], files: Record<string, Uint8Array>, opts: ToolOptions, done: { resolve(r: ToolResult): void; reject(e: Error): void }) {
  const callId = `t${++toolCallN}`;
  toolCalls.set(callId, { ...done, onProgress: opts.onProgress });
  opts.signal?.addEventListener("abort", () => post({ type: "tool-cancel", callId }), { once: true });
  post({ type: kind, callId, tool, args, files });
  return callId;
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
const sentKey = new Map<string, string>();
let latestPreview = 0;
let renderCancelled = false;
let renderAbort = new AbortController();
let queue = Promise.resolve();

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "asset") assets.set(msg.id, msg.blob);
  else if (msg.type === "cancel") {
    renderCancelled = true;
    renderAbort.abort();
  } else if (msg.type === "cam-frame") {
    let feed = cameras.get(msg.id);
    if (!feed) cameras.set(msg.id, (feed = new Feed()));
    feed.push(bitmapToImage(msg.bitmap), msg.t);
  } else if (msg.type === "cam-stop") {
    for (const f of cameras.values()) f.stop();
  } else if (msg.type === "tools") {
    const { ffmpeg, ytdlp } = msg;
    setNativeTools(
      ffmpeg || ytdlp
        ? {
            ffmpeg,
            ytdlp,
            encoders: new Set(msg.encoders ?? []),
            hwaccels: new Set(msg.hwaccels ?? []),
            run: (tool, args, files, opts = {}) => new Promise((resolve, reject) => void callTool("tool-run", tool, args, files, opts, { resolve, reject })),
            open(tool, args, files, opts = {}): ToolStream {
              let callId = "";
              const done = new Promise<ToolResult>((resolve, reject) => (callId = callTool("tool-open", tool, args, files, opts, { resolve, reject })));
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
            },
          }
        : undefined,
    );
  } else if (msg.type === "tool-result") {
    const call = toolCalls.get(msg.callId);
    toolCalls.delete(msg.callId);
    if (msg.result) call?.resolve(msg.result);
    else call?.reject(new Error(msg.error ?? "The tool failed"));
  } else if (msg.type === "tool-written") {
    const w = toolWrites.get(msg.writeId);
    toolWrites.delete(msg.writeId);
    if (msg.error) w?.reject(new Error(msg.error));
    else w?.resolve();
  } else if (msg.type === "tool-progress") {
    toolCalls.get(msg.callId)?.onProgress?.(msg.fraction, msg.label);
  } else {
    if (msg.mode === "preview") latestPreview = msg.reqId;
    else {
      renderCancelled = false;
      renderAbort = new AbortController();
    }
    queue = queue.then(() => run(msg.reqId, msg.mode, msg.graph));
  }
};

async function run(reqId: number, mode: "preview" | "render", graph: Graph) {
  // A newer preview makes this one pointless; a render only stops when asked to.
  const cancelled = () => (mode === "preview" ? reqId !== latestPreview : renderCancelled);
  if (cancelled()) return post({ type: "done", reqId, mode });
  const pending: Promise<void>[] = [];
  const lastProgress = new Map<string, number>();
  try {
    await evaluate(graph, {
      registry: REGISTRY,
      ctx: { mode, assets, cameras, signal: mode === "render" ? renderAbort.signal : undefined },
      cache,
      converters: CONVERTERS,
      cancelled,
      // Previews are quick and constant with a webcam; only Render shows nodes as running.
      onStart: (id) => mode === "render" && post({ type: "node", reqId, mode, id, status: "running" }),
      onProgress: (id, fraction, label) => {
        // At most ten updates a second per node.
        const now = Date.now();
        if (now - (lastProgress.get(id) ?? 0) < 100) return;
        lastProgress.set(id, now);
        post({ type: "progress", reqId, id, fraction, label });
      },
      onNode: (id, r) => {
        const saves = !!REGISTRY.get(graph.nodes.find((n) => n.id === id)?.type ?? "")?.saves;
        pending.push(report(reqId, mode, id, saves, r.status, r.outputs, r.key, r.ms, r.error));
      },
    });
    await Promise.all(pending);
    post({ type: "done", reqId, mode, error: cancelled() && mode === "render" ? "Render cancelled" : undefined });
  } catch (err) {
    await Promise.all(pending);
    post({ type: "done", reqId, mode, error: err instanceof Error ? err.message : String(err) });
  }
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function report(
  reqId: number,
  mode: "preview" | "render",
  id: string,
  saves: boolean,
  status: NodeStatus,
  outputs: Record<string, Value>,
  key: string | undefined,
  ms: number | undefined,
  error: string | undefined,
) {
  const msg: NodeUpdate = { type: "node", reqId, mode, id, status, ms, error };
  const transfer: Transferable[] = [];
  let first: Value | undefined = Object.values(outputs)[0];
  const changed = key !== undefined && sentKey.get(id) !== key;
  if (key === undefined) sentKey.delete(id);
  else sentKey.set(id, key);
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
        if (!img || sentKey.get(id) !== key) return;
        const bitmap = await createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
        post({ type: "node", reqId, mode, id, status, thumb: true, bitmap, size: { width: img.width, height: img.height } }, [bitmap]);
      })
      .catch(() => undefined);
  if (first?.kind === "video") {
    const v = first;
    const parts = [`${v.width}×${v.height}`];
    if (v.duration > 0) parts.push(v.fps === 1 ? `${v.duration} pages` : `${v.duration.toFixed(1)} s`);
    else if (v.duration === 0 && !v.origin) parts.push("live");
    msg.info = parts.join(" · ");
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
      msg.file = { name: first.name, mime: first.mime, bytes: first.bytes.slice() };
      transfer.push(msg.file.bytes.buffer);
    }
  } else if (first?.kind === "document") {
    msg.info = `${first.pageCount} page${first.pageCount === 1 ? "" : "s"} · ${kb(first.bytes.byteLength)}`;
    const d = first;
    if (changed) later(async () => (await pdfRender()).pdfThumbnail(d));
  } else if (first?.kind === "file") {
    msg.fileInfo = { name: first.name, bytes: first.bytes.byteLength };
    // Show encoded images as they decode, so compression artefacts are visible.
    if (changed && first.mime.startsWith("image/")) {
      try {
        msg.bitmap = await createImageBitmap(new Blob([first.bytes as Uint8Array<ArrayBuffer>], { type: first.mime }));
        msg.size = { width: msg.bitmap.width, height: msg.bitmap.height };
        transfer.push(msg.bitmap);
      } catch {
        /* a format this browser can't decode (e.g. AVIF on old systems) just has no thumbnail */
      }
    }
    if (mode === "render" && saves) {
      msg.file = { name: first.name, mime: first.mime, bytes: first.bytes.slice() };
      transfer.push(msg.file.bytes.buffer);
    }
  }
  post(msg, transfer);
}
