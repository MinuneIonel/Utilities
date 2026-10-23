import type { Graph, GraphNode, NodeDef, NodeResult, RunContext, Value } from "./types";

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

function sizeOf(outputs: Record<string, Value>): number {
  let n = 0;
  for (const v of Object.values(outputs)) {
    if (v.kind === "image") n += v.data.byteLength;
    else if (v.kind === "file") n += v.bytes.byteLength;
    else n += v.text.length * 2;
  }
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
  /** Called as each node finishes, so the UI can update node by node. */
  onNode?: (id: string, result: NodeResult) => void;
  /** Returning true stops the run before the next node (a newer request arrived). */
  cancelled?: () => boolean;
}

/**
 * Runs a graph in dependency order. Unchanged nodes come from the cache;
 * in preview mode, job nodes only show their last rendered result.
 */
export async function evaluate(graph: Graph, opts: EvaluateOptions): Promise<Map<string, NodeResult>> {
  const { registry, ctx, cache, onNode, cancelled } = opts;
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
    let missing: string | undefined;
    for (const port of def.inputs) {
      const edge = graph.edges.find((e) => e.target === node.id && e.targetHandle === port.key);
      const upstream = edge && results.get(edge.source);
      const value = edge && upstream?.outputs[edge.sourceHandle];
      if (!value || !upstream?.key) {
        missing ??= edge ? `Waiting for ${port.label.toLowerCase()}` : `Connect ${port.label.toLowerCase()}`;
        continue;
      }
      inputs[port.key] = value;
      inputKeys.push(`${port.key}=${upstream.key}:${edge.sourceHandle}`);
    }
    if (missing) {
      finish(node.id, { status: "waiting", outputs: {}, error: missing });
      continue;
    }

    const key = hash([node.type, JSON.stringify(node.params), def.cacheKey?.(node.params, ctx) ?? "", ...inputKeys].join("|"));

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
    try {
      const outputs = await def.run(inputs, node.params, ctx);
      cache.set(key, outputs);
      if (def.kind === "job") cache.lastRender.set(node.id, { key, outputs });
      finish(node.id, { status: "ok", outputs, key, ms: Date.now() - t0 });
    } catch (err) {
      finish(node.id, { status: "error", outputs: {}, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
