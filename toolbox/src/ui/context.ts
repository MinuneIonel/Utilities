import { createContext } from "react";
import type { Node } from "@xyflow/react";
import type { Shape } from "../runtime/evaluate";
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
  /** Video, audio or document summary. */
  info?: string;
  /** While running: 0–1, or -1 when unknown. */
  progress?: number;
  progressLabel?: string;
}

export const RuntimeContext = createContext<Record<string, NodeRuntime>>({});

/** What each output carries, by "nodeId:port", so mapped nodes can show video handles. */
export const ShapesContext = createContext<ReadonlyMap<string, Shape>>(new Map());

export interface Actions {
  setNodeFile(nodeId: string, file: File): void;
  setNodeFiles(nodeId: string, files: File[]): void;
}

export const ActionsContext = createContext<Actions>({ setNodeFile: () => {}, setNodeFiles: () => {} });
