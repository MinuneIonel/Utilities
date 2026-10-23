// Plain data types shared by the graph runtime, the nodes and the UI.
// Nothing here touches the DOM, so the runtime can run in a worker or in Node.

/** What a wire carries. The full set from the design; phase 2 uses image and file. */
export type PortType = "image" | "video" | "audio" | "text" | "grid" | "document" | "file";

export interface ImageValue {
  kind: "image";
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
}

export interface TextValue {
  kind: "text";
  text: string;
}

export interface FileValue {
  kind: "file";
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type Value = ImageValue | TextValue | FileValue;

export type Params = Record<string, unknown>;

export interface PortDef {
  key: string;
  label: string;
  type: PortType;
}

export type ParamDef =
  | { key: string; label: string; kind: "number"; min: number; max: number; step: number }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: "text" }
  | { key: string; label: string; kind: "toggle" }
  /** Edited by a node-specific inspector panel (e.g. Dither Lab's effect stack). */
  | { key: string; label: string; kind: "custom" };

export interface RunContext {
  /** "preview" works on small frames and skips job nodes; "render" does everything at full size. */
  mode: "preview" | "render";
  /** Files dropped into the app, by id. */
  assets: ReadonlyMap<string, Blob>;
}

export interface NodeDef {
  type: string;
  title: string;
  category: "input" | "image" | "video" | "audio" | "text" | "pdf" | "output";
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  defaults(): Params;
  /** frame = runs during live preview; job = runs only on Render. */
  kind: "frame" | "job";
  /**
   * Extra cache-key material for nodes whose output depends on more than
   * params and inputs (a file input's asset id, or the run mode).
   */
  cacheKey?(params: Params, ctx: RunContext): string;
  run(inputs: Record<string, Value | undefined>, params: Params, ctx: RunContext): Promise<Record<string, Value>>;
}

export interface GraphNode {
  id: string;
  type: string;
  params: Params;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface Graph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type NodeStatus = "ok" | "cached" | "skipped" | "waiting" | "error";

export interface NodeResult {
  status: NodeStatus;
  outputs: Record<string, Value>;
  key?: string;
  ms?: number;
  error?: string;
}
