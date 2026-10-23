import { createContext } from "react";
import type { Node } from "@xyflow/react";
import type { NodeStatus, Params } from "../runtime/types";

export type ToolNodeData = { type: string; params: Params };
export type ToolFlowNode = Node<ToolNodeData, "tool">;

/** What the window knows about each node's last run. */
export interface NodeRuntime {
  status: NodeStatus | "running";
  ms?: number;
  error?: string;
  bitmap?: ImageBitmap;
  size?: { width: number; height: number };
  /** Text output (possibly cut short). */
  text?: string;
  fileInfo?: { name: string; bytes: number };
  /** Where a Save node last wrote its file. */
  savedTo?: string;
}

export const RuntimeContext = createContext<Record<string, NodeRuntime>>({});

export interface Actions {
  setNodeFile(nodeId: string, file: File): void;
}

export const ActionsContext = createContext<Actions>({ setNodeFile: () => {} });
