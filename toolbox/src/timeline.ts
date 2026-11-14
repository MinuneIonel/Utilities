// The timeline's rules, kept apart from React and the nodes so they can be tested on their own:
// which video or sound a node's times are in, how seconds map to pixels as you zoom and pan, the
// ruler's ticks, which parts are kept or taken out, and what a dragged handle writes.
import { formatMarks, formatParts, parseMarks, parseParts } from "./nodes/clips.ts";
import type { Graph, NodeTimeline, Params, PortDef } from "./runtime/types";

export interface Span {
  t0: number;
  t1: number;
}
export interface TimeRange {
  start: number;
  end: number;
}

/** Nodes a timeline can show the content of. */
export const TIME_SOURCES = new Set(["input.video", "input.download", "input.audio"]);

/** What the walk needs to know about a node type (a NodeDef fits). */
export interface WalkDef {
  kind: "frame" | "job";
  live?: boolean;
  inputs: PortDef[];
  outputs: PortDef[];
}

export interface TimeSource {
  /** The file node the pictures come from, and its output. */
  source: { id: string; port: string };
  /** The value the target node's times are in: its input (or the source itself). */
  base: { id: string; port: string };
  /** The target is the source: show all of its file, in the file's seconds. */
  whole: boolean;
}

/**
 * The video or sound a node's times are in. A file node is its own; any other node looks at what's
 * wired into it, back through frame nodes (which keep time) to the first Video file, Download or
 * Audio file node. Undefined when there is none (an image, a webcam, a PDF's pages).
 */
export function findTimeSource(graph: Graph, targetId: string, defOf: (type: string) => WalkDef | undefined): TimeSource | undefined {
  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const target = node(targetId);
  if (!target) return undefined;
  if (TIME_SOURCES.has(target.type)) {
    const port = target.type === "input.audio" || (target.type === "input.download" && (target.params.quality === "audio" || target.params.quality === "mp3")) ? "audio" : "video";
    return { source: { id: target.id, port }, base: { id: target.id, port }, whole: true };
  }
  const seen = new Set<string>();
  /** The source behind `id`'s inputs, in the order the node lists them. */
  const sourceOf = (id: string): { id: string; port: string } | undefined => {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const n = node(id);
    const def = n && defOf(n.type);
    if (!def) return undefined;
    const order = (h: string) => def.inputs.findIndex((p) => p.key === h);
    const into = graph.edges.filter((e) => e.target === id).sort((a, b) => order(a.targetHandle) - order(b.targetHandle));
    for (const e of into) {
      const up = node(e.source);
      if (!up) continue;
      if (TIME_SOURCES.has(up.type)) return { id: up.id, port: e.sourceHandle };
      const upDef = defOf(up.type);
      if (upDef?.kind === "frame" && !upDef.live) {
        const s = sourceOf(up.id);
        if (s) return s;
      }
    }
    return undefined;
  };
  const def = defOf(target.type);
  if (!def) return undefined;
  const order = (h: string) => def.inputs.findIndex((p) => p.key === h);
  const into = graph.edges.filter((e) => e.target === targetId).sort((a, b) => order(a.targetHandle) - order(b.targetHandle));
  for (const e of into) {
    const up = node(e.source);
    if (!up) continue;
    const upDef = defOf(up.type);
    const type = upDef?.outputs.find((p) => p.key === e.sourceHandle)?.type;
    // Only what carries time: a video, a sound, or a frame node mapped over a video.
    if (type !== "video" && type !== "audio" && upDef?.kind !== "frame") continue;
    const source = TIME_SOURCES.has(up.type) ? { id: up.id, port: e.sourceHandle } : upDef?.kind === "frame" && !upDef.live ? sourceOf(up.id) : undefined;
    if (source) return { source, base: { id: up.id, port: e.sourceHandle }, whole: false };
  }
  return undefined;
}

/** Just the nodes that feed `id` (and it), so working out its value runs nothing else. */
export function upstreamGraph(graph: Graph, id: string): Graph {
  const keep = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const x = stack.pop()!;
    if (keep.has(x)) continue;
    keep.add(x);
    for (const e of graph.edges) if (e.target === x) stack.push(e.source);
  }
  return { version: 1, nodes: graph.nodes.filter((n) => keep.has(n.id)), edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

/**
 * Identifies a strip: the same key, the same pictures. Moving the playhead never changes it, and
 * when the whole file shows, neither does trimming it.
 */
export function stripKey(graph: Graph, ts: TimeSource): string {
  const src = graph.nodes.find((n) => n.id === ts.source.id);
  const params: Params = { ...src?.params };
  delete params.at;
  if (ts.whole) {
    delete params.start;
    delete params.end;
    delete params.speed;
  }
  return JSON.stringify([ts.source, ts.base, ts.whole, src?.type, params]);
}

// ------------------------------------------------------------ time and pixels

/** The x of time `t` in a strip `width` pixels wide showing `span`. */
export const xOf = (t: number, span: Span, width: number) => ((t - span.t0) / (span.t1 - span.t0 || 1)) * width;

/** The time at x. */
export const tOf = (x: number, span: Span, width: number) => span.t0 + (x / (width || 1)) * (span.t1 - span.t0);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Zooms by `factor` (below 1 zooms in) keeping time `at` under the pointer, never past the ends or
 * closer than `minSpan` seconds across.
 */
export function zoomSpan(span: Span, at: number, factor: number, duration: number, minSpan = 0.2): Span {
  const len = clamp((span.t1 - span.t0) * factor, Math.min(minSpan, duration), duration);
  const k = (at - span.t0) / (span.t1 - span.t0 || 1);
  return panSpan({ t0: at - k * len, t1: at - k * len + len }, 0, duration);
}

/** Moves the view `dt` seconds, stopping at the ends. */
export function panSpan(span: Span, dt: number, duration: number): Span {
  const len = span.t1 - span.t0;
  const t0 = clamp(span.t0 + dt, 0, Math.max(0, duration - len));
  return { t0, t1: t0 + len };
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Ruler ticks at least `minPx` apart: a round step, and the times it falls on within the view. */
export function rulerTicks(span: Span, width: number, minPx = 70): { step: number; times: number[] } {
  const len = span.t1 - span.t0;
  const step = STEPS.find((s) => (s / (len || 1)) * width >= minPx) ?? STEPS[STEPS.length - 1];
  const times: number[] = [];
  for (let t = Math.ceil(span.t0 / step - 1e-9) * step; t <= span.t1 + 1e-9; t += step) times.push(Math.round(t * 1000) / 1000 + 0);
  return { step, times };
}

/** Holding Shift snaps to whole seconds. */
export const snapTime = (t: number, shift: boolean) => (shift ? Math.round(t) : t);

// ------------------------------------------------------------ what the handles mean

/** Start and End as they take effect: End 0 (or past the end) is the end. */
export function effectiveRange(start: unknown, end: unknown, duration: number): TimeRange {
  const s = clamp(Number(start) || 0, 0, duration);
  const e = Number(end) || 0;
  return { start: s, end: e > s ? Math.min(e, duration) : duration };
}

/** Shortest range a drag leaves, in seconds. */
export const MIN_RANGE = 0.1;

/**
 * The param value for a Start or End handle dragged to `t`: kept on its side of the other one,
 * and End within `tail` of the end written as 0 (to the end), as the node reads it.
 */
export function rangeValue(which: "start" | "end", t: number, range: TimeRange, duration: number, tail = 0.02): number {
  if (which === "start") return round3(clamp(t, 0, Math.max(0, range.end - MIN_RANGE)));
  const e = clamp(t, Math.min(duration, range.start + MIN_RANGE), duration);
  return e >= duration - tail ? 0 : round3(e);
}

const round3 = (t: number) => Math.round(t * 1000) / 1000;

/** What a node's timeline shows for its settings. */
export interface TimelineMarks {
  use: "range" | "marks" | "parts" | "cuts" | undefined;
  /** Bright parts; the rest is drawn hatched (taken out). Undefined when nothing is taken out. */
  kept?: TimeRange[];
  range?: TimeRange;
  marks?: number[];
  parts?: TimeRange[];
  cuts?: number[];
}

/** Reads a node's time settings for drawing, `duration` seconds long. */
export function timelineMarks(tl: NodeTimeline | undefined, p: Params, duration: number): TimelineMarks {
  if (!tl) return { use: undefined };
  const use = tl.uses?.(p) ?? (tl.range ? "range" : tl.marks ? "marks" : tl.parts ? "parts" : undefined);
  if (use === "range" && tl.range) {
    const range = effectiveRange(p[tl.range.start], p[tl.range.end], duration);
    const kept = tl.remove?.(p)
      ? [
          { start: 0, end: range.start },
          { start: range.end, end: duration },
        ].filter((r) => r.end > r.start)
      : [range];
    return { use, range, kept };
  }
  if (use === "marks" && tl.marks) return { use, marks: parseMarks(String(p[tl.marks] ?? "")) };
  if (use === "parts" && tl.parts) {
    const parts = parseParts(String(p[tl.parts] ?? ""), duration);
    return { use, parts, kept: parts.map((r) => ({ start: clamp(r.start, 0, duration), end: clamp(r.end, 0, duration) })) };
  }
  if (use === "cuts") return { use, cuts: tl.cuts?.(p, duration) ?? [] };
  return { use: undefined };
}

/** Cut times with one moved (or added, at index -1, or removed, with t undefined), as Cut at text. */
export function editMarks(marks: number[], index: number, t: number | undefined): string {
  const next = marks.slice();
  if (index < 0) next.push(t ?? 0);
  else if (t === undefined) next.splice(index, 1);
  else next[index] = t;
  return formatMarks(next.map(round3));
}

/** Parts with one replaced (or added, at index -1, or removed, with r undefined), as Parts text. */
export function editParts(parts: TimeRange[], index: number, r: TimeRange | undefined): string {
  const next = parts.slice();
  if (index < 0) next.push(r!);
  else if (!r) next.splice(index, 1);
  else next[index] = r;
  return formatParts(next.map((x) => ({ start: round3(Math.min(x.start, x.end)), end: round3(Math.max(x.start, x.end)) })));
}

// ------------------------------------------------------------ the playhead

/**
 * Where the playhead is, in the strip's seconds, from the source's Playhead % (`at`): within the
 * part the source keeps, which with `whole` sits at `kept` in the file.
 */
export function playheadTime(at: unknown, duration: number, kept?: TimeRange): number {
  const f = clamp(Number(at) || 0, 0, 100) / 100;
  return kept ? kept.start + (kept.end - kept.start) * f : duration * f;
}

/** Playhead % for a time in the strip's seconds (the inverse of playheadTime). */
export function atOfTime(t: number, duration: number, kept?: TimeRange): number {
  const lo = kept?.start ?? 0;
  const len = kept ? kept.end - kept.start : duration;
  return len > 0 ? Math.round((clamp((t - lo) / len, 0, 1) * 100) * 1000) / 1000 : 0;
}
