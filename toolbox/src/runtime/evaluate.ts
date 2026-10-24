import type { Converter, FrameItem, Graph, GraphNode, NodeDef, NodeResult, Params, PortDef, PortType, RunContext, Value, VideoValue } from "./types";

/** Results kept between runs, keyed by node type + params + input keys. */
export class ResultCache {
  private map = new Map<string, Record<string, Value>>();
  private bytes = 0;
  private maxBytes: number;
  /** The last full-size result of each job node, shown during live preview. */
  readonly lastRender = new Map<string, { key: string; outputs: Record<string, Value> }>();

  constructor(maxBytes = 1 << 30) {
    this.maxBytes = maxBytes;
  }

  get(key: string): Record<string, Value> | undefined {
    const hit = this.map.get(key);
    if (hit) {
      // Re-insert so the map's order doubles as least-recently-used order.
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, outputs: Record<string, Value>) {
    if (this.map.has(key)) return;
    this.map.set(key, outputs);
    this.bytes += sizeOf(outputs);
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes || k === key) break;
      this.map.delete(k);
      this.bytes -= sizeOf(v);
    }
  }

  get size() {
    return this.map.size;
  }
}

function sizeOfValue(v: Value): number {
  switch (v.kind) {
    case "image":
      return v.data.byteLength;
    case "file":
    case "audio":
    case "document":
      return v.bytes.byteLength;
    case "grid":
      return v.grid.codes.byteLength + v.grid.colors.byteLength;
    case "video":
      // Frames are decoded on demand; only the poster is held.
      return sizeOfValue(v.poster);
    default:
      return v.text.length * 2;
  }
}

function sizeOf(outputs: Record<string, Value>): number {
  let n = 0;
  for (const v of Object.values(outputs)) n += sizeOfValue(v);
  return n;
}

/** FNV-1a over a string, as 8 hex digits. Enough to tell params apart, not a security hash. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function findConverter(converters: readonly Converter[], from: PortType, to: PortType): Converter | undefined {
  return converters.find((c) => c.from === from && c.to === to);
}

/** What a wire end carries: one value of `type`, or a video whose frames are `type`. */
export interface Shape {
  type: PortType;
  seq: boolean;
}

/**
 * Works out, without running anything, which outputs carry videos. A frame node
 * with a video wired into a single-value input runs once per frame, so all its
 * outputs become videos of their own type.
 */
export function outputShapes(graph: Graph, registry: ReadonlyMap<string, NodeDef>): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  let order: GraphNode[];
  try {
    order = topoSort(graph);
  } catch {
    order = graph.nodes;
  }
  for (const node of order) {
    const def = registry.get(node.type);
    if (!def) continue;
    const mapped = def.kind === "frame" && def.inputs.some((p) => {
      if (p.type === "video" || p.sequence) return false;
      const e = graph.edges.find((x) => x.target === node.id && x.targetHandle === p.key);
      return !!e && !!shapes.get(`${e.source}:${e.sourceHandle}`)?.seq;
    });
    for (const p of def.outputs) {
      shapes.set(`${node.id}:${p.key}`, p.type === "video" ? { type: "image", seq: true } : { type: p.type, seq: mapped });
    }
  }
  return shapes;
}

/** Whether an output of this shape can feed this input, and the converter it would need. */
export function canConnect(from: Shape, target: NodeDef, port: PortDef, converters: readonly Converter[]): { ok: boolean; converter?: Converter } {
  const want: PortType = port.type === "video" ? "image" : port.type;
  if (from.seq && port.type !== "video" && !port.sequence && target.kind !== "frame") return { ok: false };
  if (!from.seq && port.type === "video") return { ok: false };
  if (from.type === want) return { ok: true };
  const converter = findConverter(converters, from.type, want);
  return { ok: !!converter, converter };
}

const shapeOf = (v: Value): Shape => (v.kind === "video" ? { type: v.of, seq: true } : { type: v.kind, seq: false });

/** A video whose frames have been converted (e.g. grid frames drawn as images). */
function convertVideo(v: VideoValue, conv: Converter, poster: Value): VideoValue {
  return {
    ...v,
    of: conv.to as VideoValue["of"],
    poster,
    async *frames(signal) {
      for await (const f of v.frames(signal)) yield { ...f, value: await conv.convert(f.value) };
    },
  };
}

/**
 * Runs a frame node over every frame of its video inputs. The poster runs now
 * (that's the live preview); the frames run lazily, whenever something
 * downstream streams them.
 */
async function mapNode(
  def: NodeDef,
  params: Params,
  inputs: Record<string, Value | undefined>,
  seqKeys: string[],
  convs: Record<string, Converter | undefined>,
  ctx: RunContext,
): Promise<Record<string, Value>> {
  const runOn = async (vals: Value[], c: RunContext) => {
    const ins = { ...inputs };
    for (let i = 0; i < seqKeys.length; i++) {
      const conv = convs[seqKeys[i]];
      ins[seqKeys[i]] = conv ? await conv.convert(vals[i]) : vals[i];
    }
    return def.run(ins, params, c);
  };
  const lead = inputs[seqKeys[0]] as VideoValue;
  const posters = await runOn(seqKeys.map((k) => (inputs[k] as VideoValue).poster), ctx);
  const frameCtx: RunContext = { ...ctx, mode: "render", progress: undefined };
  const out: Record<string, Value> = {};
  for (const port of def.outputs) {
    const poster = posters[port.key];
    if (!poster || poster.kind === "video") {
      if (poster) out[port.key] = poster;
      continue;
    }
    const of = poster.kind === "image" || poster.kind === "grid" ? poster.kind : "text";
    const scale = poster.kind === "image" ? (poster.scale ?? 1) : 1;
    out[port.key] = {
      kind: "video",
      of,
      width: poster.kind === "image" ? Math.round(poster.width / scale) : lead.width,
      height: poster.kind === "image" ? Math.round(poster.height / scale) : lead.height,
      duration: lead.duration,
      fps: lead.fps,
      poster,
      audioSource: lead.audioSource,
      async *frames(signal) {
        const its = seqKeys.map((k) => (inputs[k] as VideoValue).frames(signal)[Symbol.asyncIterator]());
        try {
          for (;;) {
            const steps = await Promise.all(its.map((it) => it.next()));
            if (steps.some((s) => s.done)) return;
            const items = steps.map((s) => s.value as FrameItem);
            const res = await runOn(items.map((f) => f.value), frameCtx);
            yield { value: res[port.key], timestamp: items[0].timestamp, duration: items[0].duration };
          }
        } finally {
          await Promise.all(its.map((it) => it.return?.()));
        }
      },
    };
  }
  return out;
}

/** Orders nodes so every node comes after the nodes feeding it. Throws on a cycle. */
export function topoSort(graph: Graph): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const state = new Map<string, 1 | 2>();
  const out: GraphNode[] = [];
  const visit = (id: string) => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) throw new Error("The graph has a loop");
    state.set(id, 1);
    for (const e of graph.edges) if (e.target === id && byId.has(e.source)) visit(e.source);
    state.set(id, 2);
    out.push(byId.get(id)!);
  };
  for (const n of graph.nodes) visit(n.id);
  return out;
}

export interface EvaluateOptions {
  registry: ReadonlyMap<string, NodeDef>;
  ctx: RunContext;
  cache: ResultCache;
  /** Applied automatically when a wire joins two different port types. */
  converters?: readonly Converter[];
  /** Called as each node finishes, so the UI can update node by node. */
  onNode?: (id: string, result: NodeResult) => void;
  /** Called when a node starts running (not for cache hits). */
  onStart?: (id: string) => void;
  /** A long node's progress, 0–1. */
  onProgress?: (id: string, fraction: number, label?: string) => void;
  /** Returning true stops the run before the next node (a newer request arrived). */
  cancelled?: () => boolean;
}

/**
 * Runs a graph in dependency order. Unchanged nodes come from the cache;
 * in preview mode, job nodes only show their last rendered result.
 */
export async function evaluate(graph: Graph, opts: EvaluateOptions): Promise<Map<string, NodeResult>> {
  const { registry, ctx, cache, onNode, onStart, onProgress, cancelled, converters = [] } = opts;
  const results = new Map<string, NodeResult>();
  const finish = (id: string, r: NodeResult) => {
    results.set(id, r);
    onNode?.(id, r);
  };

  for (const node of topoSort(graph)) {
    if (cancelled?.()) break;
    const def = registry.get(node.type);
    if (!def) {
      finish(node.id, { status: "error", outputs: {}, error: `Unknown node type ${node.type}` });
      continue;
    }

    const inputs: Record<string, Value | undefined> = {};
    const inputKeys: string[] = [];
    const toConvert: [string, Converter, Value][] = [];
    const seqKeys: string[] = [];
    const frameConvs: Record<string, Converter | undefined> = {};
    let missing: string | undefined;
    for (const port of def.inputs) {
      const edge = graph.edges.find((e) => e.target === node.id && e.targetHandle === port.key);
      const upstream = edge && results.get(edge.source);
      const value = edge && upstream?.outputs[edge.sourceHandle];
      if (!value || !upstream?.key) {
        if (!edge && port.optional) continue;
        missing ??= edge ? `Waiting for ${port.label.toLowerCase()}` : `Connect ${port.label.toLowerCase()}`;
        continue;
      }
      const from = shapeOf(value);
      const check = canConnect(from, def, port, converters);
      if (!check.ok) {
        missing ??= from.seq
          ? `${def.title} takes a single ${port.type}, not a video`
          : port.type === "video"
            ? `Needs a video`
            : `Can't turn ${from.type} into ${port.type}`;
        continue;
      }
      const conv = check.converter;
      // Mapped over every frame: a video into a frame node's single-value input.
      const mapped = from.seq && port.type !== "video" && !port.sequence;
      if (mapped) {
        seqKeys.push(port.key);
        frameConvs[port.key] = conv;
        inputs[port.key] = value;
      } else if (conv) {
        // Converted only if the node actually runs (not on a cache hit).
        toConvert.push([port.key, conv, value]);
      } else inputs[port.key] = value;
      inputKeys.push(`${port.key}=${upstream.key}:${edge.sourceHandle}${conv ? `>${port.type}` : ""}`);
    }
    if (missing) {
      finish(node.id, { status: "waiting", outputs: {}, error: missing });
      continue;
    }

    const key = hash([node.type, JSON.stringify(node.params), def.cacheKey?.(node.params, { ...ctx, nodeId: node.id }) ?? "", ...inputKeys].join("|"));

    if (def.kind === "job" && ctx.mode === "preview") {
      const last = cache.lastRender.get(node.id);
      if (last) finish(node.id, { status: "cached", outputs: last.outputs, key: last.key });
      else finish(node.id, { status: "skipped", outputs: {}, error: "Render to see" });
      continue;
    }

    const hit = cache.get(key);
    if (hit) {
      if (def.kind === "job") cache.lastRender.set(node.id, { key, outputs: hit });
      finish(node.id, { status: "cached", outputs: hit, key });
      continue;
    }

    const t0 = Date.now();
    onStart?.(node.id);
    const nodeCtx: RunContext = { ...ctx, nodeId: node.id, progress: (f, label) => onProgress?.(node.id, f, label) };
    try {
      for (const [k, conv, v] of toConvert) {
        // A video into a sequence input (or a video port) converts frame by frame.
        if (v.kind === "video") inputs[k] = convertVideo(v, conv, await conv.convert(v.poster));
        else inputs[k] = await conv.convert(v);
      }
      const outputs = seqKeys.length
        ? await mapNode(def, node.params, inputs, seqKeys, frameConvs, nodeCtx)
        : await def.run(inputs, node.params, nodeCtx);
      cache.set(key, outputs);
      if (def.kind === "job") cache.lastRender.set(node.id, { key, outputs });
      finish(node.id, { status: "ok", outputs, key, ms: Date.now() - t0 });
    } catch (err) {
      if (ctx.signal?.aborted) {
        finish(node.id, { status: "error", outputs: {}, error: "Cancelled" });
        break;
      }
      finish(node.id, { status: "error", outputs: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
