// The timeline under the canvas: which node it's for (the selected one, else the one behind the
// graph), the video or sound that node's times are in, and the strip of pictures the worker sends
// for it. Strips are kept by what they show, so going back to a node shows its strip at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { REGISTRY } from "../nodes";
import type { RuntimeClient } from "../runtime/client";
import type { Graph, NodeDef } from "../runtime/types";
import type { StripMessage } from "../runtime/worker";
import { findTimeSource, stripKey, upstreamGraph, type TimeSource } from "../timeline";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";

export interface Strip {
  key: string;
  kind?: "video" | "audio";
  /** Seconds the strip spans: the whole file, or the part the target's input has. */
  duration: number;
  fps: number;
  /** How many pictures are coming, and those that came (in order, with gaps until they arrive). */
  count: number;
  thumbs: (ImageBitmap | undefined)[];
  wave?: ImageBitmap;
  error?: string;
  done: boolean;
}

/** Strips kept for going back to a node; each is a couple of dozen small pictures. */
const KEEP = 8;

const defOf = (t: string) => REGISTRY.get(t);

const closeStrip = (s: Strip) => {
  for (const b of s.thumbs) b?.close();
  s.wave?.close();
};

interface TimelineDeps {
  client: RuntimeClient;
  graph: Graph;
  runKey: string;
  nodes: ToolFlowNode[];
  selectedId?: string;
  shownId?: string;
  runtime: Record<string, NodeRuntime>;
  /** False while the timeline is folded away or Graph view is hidden: nothing is asked of the worker. */
  enabled: boolean;
}

export function useTimeline(d: TimelineDeps) {
  const { client, graph, runKey, selectedId, shownId, enabled } = d;
  const found = useMemo(() => {
    for (const id of [selectedId, shownId]) {
      const ts = id ? findTimeSource(graph, id, defOf) : undefined;
      if (id && ts) return { id, ts };
    }
    return undefined;
  }, [runKey, selectedId, shownId]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = found ? stripKey(graph, found.ts) : "";

  const cache = useRef(new Map<string, Strip>());
  const current = useRef<{ reqId: number; strip?: Strip }>({ reqId: 0 });
  const [strip, setStrip] = useState<Strip | undefined>();
  const [attempt, setAttempt] = useState(0);

  // Ask for the strip when what it shows changes (not when the playhead moves).
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useEffect(() => {
    if (!key || !found || !enabled) return;
    // A strip still coming in is dropped (its request is stopped by the next one, or ignored).
    const old = current.current.strip;
    if (old && !old.done) closeStrip(old);
    const hit = cache.current.get(key);
    if (hit) {
      current.current = { reqId: 0, strip: hit };
      setStrip(hit);
      return;
    }
    const s: Strip = { key, duration: 0, fps: 0, count: 0, thumbs: [], done: false };
    const { ts } = found;
    current.current = { reqId: client.strip(upstreamGraph(graphRef.current, ts.base.id), ts.source, ts.base, ts.whole), strip: s };
    setStrip(s);
  }, [key, enabled, attempt, client]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    client.onStrip = (m: StripMessage) => {
      const cur = current.current;
      const s = cur.strip;
      if (m.reqId !== cur.reqId || !s) {
        if (m.type === "strip-thumb" || m.type === "strip-wave") m.bitmap.close();
        return;
      }
      let next: Strip;
      if (m.type === "strip-info") next = { ...s, kind: m.kind, duration: m.duration, fps: m.fps, count: m.count };
      else if (m.type === "strip-thumb") {
        const thumbs = s.thumbs.slice();
        thumbs[m.index]?.close();
        thumbs[m.index] = m.bitmap;
        next = { ...s, thumbs };
      } else if (m.type === "strip-wave") next = { ...s, wave: m.bitmap };
      else {
        next = { ...s, done: true, error: m.error };
        if (!m.error) {
          cache.current.set(next.key, next);
          // The oldest go, unless one is on screen.
          for (const [k, v] of cache.current) {
            if (cache.current.size <= KEEP) break;
            if (k === next.key) continue;
            cache.current.delete(k);
            closeStrip(v);
          }
        }
      }
      cur.strip = next;
      setStrip(next);
    };
    return () => {
      client.onStrip = undefined;
    };
  }, [client]);

  // A strip that failed (the file wasn't there yet) is asked for again once its source has a result.
  const status = found ? d.runtime[found.ts.source.id]?.status : undefined;
  useEffect(() => {
    if (strip?.error && strip.key === key && (status === "ok" || status === "cached")) setAttempt((a) => a + 1);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = found ? d.nodes.find((n) => n.id === found.id) : undefined;
  const source = found ? d.nodes.find((n) => n.id === found.ts.source.id) : undefined;
  const def: NodeDef | undefined = target ? REGISTRY.get(target.data.type) : undefined;
  return {
    target,
    def,
    source,
    ts: found?.ts as TimeSource | undefined,
    strip: strip && strip.key === key ? strip : undefined,
  };
}

export type TimelineState = ReturnType<typeof useTimeline>;
