// Reading a saved graph file: everything that can be repaired is, and each repair is
// reported, so a damaged file opens as a working graph with a note instead of dead cards.
import type { Graph, GraphEdge, GraphNode, Params } from "./runtime/types";

export interface CheckedGraph {
  graph: Graph;
  /** One sentence per repair, for the message bar. Empty when the file was fine. */
  notes: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Parses and repairs a graph file. `defaults` gives a node type's default params, or
 * undefined for types this Toolbox doesn't know; `freshId` makes a new unique id.
 */
export function checkGraph(text: string, defaults: (type: string) => Params | undefined, freshId: (prefix: string) => string): CheckedGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file isn't a Toolbox graph, or it's damaged: it couldn't be read.");
  }
  const g = raw as Partial<Graph> | null;
  if (!g || typeof g !== "object" || g.version !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("This file isn't a Toolbox graph.");
  const notes: string[] = [];

  const unknown = new Set<string>();
  let renamed = 0;
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes as Partial<GraphNode>[]) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string") continue;
    const d = defaults(n.type);
    if (!d) {
      unknown.add(n.type);
      continue;
    }
    let id = n.id;
    // Two nodes with one id would make one of them vanish on the canvas; the second gets its own.
    if (ids.has(id)) {
      id = freshId("n");
      renamed++;
    }
    ids.add(id);
    const params = n.params && typeof n.params === "object" ? n.params : {};
    nodes.push({ id, type: n.type, params: { ...d, ...params }, position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 } });
  }
  if (unknown.size) notes.push(`Left out ${plural(unknown.size, "kind of node", "kinds of node")} this Toolbox doesn't have (${[...unknown].join(", ")}).`);
  if (renamed) notes.push(`${plural(renamed, "node shared its id", "nodes shared their ids")} with another and got a new one; check ${renamed === 1 ? "its" : "their"} wires.`);

  // Wires that point nowhere go; an input takes one wire, so the last one to it wins.
  const byInput = new Map<string, GraphEdge>();
  for (const e of g.edges as Partial<GraphEdge>[]) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string" || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    const edge: GraphEdge = { id: String(e.id ?? ""), source: e.source, sourceHandle: String(e.sourceHandle ?? ""), target: e.target, targetHandle: String(e.targetHandle ?? "") };
    byInput.delete(`${edge.target}:${edge.targetHandle}`);
    byInput.set(`${edge.target}:${edge.targetHandle}`, edge);
  }
  const edgeIds = new Set<string>();
  let edges = [...byInput.values()].map((e) => {
    const id = !e.id || edgeIds.has(e.id) ? freshId("e") : e.id;
    edgeIds.add(id);
    return { ...e, id };
  });

  // A loop can't run: drop each wire that closes one, keeping the rest of the graph working.
  const looped = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const e of edges) {
      if (e.source !== id || looped.has(e.id)) continue;
      const s = state.get(e.target);
      if (s === 1) looped.add(e.id);
      else if (!s) visit(e.target);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  if (looped.size) {
    edges = edges.filter((e) => !looped.has(e.id));
    notes.push(`Removed ${plural(looped.size, "wire that made a loop", "wires that made loops")}: a node can't feed itself.`);
  }
  return { graph: { version: 1, nodes, edges }, notes };
}
