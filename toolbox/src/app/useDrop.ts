// Files dropped on the canvas go into the right input nodes, or new ones.
import { useCallback, useState, type DragEvent } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { inputNodeFor, MULTI_INPUTS } from "../nodes";
import type { Params } from "../runtime/types";
import type { ToolFlowNode } from "../ui/context";
import type { Flash, Point } from "./flow";

interface DropDeps {
  flow: ReactFlowInstance<ToolFlowNode, Edge>;
  flash: Flash;
  addNode: (type: string, position?: Point) => string;
  setNodeFile: (nodeId: string, file: File) => void;
  setNodeFiles: (nodeId: string, files: File[]) => void;
  setParams: (id: string, patch: Params) => void;
}

export function useDrop({ flow, flash, addNode, setNodeFile, setNodeFiles, setParams }: DropDeps) {
  const [dropping, setDropping] = useState(false);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const all = [...e.dataTransfer.files];
      const unknown = all.filter((f) => !inputNodeFor(f));
      if (unknown.length) flash(`Toolbox can't open ${unknown.map((f) => f.name).join(", ")}`);
      // A file dropped onto an input node goes into that node.
      const onto = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
      const ontoNode = onto ? flow.getNode(onto) : undefined;
      // An empty Several images / Several videos node (or the one dropped onto) takes all the dropped
      // files of its kind at once, unless they were dropped onto a single-file node of that kind.
      const taken = new Set<File>();
      for (const [multi, single] of Object.entries(MULTI_INPUTS)) {
        const mine = all.filter((f) => inputNodeFor(f) === single);
        const node =
          ontoNode?.data.type === multi ? ontoNode
          : ontoNode?.data.type === single ? undefined
          : flow.getNodes().find((n) => n.data.type === multi && !(n.data.params.assetIds as unknown[] | undefined)?.length);
        if (!node || !mine.length) continue;
        setNodeFiles(node.id, mine);
        for (const f of mine) taken.add(f);
      }
      // Fill empty inputs of the right kind first, then add new ones.
      const empty = flow.getNodes().filter((n) => n.data.type !== "input.text" && n.data.type.startsWith("input.") && !(n.data.type in MULTI_INPUTS) && !n.data.params.assetId);
      if (ontoNode && !(ontoNode.data.type in MULTI_INPUTS)) empty.unshift(ontoNode);
      let row = 0;
      for (const f of all.filter((f) => !taken.has(f))) {
        const type = inputNodeFor(f);
        if (!type) continue;
        const at = { x: pos.x, y: pos.y + row++ * 40 };
        if (type === "input.text") {
          const id = addNode(type, at);
          void f.text().then((text) => setParams(id, { text }));
          continue;
        }
        const i = empty.findIndex((n) => n.data.type === type);
        const target = i >= 0 ? empty.splice(i, 1)[0].id : addNode(type, at);
        setNodeFile(target, f);
      }
    },
    [addNode, flash, flow, setNodeFile, setNodeFiles, setParams],
  );
  return { dropping, setDropping, onDrop };
}
