import { share, tee, type TeeSlot } from "./tee.ts";
import { diskPaths, ScratchRefs, sizeOf as bytesSize } from "../nodes/bytes.ts";
import type { Converter, FrameItem, FrameOptions, Graph, GraphNode, NodeDef, NodeResult, Params, PortDef, PortType, RunContext, Value, VideoValue } from "./types";

type Rendered = { key: string; outputs: Record<string, Value> };

/** Every scratch file a node's outputs hold. */
const pathsOf = (outputs: Record<string, Value>) => {
  const s = new Set<string>();
  for (const v of Object.values(outputs)) diskPaths(v, s);
  return s;
};

/** A map whose values hold scratch files: setting, replacing or deleting an entry counts them. */
class HoldingMap extends Map<string, Rendered> {
  refs?: ScratchRefs;
  set(key: string, value: Rendered) {
    const old = this.get(key);
    super.set(key, value);
    this.refs?.retain(pathsOf(value.outputs));
    if (old) this.refs?.release(pathsOf(old.outputs));
    return this;
  }
  delete(key: string) {
    const old = this.get(key);
    const had = super.delete(key);
    if (old) this.refs?.release(pathsOf(old.outputs));
    return had;
  }
}

/** Results kept between runs, keyed by node type + params + input keys. */
export class ResultCache {
  private map = new Map<string, Record<string, Value>>();
  private bytes = 0;
  private maxBytes: number;
  /**
   * Who holds each result kept on disk (desktop app). Disk files take no memory, so they don't
   * count towards the cache's size; once no cached result holds one, it's handed to `onFree`.
   */
  readonly refs = new ScratchRefs();
  /**
   * The last full-size result of each job node, shown during live preview. Keyed by node id, or
   * `scope:id` when the run names a scope (one per open graph, whose node ids may be the same).
   */
  readonly lastRender: Map<string, Rendered> = new HoldingMap();

  constructor(maxBytes = 1 << 30) {
    this.maxBytes = maxBytes;
    (this.lastRender as HoldingMap).refs = this.refs;
  }

  /** Called with scratch files no cached result holds any more, so they can be deleted. */
  set onFree(free: (paths: string[]) => void) {
    this.refs.setFree(free);
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
    this.refs.retain(pathsOf(outputs));
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes || k === key) break;
      this.map.delete(k);
      this.bytes -= sizeOf(v);
      this.refs.release(pathsOf(v));
    }
  }

  get size() {
    return this.map.size;
  }

  /** Drops a closed graph's last renders; their files on disk go once nothing else holds them. */
  forget(scope: string) {
    for (const k of [...this.lastRender.keys()]) if (k.startsWith(`${scope}:`)) this.lastRender.delete(k);
  }
}

function sizeOfValue(v: Value): number {
  switch (v.kind) {
    case "image":
      return v.data.byteLength;
    case "file":
      // A file on disk takes no memory; a batch holds every file it writes.
      return (v.batch ?? [v]).reduce((n, f) => n + (f.data.in === "memory" ? bytesSize(f.data) : 0), 0);
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

/**
 * Two FNV-1a passes with different seeds, as 16 hex digits. Not a security hash,
 * but 64 bits keep cache keys from colliding (32 bits start to after tens of thousands).
 */
export function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
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
    const mapped = (def.kind === "frame" || !!def.perItem) && def.inputs.some((p) => {
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
  if (from.seq && port.type !== "video" && !port.sequence && target.kind !== "frame" && !target.perItem) return { ok: false };
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
    async *frames(signal, opts) {
      for await (const f of v.frames(signal, opts)) yield { ...f, value: await conv.convert(f.value) };
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
  // One run per frame for every output: the outputs read side by side (an image and its mask)
  // share this pass instead of each running the node again. Playback's options go on up to the
  // sources, except skipping late frames when two videos are zipped: each would skip its own.
  const runs = share<{ res: Record<string, Value>; item: FrameItem }, FrameOptions>(async function* (signal, opts) {
    const up = opts?.skipTo && seqKeys.length > 1 ? { ...opts, skipTo: undefined } : opts;
    const its = seqKeys.map((k) => (inputs[k] as VideoValue).frames(signal, up)[Symbol.asyncIterator]());
    try {
      for (;;) {
        const steps = await Promise.all(its.map((it) => it.next()));
        if (steps.some((s) => s.done)) return;
        const items = steps.map((s) => s.value as FrameItem);
        yield { res: await runOn(items.map((f) => f.value), frameCtx), item: items[0] };
      }
    } finally {
      await Promise.all(its.map((it) => it.return?.()));
    }
  });
  const out: Record<string, Value> = {};
  for (const port of def.outputs) {
    const poster = posters[port.key];
    if (!poster || poster.kind === "video") {
      if (poster) out[port.key] = poster;
      continue;
    }
    const of = poster.kind === "image" || poster.kind === "grid" || poster.kind === "file" ? poster.kind : "text";
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
      range: lead.range,
      soundLater: lead.soundLater,
      async *frames(signal, opts) {
        for await (const { res, item } of runs(signal, opts)) yield { value: res[port.key], timestamp: item.timestamp, duration: item.duration, name: item.name };
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

/**
 * Sequence outputs that two or more job nodes read whole on Render, with the jobs reading each.
 * Those jobs run at the same time and share one pass over the frames, so the video is decoded,
 * and every frame node before them runs, once instead of once per job. Left out, so that no job
 * waits for a reader that can't start: live values (a recording already reaches every reader),
 * jobs fed by another such job (they start only once it has finished), and jobs that read two
 * shared outputs (each could be waiting for the other to start).
 */
export function fanout(graph: Graph, registry: ReadonlyMap<string, NodeDef>, live: ReadonlySet<string> = new Set()): Map<string, string[]> {
  const shapes = outputShapes(graph, registry);
  const types = new Map(graph.nodes.map((n) => [n.id, n.type]));
  const readers = new Map<string, string[]>();
  for (const e of graph.edges) {
    const port = `${e.source}:${e.sourceHandle}`;
    if (live.has(e.source) || !shapes.get(port)?.seq) continue;
    const def = registry.get(types.get(e.target) ?? "");
    const input = def?.inputs.find((p) => p.key === e.targetHandle);
    // A job mapped over the frames (its input takes one value) reads them later, lazily.
    if (def?.kind !== "job" || !input || !(input.type === "video" || input.sequence)) continue;
    const list = readers.get(port) ?? [];
    if (!list.includes(e.target)) list.push(e.target);
    readers.set(port, list);
  }
  const shared = [...readers.values()].filter((l) => l.length >= 2);
  const candidates = new Set(shared.flat());
  const reads = new Map<string, number>();
  for (const id of shared.flat()) reads.set(id, (reads.get(id) ?? 0) + 1);
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  const fedByCandidate = (id: string) => {
    const seen = new Set<string>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      if (candidates.has(p)) return true;
      stack.push(...(parents.get(p) ?? []));
    }
    return false;
  };
  const out = new Map<string, string[]>();
  for (const [port, list] of readers) {
    const ok = list.filter((id) => candidates.has(id) && reads.get(id) === 1 && !fedByCandidate(id));
    if (ok.length >= 2) out.set(port, ok);
  }
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
  /**
   * Which open graph this is. Two graphs can hold nodes with the same ids (the same file opened
   * twice, say), so each keeps its own last renders. "" (the default) keys them by node id alone.
   */
  scope?: string;
}

/**
 * Runs a graph in dependency order. Unchanged nodes come from the cache;
 * in preview mode, job nodes only show their last rendered result.
 */
export async function evaluate(graph: Graph, opts: EvaluateOptions): Promise<Map<string, NodeResult>> {
  const { registry, ctx, cache, onNode, onStart, onProgress, cancelled, converters = [], scope = "" } = opts;
  const lastOf = (id: string) => (scope ? `${scope}:${id}` : id);
  const results = new Map<string, NodeResult>();
  // Nodes fed, directly or not, by a live node.
  const live = new Set<string>();
  const finish = (id: string, r: NodeResult) => {
    results.set(id, r);
    onNode?.(id, r);
  };

  const order = topoSort(graph);
  for (const node of order) {
    const def = registry.get(node.type);
    if (def?.live || graph.edges.some((e) => e.target === node.id && live.has(e.source))) live.add(node.id);
  }
  // Job nodes reading the same video on Render share one pass over its frames (see fanout).
  const fan = ctx.mode === "render" ? fanout(graph, registry, live) : new Map<string, string[]>();
  const sharing = new Set([...fan.values()].flat());
  const tees = new Map<string, TeeSlot<FrameItem>[] | null>();
  /** This reader's share of a fanned-out output, made when the first reader asks for it. */
  const slotFor = (port: string, reader: string): TeeSlot<FrameItem> | undefined => {
    const readers = fan.get(port);
    if (!readers) return undefined;
    if (!tees.has(port)) {
      const cut = port.lastIndexOf(":");
      const v = results.get(port.slice(0, cut))?.outputs[port.slice(cut + 1)];
      // An untouched file (`origin`) may be read straight from the file, never pulling its frames;
      // a reader doing that would hold the others up until it finished.
      tees.set(port, v?.kind === "video" && !v.origin ? tee((signal) => v.frames(signal), readers.length) : null);
    }
    return tees.get(port)?.[readers.indexOf(reader)];
  };
  /** Mandatory once a sharing reader is done, whatever happened: a share never read would stall the others. */
  const releaseShares = (id: string) => {
    for (const [port, readers] of fan) if (readers.includes(id)) slotFor(port, id)?.release();
  };

  let stopped = false;
  const tasks = new Map<string, Promise<void>>();
  // Nodes run one at a time, each once the nodes feeding it are done, except during a recording
  // (every node after the webcam runs at once, so two encoders both see every frame) and job nodes
  // sharing a video, which all read it together.
  let turn: Promise<void> = Promise.resolve();
  for (const node of order) {
    const sources = graph.edges.filter((e) => e.target === node.id).map((e) => tasks.get(e.source));
    const together = sharing.has(node.id) || (ctx.mode === "render" && live.has(node.id));
    const runNode = async () => {
      if (stopped || cancelled?.()) {
        stopped = true;
        return;
      }
      const def = registry.get(node.type);
      if (!def) {
        finish(node.id, { status: "error", outputs: {}, error: `Unknown node type ${node.type}` });
        return;
      }

      const inputs: Record<string, Value | undefined> = {};
      const inputKeys: string[] = [];
      const renderInputKeys: string[] = [];
      const toConvert: [string, Converter, Value][] = [];
      const seqKeys: string[] = [];
      const frameConvs: Record<string, Converter | undefined> = {};
      let missing: string | undefined;
      for (const port of def.inputs) {
        const edge = graph.edges.find((e) => e.target === node.id && e.targetHandle === port.key);
        const upstream = edge && results.get(edge.source);
        const raw = edge && upstream?.outputs[edge.sourceHandle];
        const slot = edge && raw?.kind === "video" ? slotFor(`${edge.source}:${edge.sourceHandle}`, node.id) : undefined;
        // Reading with options (playback) can't join the shared pass: it reads on its own and lets the others go on.
        const value =
          edge &&
          (slot && raw?.kind === "video"
            ? { ...raw, frames: (signal?: AbortSignal, opts?: FrameOptions) => (opts ? (slot.release(), raw.frames(signal, opts)) : slot.iterate(signal)), release: slot.release }
            : raw);
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
        const via = `:${edge.sourceHandle}${conv ? `>${port.type}` : ""}`;
        inputKeys.push(`${port.key}=${upstream.key}${via}`);
        renderInputKeys.push(`${port.key}=${upstream.renderKey ?? upstream.key}${via}`);
      }
      if (missing) {
        finish(node.id, { status: "waiting", outputs: {}, error: missing });
        return;
      }

      const nodeCtxKey = { ...ctx, nodeId: node.id };
      const previewOnly = def.previewParams ?? [];
      const renderParams = previewOnly.length ? Object.fromEntries(Object.entries(node.params).filter(([k]) => !previewOnly.includes(k))) : node.params;
      const renderKey = hash([node.type, JSON.stringify(renderParams), def.cacheKey?.(node.params, { ...nodeCtxKey, mode: "render" }) ?? "", ...renderInputKeys].join("|"));
      // Job nodes only ever run on Render, so they are cached by what Render would make:
      // moving a playhead or picking another preview page doesn't encode the video again.
      const key =
        def.kind === "job" ? renderKey : hash([node.type, JSON.stringify(node.params), def.cacheKey?.(node.params, nodeCtxKey) ?? "", ...inputKeys].join("|"));

      if (def.kind === "job" && ctx.mode === "preview") {
        const last = cache.lastRender.get(lastOf(node.id));
        if (!last) finish(node.id, { status: "skipped", outputs: {}, error: "Runs on Render", renderKey });
        // A recording can't be "out of date": every camera frame is new.
        else if (last.key === renderKey || live.has(node.id)) finish(node.id, { status: "cached", outputs: last.outputs, key: last.key, renderKey });
        else finish(node.id, { status: "stale", outputs: last.outputs, key: last.key, renderKey, error: "Out of date: Render to update" });
        return;
      }

      const last = def.kind === "job" ? cache.lastRender.get(lastOf(node.id)) : undefined;
      const hit = cache.get(key) ?? (last?.key === key ? last.outputs : undefined);
      if (hit) {
        if (def.kind === "job") cache.lastRender.set(lastOf(node.id), { key, outputs: hit });
        finish(node.id, { status: "cached", outputs: hit, key, renderKey });
        return;
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
        if (!live.has(node.id)) cache.set(key, outputs);
        if (def.kind === "job") cache.lastRender.set(lastOf(node.id), { key, outputs });
        finish(node.id, { status: "ok", outputs, key, renderKey, ms: Date.now() - t0 });
      } catch (err) {
        if (ctx.signal?.aborted) {
          finish(node.id, { status: "error", outputs: {}, error: "Cancelled" });
          stopped = true;
          return;
        }
        finish(node.id, { status: "error", outputs: {}, error: err instanceof Error ? err.message : String(err) });
      }
    };
    const task = (async () => {
      await Promise.all(sources);
      if (together) {
        try {
          await runNode();
        } finally {
          releaseShares(node.id);
        }
      } else {
        const mine = turn.then(runNode);
        turn = mine.catch(() => undefined);
        await mine;
      }
    })();
    tasks.set(node.id, task);
  }
  await Promise.all(tasks.values());
  return results;
}
