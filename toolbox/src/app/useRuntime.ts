// The graph runtime as the window sees it: the worker client, each node's status and picture,
// the shapes of every output (for wiring rules), the webcams, and the live preview.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { REGISTRY } from "../nodes";
import { RuntimeClient } from "../runtime/client";
import { outputShapes } from "../runtime/evaluate";
import type { NodeUpdate, ProgressUpdate } from "../runtime/worker";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";
import { Webcams, type CamSpec } from "../ui/webcam";
import { toGraph, type Flash } from "./flow";

export function useRuntime(nodes: ToolFlowNode[], edges: Edge[], flash: Flash) {
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});

  const onUpdate = useCallback((u: NodeUpdate) => {
    setRuntime((prev) => {
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
  }, []);
  const onProgress = useCallback((p: ProgressUpdate) => {
    // Also for nodes with no status yet, e.g. a Download fetching its link during a preview.
    setRuntime((prev) => ({ ...prev, [p.id]: { ...prev[p.id], status: "running", progress: p.fraction, progressLabel: p.label } }));
  }, []);
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const client = useMemo(() => new RuntimeClient(onUpdate, onProgress, (error) => flashRef.current(error)), [onUpdate, onProgress]);

  // Only params and wiring matter to the runtime; dragging nodes around shouldn't re-run anything.
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const runKey = useMemo(
    () => JSON.stringify([graph.nodes.map((n) => [n.id, n.type, n.params]), graph.edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])]),
    [graph],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const shapes = useMemo(() => outputShapes(graph, REGISTRY), [runKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cameras for Webcam nodes.
  const webcams = useMemo(
    () =>
      new Webcams(
        client,
        () => graphRef.current,
        (id, error) => setRuntime((prev) => ({ ...prev, [id]: { status: "error", error } })),
      ),
    [client],
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

  useEffect(() => {
    client.preview(graphRef.current);
  }, [runKey, client]);

  return { runtime, setRuntime, client, graph, graphRef, shapes, webcams, runKey };
}
