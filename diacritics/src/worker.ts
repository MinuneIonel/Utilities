import { parseModel, type Model } from "./engine/model";
import { parseNeural } from "./engine/neural";
import { restore, type RestoreResult } from "./engine/restore";

export interface RestoreRequest {
  type: "restore";
  id: number;
  text: string;
  keepExisting: boolean;
  overrides: [number, string][];
}

export type WorkerMessage =
  | { type: "ready"; words: number; ambiguous: number; neural: boolean; ms: number }
  | { type: "error"; message: string }
  | { type: "result"; id: number; result: RestoreResult; ms: number };

export interface LoadRequest {
  type: "load";
  url: string;
  /** Optional neural helper; the app works without it. */
  neuralUrl: string;
}

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

let model: Model | null = null;
let pending: RestoreRequest | null = null;

function gunzip(res: Response): Response {
  if (!res.ok || !res.body) throw new Error(`${res.url}: HTTP ${res.status}`);
  return new Response(res.body.pipeThrough(new DecompressionStream("gzip")));
}

async function load(url: string, neuralUrl: string): Promise<void> {
  const t0 = performance.now();
  const [text, neural] = await Promise.all([
    fetch(url).then((r) => gunzip(r).text()),
    fetch(neuralUrl)
      .then((r) => gunzip(r).arrayBuffer())
      .then(parseNeural)
      .catch(() => undefined),
  ]);
  model = parseModel(text);
  model.neural = neural;
  post({ type: "ready", words: model.stats.words, ambiguous: model.stats.ambiguous, neural: !!neural, ms: performance.now() - t0 });
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
  if (e.data.type === "load") load(e.data.url, e.data.neuralUrl).catch((err) => post({ type: "error", message: String(err) }));
  else run(e.data);
};
