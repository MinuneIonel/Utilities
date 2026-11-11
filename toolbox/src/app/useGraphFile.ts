// The graph as a file: autosave, New, Open and Save.
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { readGraph, serializeGraph } from "../graphs";
import { REGISTRY } from "../nodes";
import { openGraphFile, saveGraphFile } from "../platform";
import type { RuntimeClient } from "../runtime/client";
import type { Graph } from "../runtime/types";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";
import { STORE, toFlow, type Flash, type SetEdges, type SetNodes } from "./flow";

interface GraphFileDeps {
  graph: Graph;
  graphRef: MutableRefObject<Graph>;
  client: RuntimeClient;
  flow: ReactFlowInstance<ToolFlowNode, Edge>;
  setNodes: SetNodes;
  setEdges: SetEdges;
  setRuntime: Dispatch<SetStateAction<Record<string, NodeRuntime>>>;
  restoreFiles: (g: Graph) => Promise<number>;
  flash: Flash;
}

export function useGraphFile({ graph, graphRef, client, flow, setNodes, setEdges, setRuntime, restoreFiles, flash }: GraphFileDeps) {
  // Autosave. Storage holds a few MB, so a very large pasted or dropped text can fill it: say so once.
  const autosaveFailed = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE, serializeGraph(graph));
        autosaveFailed.current = false;
      } catch {
        if (!autosaveFailed.current) flash("This graph is too large to autosave. Use Save to keep it.");
        autosaveFailed.current = true;
      }
    }, 400);
    return () => clearTimeout(t);
  }, [flash, graph]);

  const loadGraph = useCallback(
    (g: Graph) => {
      const f = toFlow(g);
      setNodes(f.nodes);
      setEdges(f.edges);
      // Undo can bring the old nodes back with unchanged results, so the worker must send their pictures again.
      client.resendAll();
      setRuntime({});
      setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
    },
    [client, flow, setEdges, setNodes, setRuntime],
  );

  const openGraph = useCallback(async () => {
    const f = await openGraphFile();
    if (!f) return;
    try {
      const { graph: g, notes } = readGraph(f.text);
      if (!g.nodes.length) return flash(`${f.name} has no nodes this Toolbox can open.${notes.length ? ` ${notes.join(" ")}` : ""}`, 12000);
      loadGraph(g);
      const missing = await restoreFiles(g);
      const needsFiles = g.nodes.some((n) => REGISTRY.get(n.type)?.category === "input" && "assetId" in n.params && !n.params.path);
      const files = missing ? ` ${missing} file${missing === 1 ? " has" : "s have"} moved: drop ${missing === 1 ? "it" : "them"} in again.` : needsFiles ? " Drop the input files in again." : "";
      // Repairs stay up longer: they're worth reading.
      flash(`Opened ${f.name}.${files}${notes.length ? ` ${notes.join(" ")}` : ""}`, notes.length ? 15000 : 5000);
    } catch (err) {
      flash(`Couldn't open ${f.name}. ${err instanceof Error ? err.message : String(err)}`, 10000);
    }
  }, [flash, loadGraph, restoreFiles]);

  const saveGraph = useCallback(async () => {
    const where = await saveGraphFile(serializeGraph(graphRef.current), "graph.toolbox");
    if (where) flash(`Saved ${where.split(/[\\/]/).pop()}`);
  }, [flash, graphRef]);

  return { loadGraph, openGraph, saveGraph };
}
