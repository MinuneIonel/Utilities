/// <reference lib="webworker" />
// Runs graphs off the main thread. Holds the dropped files and the result cache.
import { REGISTRY } from "../nodes";
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
      cancelled,
      onNode: (id, r) => pending.push(report(reqId, mode, id, r.status, r.outputs, r.key, r.ms, r.error)),
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
  status: NodeStatus,
  outputs: Record<string, Value>,
  key: string | undefined,
  ms: number | undefined,
  error: string | undefined,
) {
  const msg: NodeUpdate = { type: "node", reqId, mode, id, status, ms, error };
  const transfer: Transferable[] = [];
  const first = Object.values(outputs)[0];
  const changed = key !== undefined && sentKey.get(id) !== key;
  if (key === undefined) sentKey.delete(id);
  else sentKey.set(id, key);
  if (first?.kind === "image") {
    msg.size = { width: first.width, height: first.height };
    if (changed) {
      msg.bitmap = await createImageBitmap(new ImageData(first.data as Uint8ClampedArray<ArrayBuffer>, first.width, first.height));
      transfer.push(msg.bitmap);
    }
  } else if (first?.kind === "text") msg.text = first.text;
  else if (first?.kind === "file") {
    if (mode === "render") {
      msg.file = { name: first.name, mime: first.mime, bytes: first.bytes.slice() };
      transfer.push(msg.file.bytes.buffer);
    }
  }
  post(msg, transfer);
}
