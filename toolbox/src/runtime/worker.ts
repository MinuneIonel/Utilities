/// <reference lib="webworker" />
// Runs graphs off the main thread. Holds the dropped files and the result cache.
import { CONVERTERS, REGISTRY } from "../nodes";
import { gridToImage } from "../nodes/ascii";
import { ResultCache, evaluate } from "./evaluate";
import type { Graph, NodeStatus, Value } from "./types";

export type ToWorker =
  | { type: "asset"; id: string; blob: Blob }
  | { type: "run"; reqId: number; mode: "preview" | "render"; graph: Graph }
  | { type: "cancel" };

export interface NodeUpdate {
  type: "node";
  reqId: number;
  mode: "preview" | "render";
  id: string;
  status: NodeStatus;
  ms?: number;
  error?: string;
  /** Only sent when the node's output changed since the last update. */
  bitmap?: ImageBitmap;
  size?: { width: number; height: number };
  text?: string;
  file?: { name: string; mime: string; bytes: Uint8Array };
  /** Name and size of a File output, for the node card. */
  fileInfo?: { name: string; bytes: number };
}

export type FromWorker = NodeUpdate | { type: "done"; reqId: number; mode: "preview" | "render"; error?: string };

const assets = new Map<string, Blob>();
const cache = new ResultCache();
const sentKey = new Map<string, string>();
let latestPreview = 0;
let renderCancelled = false;
let queue = Promise.resolve();

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "asset") assets.set(msg.id, msg.blob);
  else if (msg.type === "cancel") renderCancelled = true;
  else {
    if (msg.mode === "preview") latestPreview = msg.reqId;
    else renderCancelled = false;
    queue = queue.then(() => run(msg.reqId, msg.mode, msg.graph));
  }
};

async function run(reqId: number, mode: "preview" | "render", graph: Graph) {
  // A newer preview makes this one pointless; a render only stops when asked to.
  const cancelled = () => (mode === "preview" ? reqId !== latestPreview : renderCancelled);
  if (cancelled()) return post({ type: "done", reqId, mode });
  const pending: Promise<void>[] = [];
  try {
    await evaluate(graph, {
      registry: REGISTRY,
      ctx: { mode, assets },
      cache,
      converters: CONVERTERS,
      cancelled,
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
  let first = Object.values(outputs)[0];
  const changed = key !== undefined && sentKey.get(id) !== key;
  if (key === undefined) sentKey.delete(id);
  else sentKey.set(id, key);
  if (first?.kind === "grid" && changed) first = gridToImage(first);
  if (first?.kind === "image") {
    msg.size = { width: first.width, height: first.height };
    if (changed) {
      msg.bitmap = await createImageBitmap(new ImageData(first.data as Uint8ClampedArray<ArrayBuffer>, first.width, first.height));
      transfer.push(msg.bitmap);
    }
  } else if (first?.kind === "text") msg.text = first.text.length > 20000 ? first.text.slice(0, 20000) + "\n…" : first.text;
  else if (first?.kind === "file") {
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
