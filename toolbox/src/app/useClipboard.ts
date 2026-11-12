// Copy, cut, paste and duplicate nodes, and dropping a whole graph in beside what's there.
import { useCallback, useRef, type MutableRefObject, type RefObject } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { newId } from "../graphs";
import type { Graph } from "../runtime/types";
import type { ToolFlowNode } from "../ui/context";
import { toGraph, withoutLastSaved, type Point, type SetEdges, type SetNodes } from "./flow";

export function useClipboard(
  flow: ReactFlowInstance<ToolFlowNode, Edge>,
  setNodes: SetNodes,
  setEdges: SetEdges,
  canvasRef: RefObject<HTMLDivElement | null>,
  pointer: MutableRefObject<Point | undefined>,
) {
  /** Adds a graph's nodes and wires next to what's there, selected, with fresh ids. */
  const insertGraph = useCallback(
    (g: Graph, offset: Point) => {
      const ids = new Map(g.nodes.map((n) => [n.id, newId("n")]));
      const added: ToolFlowNode[] = g.nodes.map((n) => ({
        id: ids.get(n.id)!,
        type: "tool",
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
        // A copy hasn't saved anything yet, so it mustn't replace the original's files.
        data: { type: n.type, params: withoutLastSaved(structuredClone(n.params)) },
        selected: true,
      }));
      setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), ...added]);
      setEdges((es) => [
        ...es.map((e) => ({ ...e, selected: false })),
        ...g.edges.map((e) => ({ ...e, id: newId("e"), source: ids.get(e.source)!, target: ids.get(e.target)! })),
      ]);
    },
    [setEdges, setNodes],
  );

  const clipboard = useRef<{ graph: Graph; pastes: number } | null>(null);
  const copy = useCallback(() => {
    const picked = flow.getNodes().filter((n) => n.selected);
    if (!picked.length) return false;
    const ids = new Set(picked.map((n) => n.id));
    const g = toGraph(picked, flow.getEdges().filter((e) => ids.has(e.source) && ids.has(e.target)));
    clipboard.current = { graph: g, pastes: 0 };
    return true;
  }, [flow]);
  const deleteSelected = useCallback(() => {
    const ids = new Set(flow.getNodes().filter((n) => n.selected).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
  }, [flow, setEdges, setNodes]);
  /** Pastes under the pointer when it's on the canvas, otherwise a step down and right of the copies. */
  const paste = useCallback(
    (nearCopies = false) => {
      const clip = clipboard.current;
      if (!clip?.graph.nodes.length) return;
      clip.pastes++;
      const left = Math.min(...clip.graph.nodes.map((n) => n.position.x));
      const top = Math.min(...clip.graph.nodes.map((n) => n.position.y));
      const r = canvasRef.current!.getBoundingClientRect();
      const p = pointer.current;
      const onCanvas = !nearCopies && p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      const at = onCanvas ? flow.screenToFlowPosition(p) : { x: left + 40 * clip.pastes, y: top + 40 * clip.pastes };
      insertGraph(clip.graph, { x: at.x - left, y: at.y - top });
    },
    [canvasRef, flow, insertGraph, pointer],
  );
  const duplicate = useCallback(() => {
    if (copy()) paste(true);
  }, [copy, paste]);

  return { insertGraph, copy, deleteSelected, paste, duplicate };
}
