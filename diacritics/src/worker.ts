import { parseModel, type Model } from "./engine/model";
import { restore, type RestoreResult } from "./engine/restore";

export interface RestoreRequest {
  type: "restore";
  id: number;
  text: string;
  keepExisting: boolean;
  overrides: [number, string][];
}

export type WorkerMessage =
  | { type: "ready"; words: number; ambiguous: number; ms: number }
  | { type: "error"; message: string }
  | { type: "result"; id: number; result: RestoreResult; ms: number };

export interface LoadRequest {
  type: "load";
  url: string;
}

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

let model: Model | null = null;
let pending: RestoreRequest | null = null;

async function load(url: string): Promise<void> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model.dat: HTTP ${res.status}`);
  const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
  model = parseModel(text);
  post({ type: "ready", words: model.stats.words, ambiguous: model.stats.ambiguous, ms: performance.now() - t0 });
  if (pending) run(pending);
}

function run(req: RestoreRequest): void {
  if (!model) {
    pending = req;
    return;
  }
  pending = null;
  const t0 = performance.now();
  const result = restore(req.text, model, { keepExisting: req.keepExisting, overrides: new Map(req.overrides) });
  post({ type: "result", id: req.id, result, ms: performance.now() - t0 });
}

self.onmessage = (e: MessageEvent<RestoreRequest | LoadRequest>) => {
  if (e.data.type === "load") load(e.data.url).catch((err) => post({ type: "error", message: String(err) }));
  else run(e.data);
};
