// Runs a background-removal model with ONNX Runtime Web, in the graph worker: on the
// GPU through WebGPU when there is one, otherwise on the CPU (WebAssembly). Loaded
// with import() so the runtime only arrives once a Remove background node runs.
import type { InferenceSession } from "onnxruntime-web";
import { modelFetcher } from "./native";
import { MODELS, maskFromOutput, toTensor, type ModelId, type Rgba } from "./remove-bg-core";

type Ort = typeof import("onnxruntime-web/webgpu");

/** Where the models are published (rembg's GitHub release); the desktop app keeps its own copy. */
export const MODEL_BASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/";

let ortP: Promise<Ort> | undefined;
function loadOrt() {
  ortP ??= import("onnxruntime-web/webgpu").then((ort) => {
    // Threads need SharedArrayBuffer (the desktop app turns it on); without it, the CPU path runs on one thread.
    const threads = typeof SharedArrayBuffer !== "undefined" ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.logLevel = "error";
    return ort;
  });
  return ortP;
}

interface Loaded {
  session: InferenceSession;
  gpu: boolean;
}

const bytesCache = new Map<ModelId, Promise<Uint8Array>>();
const sessions = new Map<string, Promise<Loaded>>();

type Progress = (fraction: number, label?: string) => void;

function modelBytes(id: ModelId, onProgress?: Progress): Promise<Uint8Array> {
  let p = bytesCache.get(id);
  if (!p) {
    const spec = MODELS[id];
    const fetcher = modelFetcher();
    p = (
      fetcher
        ? fetcher(spec.file, onProgress)
        : // In a browser tab: straight from the release (the browser's cache keeps it).
          fetch(MODEL_BASE + spec.file).then(async (r) => {
            if (!r.ok) throw new Error(`Couldn't download the background model (${r.status})`);
            return new Uint8Array(await r.arrayBuffer());
          })
    ).catch((e: Error) => {
      bytesCache.delete(id);
      throw e;
    });
    bytesCache.set(id, p);
  }
  return p;
}

let gpuBroken = false;

function session(id: ModelId, gpu: boolean, onProgress?: Progress): Promise<Loaded> {
  const key = `${id}:${gpu}`;
  let s = sessions.get(key);
  if (!s) {
    s = (async () => {
      const [ort, bytes] = await Promise.all([loadOrt(), modelBytes(id, onProgress)]);
      onProgress?.(-1, "Loading the model…");
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: gpu ? ["webgpu"] : ["wasm"],
        graphOptimizationLevel: "all",
      });
      return { session, gpu };
    })().catch((e: Error) => {
      sessions.delete(key);
      throw e;
    });
    sessions.set(key, s);
  }
  return s;
}

/** One image at a time: a session can't run two at once, and two big models at once would only fight for memory. */
let chain: Promise<unknown> = Promise.resolve();

/** The subject mask (model size × model size, 0–1) for `img`. */
export function predictMask(img: Rgba, id: ModelId, onProgress?: Progress): Promise<Float32Array> {
  const job = chain.then(async () => {
    const spec = MODELS[id];
    const ort = await loadOrt();
    const input = toTensor(img, spec);
    const tryGpu = !gpuBroken && typeof navigator !== "undefined" && "gpu" in navigator;
    const infer = async (gpu: boolean) => {
      const { session: s } = await session(id, gpu, onProgress);
      onProgress?.(-1, gpu ? "Finding the subject (GPU)…" : "Finding the subject (CPU)…");
      const feeds = { [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, spec.size, spec.size]) };
      const out = await s.run(feeds);
      const t = out[s.outputNames[0]];
      const data = (await t.getData()) as Float32Array;
      return maskFromOutput(data, spec);
    };
    if (tryGpu) {
      try {
        return await infer(true);
      } catch (e) {
        // No usable GPU (or a driver that rejects an operator): the CPU gives the same mask, only slower.
        console.warn("Remove background: WebGPU failed, using the CPU", e);
        gpuBroken = true;
        sessions.delete(`${id}:true`);
      }
    }
    return infer(false);
  });
  chain = job.catch(() => undefined);
  return job;
}
