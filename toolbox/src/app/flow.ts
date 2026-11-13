// Plain helpers the window's hooks share: converting between the saved graph and React Flow's
// nodes and edges, small graph queries, and the few values kept in localStorage.
import type { Dispatch, SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import { REGISTRY } from "../nodes";
import type { Graph, Params } from "../runtime/types";
import type { ToolFlowNode } from "../ui/context";

export const VIEW_STORE = "toolbox.view";
export const OUTPUTS_STORE = "toolbox.outputs";
export const UPDATE_STORE = "toolbox.update-check";
/** Roughly half a node card, so a new node lands centred under the pointer. */
export const NODE_HALF_WIDTH = 110;
/** How shortcuts are written on this computer. */
export const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** The Add node menu: where it is, and the wire it was opened from, if any. */
export interface MenuState {
  /** Pointer position in the canvas, in pixels. */
  x: number;
  y: number;
  /** Where the new node goes, in graph coordinates. */
  at: { x: number; y: number };
  from?: { node: string; handle: string };
  /** Opens on the Workflows tab. */
  workflows?: boolean;
}

export interface OutputEntry {
  id: string;
  name: string;
  bytes: number;
  savedTo: string;
}

export interface View {
  /** The node whose output fills the canvas background. */
  preview?: string;
  inspectorWidth: number;
  inspectorHidden: boolean;
  /** The timeline under the canvas is folded down to its title bar. */
  timelineHidden?: boolean;
}

export type Point = { x: number; y: number };

export function toFlow(g: Graph): { nodes: ToolFlowNode[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: "tool", position: n.position, data: { type: n.type, params: n.params } })),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

export function toGraph(nodes: ToolFlowNode[], edges: Edge[]): Graph {
  return {
    version: 1,
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, params: n.data.params, position: n.position })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? "",
      target: e.target,
      targetHandle: e.targetHandle ?? "",
    })),
  };
}

export function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable */
  }
}

/** The node and everything that feeds it, so one Save node can render on its own. */
export function upstreamOf(g: Graph, id: string): Graph {
  const keep = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const t = stack.pop()!;
    for (const e of g.edges) if (e.target === t && !keep.has(e.source)) keep.add(e.source), stack.push(e.source);
  }
  return { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

/** Params without the files a Save node wrote, for a copy that hasn't saved anything yet. */
export function withoutLastSaved(p: Params): Params {
  const { lastSaved: _, ...rest } = p;
  return rest;
}

/** Whether a graph holds anything the user put in: files, links or their own text. */
export function hasContent(nodes: ToolFlowNode[]): boolean {
  const defaultText = REGISTRY.get("input.text")?.defaults().text;
  return nodes.some(({ data: { type, params: p } }) => {
    if (p.assetId || (p.assetIds as unknown[] | undefined)?.length || p.path || (p.paths as unknown[] | undefined)?.length) return true;
    if (type === "input.download") return !!String(p.url ?? "").trim();
    if (type === "input.text") return !!String(p.text ?? "").trim() && p.text !== defaultText;
    return false;
  });
}

/**
 * Whether keys typed now belong to a text field rather than the graph. Sliders, menus and
 * checkboxes keep focus after you use them, but ⌘Z there should undo the change, not do nothing.
 * Number boxes are text you type, so ⌘A/⌘C/⌘V there stay in the box (not select or paste nodes).
 */
export const typingIn = (el: Element | null) =>
  !!el?.closest('textarea, [contenteditable]:not([contenteditable="false"]), input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="password"], input[type="number"]');

export const inputPort = (nodeType: string, key: string | null) => REGISTRY.get(nodeType)?.inputs.find((p) => p.key === key);

export type SetNodes = Dispatch<SetStateAction<ToolFlowNode[]>>;
export type SetEdges = Dispatch<SetStateAction<Edge[]>>;
export type Flash = (text: string, ms?: number) => void;
