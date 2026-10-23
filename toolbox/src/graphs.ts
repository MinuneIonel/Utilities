import { REGISTRY } from "./nodes";
import type { Graph, GraphNode } from "./runtime/types";

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newNode(type: string, position: { x: number; y: number }): GraphNode {
  const def = REGISTRY.get(type);
  if (!def) throw new Error(`Unknown node type ${type}`);
  return { id: newId("n"), type, params: def.defaults(), position };
}

/** What a fresh window starts with: file in, dither, save. */
export function starterGraph(): Graph {
  const a = newNode("input.file", { x: 40, y: 120 });
  const b = newNode("dither.recipe", { x: 340, y: 120 });
  const c = newNode("output.save-image", { x: 640, y: 120 });
  return {
    version: 1,
    nodes: [a, b, c],
    edges: [
      { id: newId("e"), source: a.id, sourceHandle: "image", target: b.id, targetHandle: "image" },
      { id: newId("e"), source: b.id, sourceHandle: "image", target: c.id, targetHandle: "image" },
    ],
  };
}

/** Validates a saved graph, dropping nodes of unknown types and edges that point nowhere. */
export function parseGraph(text: string): Graph {
  const g = JSON.parse(text) as Partial<Graph>;
  if (!g || g.version !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("Not a Toolbox graph");
  const nodes = g.nodes
    .filter((n) => n && typeof n.id === "string" && REGISTRY.has(n.type))
    .map((n) => ({
      id: n.id,
      type: n.type,
      params: { ...REGISTRY.get(n.type)!.defaults(), ...n.params },
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => e && ids.has(e.source) && ids.has(e.target));
  return { version: 1, nodes, edges };
}

/** Saved graphs don't carry dropped files, so file inputs come back empty. */
export function serializeGraph(g: Graph): string {
  const nodes = g.nodes.map((n) => (n.type === "input.file" ? { ...n, params: { ...n.params, assetId: "" } } : n));
  return JSON.stringify({ ...g, nodes }, null, 2);
}
