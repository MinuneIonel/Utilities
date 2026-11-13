// The graph runtime as the window sees it: the worker client, each node's status and picture,
// the shapes of every output (for wiring rules), the webcams, and the live preview.
// Every open graph (`scope`, its tab's id) keeps its own statuses and pictures, so moving between
// tabs shows each as it was, and a Render keeps reporting to its own tab while another is showing.
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import { REGISTRY } from "../nodes";
import { RuntimeClient } from "../runtime/client";
import { outputShapes } from "../runtime/evaluate";
import type { NodeUpdate, ProgressUpdate } from "../runtime/worker";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";
import { Webcams, type CamSpec } from "../ui/webcam";
import { toGraph, type Flash } from "./flow";

type RuntimeMap = Record<string, NodeRuntime>;
const NONE: RuntimeMap = {};

const closeAll = (m: RuntimeMap | undefined) => {
  for (const r of Object.values(m ?? {})) r?.bitmap?.close();
};

export function useRuntime(nodes: ToolFlowNode[], edges: Edge[], flash: Flash, scope: string, openIds: string[]) {
  const [all, setAll] = useState<Record<string, RuntimeMap>>({});
  const runtime = all[scope] ?? NONE;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const open = useRef(new Set(openIds));
  open.current = new Set(openIds);

  /** Changes one graph's statuses, whichever tab is showing; a closed tab's are gone for good. */
  const setRuntimeOf = useCallback(
    (s: string) => (change: SetStateAction<RuntimeMap>) => {
      if (!open.current.has(s)) return;
      setAll((prev) => {
        const cur = prev[s] ?? NONE;
        const next = typeof change === "function" ? change(cur) : change;
        return next === cur ? prev : { ...prev, [s]: next };
      });
    },
    [],
  );
  /** Changes the statuses of the graph on screen. */
  const setRuntime = useCallback((change: SetStateAction<RuntimeMap>) => setRuntimeOf(scopeRef.current)(change), [setRuntimeOf]);

  const onUpdate = useCallback(
    (u: NodeUpdate) => {
      // The tab was closed while this was on its way.
      if (!open.current.has(u.scope)) return void u.bitmap?.close();
      setRuntimeOf(u.scope)((prev) => {
        const old = prev[u.id];
        if (u.thumb) {
          if (!old || !u.bitmap) return prev;
          old.bitmap?.close();
          return { ...prev, [u.id]: { ...old, bitmap: u.bitmap, size: u.size } };
        }
        // A stale job node still shows its last render, marked as out of date.
        const hasOutput = u.status === "ok" || u.status === "cached" || u.status === "stale";
        const bitmap = u.bitmap ?? (hasOutput ? old?.bitmap : undefined);
        if (old?.bitmap && old.bitmap !== bitmap) old.bitmap.close();
        return {
          ...prev,
          [u.id]: {
            status: u.status,
            ms: u.ms,
            error: u.error,
            bitmap,
            size: u.size ?? (hasOutput ? old?.size : undefined),
            text: u.text,
            fileInfo: u.fileInfo,
            info: u.info ?? (u.status === "running" ? old?.info : undefined),
            savedTo: u.mode === "preview" && u.status === "cached" ? old?.savedTo : undefined,
          },
        };
      });
    },
    [setRuntimeOf],
  );
  const onProgress = useCallback(
    (p: ProgressUpdate) => {
      if (!open.current.has(p.scope)) return;
      // Also for nodes with no status yet, e.g. a Download fetching its link during a preview.
      setRuntimeOf(p.scope)((prev) => ({ ...prev, [p.id]: { ...prev[p.id], status: "running", progress: p.fraction, progressLabel: p.label } }));
    },
    [setRuntimeOf],
  );
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const client = useMemo(() => new RuntimeClient(onUpdate, onProgress, (error) => flashRef.current(error)), [onUpdate, onProgress]);
  client.scope = scope;

  // A closed tab's pictures are let go, here and in the worker.
  const known = useRef(openIds);
  useEffect(() => {
    const gone = known.current.filter((id) => !openIds.includes(id));
    known.current = openIds;
    if (!gone.length) return;
    for (const id of gone) client.forget(id);
    setAll((prev) => {
      const next = { ...prev };
      for (const id of gone) {
        closeAll(next[id]);
        delete next[id];
      }
      return next;
    });
  }, [client, openIds]);

  // Only params and wiring matter to the runtime; dragging nodes around shouldn't re-run anything.
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const runKey = useMemo(
    () => JSON.stringify([graph.nodes.map((n) => [n.id, n.type, n.params]), graph.edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])]),
    [graph],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const shapes = useMemo(() => outputShapes(graph, REGISTRY), [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cameras for Webcam nodes: only the ones in the graph on screen are open.
  const webcams = useMemo(
    () =>
      new Webcams(
        client,
        () => graphRef.current,
        (id, error) => setRuntime((prev) => ({ ...prev, [id]: { status: "error", error } })),
      ),
    [client, setRuntime],
  );
  const camKey = JSON.stringify(
    graph.nodes
      .filter((n) => n.type === "input.webcam")
      .map((n): CamSpec => {
        const [w, h] = String(n.params.resolution || "1280x720").split("x").map(Number);
        return { id: n.id, width: w || 1280, height: h || 720, mirror: n.params.mirror !== false, sound: n.params.sound !== false };
      }),
  );
  useEffect(() => webcams.sync(JSON.parse(camKey)), [camKey, webcams]);
  useEffect(() => () => webcams.closeAll(), [webcams]);

  // Moving to another tab previews its graph; unchanged results come from the worker's cache.
  useEffect(() => {
    client.preview(graphRef.current);
  }, [runKey, client, scope]);

  // Back in the window, a graph that reads a folder looks in it again: files may have come since.
  useEffect(() => {
    const onFocus = () => {
      if (!graphRef.current.nodes.some((n) => n.type === "input.folder")) return;
      client.relist();
      client.preview(graphRef.current);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [client]);

  return { runtime, setRuntime, setRuntimeOf, client, graph, graphRef, shapes, webcams, runKey };
}
