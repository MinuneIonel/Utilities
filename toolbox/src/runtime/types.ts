// Plain data types shared by the graph runtime, the nodes and the UI.
// Nothing here touches the DOM, so the runtime can run in a worker or in Node.
import type { Grid } from "../../../ascii/src/engine/convert";
import type { Settings as AsciiSettings } from "../../../ascii/src/engine/settings";

/** What a wire carries. */
export type PortType = "image" | "video" | "audio" | "text" | "grid" | "document" | "file";

export interface ImageValue {
  kind: "image";
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
  /** Size relative to the full-size render: below 1 for downscaled preview frames. */
  scale?: number;
}

export interface TextValue {
  kind: "text";
  text: string;
  /** What the text is, so a Save node can pick the extension. Plain when absent. */
  format?: "plain" | "html" | "ansi" | "svg";
}

/** An ASCII Lab character grid plus what's needed to draw it again. */
export interface GridValue {
  kind: "grid";
  grid: Grid;
  /** The settings it was converted with (font, colours, mode). */
  settings: AsciiSettings;
  glyphs: string[];
}

export interface FileValue {
  kind: "file";
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** One frame of a video, at its place in time (seconds). */
export interface FrameItem {
  value: Value;
  timestamp: number;
  duration: number;
}

/**
 * A sequence of frames: a video file, a webcam, the pages of a PDF, or any of
 * those after a frame node has been mapped over every frame.
 */
export interface VideoValue {
  kind: "video";
  /** What each frame is. Image for real video; grid or text after e.g. ASCII convert. */
  of: "image" | "grid" | "text";
  /** Full-size frame size. */
  width: number;
  height: number;
  /** Seconds; 0 while unknown (a webcam that is still recording). */
  duration: number;
  /** Frames per second, 0 when unknown. */
  fps: number;
  /** The frame at the playhead: preview size during live preview. */
  poster: Value;
  /** Where the sound comes from, kept through every frame node so Encode video can add it back. */
  audioSource?: Blob;
  /** Set only by input nodes, when frames are still the file's own (lets encoders skip decoding). */
  origin?: Blob;
  /** Full-size frames in order. Each call starts from the beginning. */
  frames(signal?: AbortSignal): AsyncIterable<FrameItem>;
}

/** Encoded audio (any container ffmpeg reads, including a video file's sound). */
export interface AudioValue {
  kind: "audio";
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** Seconds, when known. */
  duration?: number;
}

export interface DocumentValue {
  kind: "document";
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

export type Value = ImageValue | TextValue | GridValue | FileValue | VideoValue | AudioValue | DocumentValue;

/** Turns a value of one port type into another, so e.g. a Grid output can feed an Image input. */
export interface Converter {
  from: PortType;
  to: PortType;
  label: string;
  convert(v: Value): Promise<Value>;
}

export type Params = Record<string, unknown>;

export interface PortDef {
  key: string;
  label: string;
  type: PortType;
  /** The node runs without it. */
  optional?: boolean;
  /**
   * Takes a whole video as well as a single value (e.g. Images to PDF makes one
   * page per frame). Without this, a video wired into a frame node maps the node
   * over every frame.
   */
  sequence?: boolean;
}

export type ParamDef =
  | { key: string; label: string; kind: "number"; min: number; max: number; step: number }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: "text"; multiline?: boolean }
  | { key: string; label: string; kind: "toggle" }
  /** Edited by a node-specific inspector panel (e.g. Dither Lab's effect stack). */
  | { key: string; label: string; kind: "custom" };

export interface RunContext {
  /** "preview" works on small frames and skips job nodes; "render" does everything at full size. */
  mode: "preview" | "render";
  /** Files dropped into the app, by id. */
  assets: ReadonlyMap<string, Blob>;
  /** The node being run. */
  nodeId?: string;
  /** Live frames from a Webcam node, by node id. */
  cameras?: ReadonlyMap<string, CameraFeed>;
  /** Reports progress of a long job, 0–1. */
  progress?(fraction: number, label?: string): void;
  /** Aborted when Render is cancelled. */
  signal?: AbortSignal;
}

/** The worker's side of a webcam: the newest frame, and a recording to stream from. */
export interface CameraFeed {
  /** Bumped on every new frame, so previews re-run. */
  version: number;
  latest?: ImageValue;
  /** Frames from now until the recording stops. */
  record(signal?: AbortSignal): AsyncIterable<FrameItem>;
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
  /** Hides params that don't apply to the current values. */
  visible?(key: string, params: Params): boolean;
  /** frame = runs during live preview; job = runs only on Render. */
  kind: "frame" | "job";
  /** Output nodes whose File result the window writes to disk after Render. */
  saves?: boolean;
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
