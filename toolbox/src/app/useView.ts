// What the canvas shows besides the nodes: the node picked to fill the background (and the video
// whose playhead it follows), how wires look, and the settings panel's width.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { CONVERTERS, REGISTRY } from "../nodes";
import { canConnect, type outputShapes } from "../runtime/evaluate";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";
import { inputPort, readStore, VIEW_STORE, writeStore, type View } from "./flow";

export function useView(nodes: ToolFlowNode[], edges: Edge[], shapes: ReturnType<typeof outputShapes>, runtime: Record<string, NodeRuntime>) {
  const [view, setView] = useState<View>(() => readStore<View>(VIEW_STORE, { inspectorWidth: 320, inspectorHidden: false }));
  useEffect(() => writeStore(VIEW_STORE, view), [view]);
  const viewRef = useRef(view);
  viewRef.current = view;

  // The background shows one chosen node (its eye button, or ⌥-click), not whatever is selected.
  const togglePreview = useCallback((id: string) => setView((v) => ({ ...v, preview: v.preview === id ? undefined : id })), []);

  // Like TouchDesigner's background view, for the node picked with its eye button.
  const shownId = nodes.some((n) => n.id === view.preview) ? view.preview : undefined;
  const shown = shownId ? runtime[shownId] : undefined;
  const shownTitle = shownId ? REGISTRY.get(nodes.find((n) => n.id === shownId)!.data.type)?.title : undefined;
  // The video the shown node is made from, whose playhead the scrubber moves.
  const scrubbed = useMemo(() => {
    if (!shownId) return undefined;
    const seen = new Set<string>();
    const stack = [shownId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = nodes.find((x) => x.id === id);
      if (n && (n.data.type === "input.video" || n.data.type === "input.download") && "at" in n.data.params) return n;
      for (const e of edges) if (e.target === id) stack.push(e.source);
    }
    return undefined;
  }, [edges, nodes, shownId]);

  const resizeInspector = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = viewRef.current.inspectorHidden ? 0 : viewRef.current.inspectorWidth;
    const move = (m: PointerEvent) => {
      const w = startW + startX - m.clientX;
      setView((v) => (w < 160 ? { ...v, inspectorHidden: true } : { ...v, inspectorHidden: false, inspectorWidth: Math.min(640, Math.max(240, w)) }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);
  const toggleInspector = useCallback(() => setView((v) => ({ ...v, inspectorHidden: !v.inspectorHidden })), []);

  // Wires that pass through a converter are dashed and labelled with it; wires carrying video are thicker.
  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const t = nodes.find((n) => n.id === e.target);
        const from = shapes.get(`${e.source}:${e.sourceHandle}`);
        const def = t && REGISTRY.get(t.data.type);
        const port = t && inputPort(t.data.type, e.targetHandle ?? null);
        const conv = from && def && port ? canConnect(from, def, port, CONVERTERS).converter : undefined;
        const cls = [conv ? "converted" : "", from?.seq ? "seq" : ""].filter(Boolean).join(" ");
        return conv || cls ? { ...e, label: conv?.label, className: cls } : e;
      }),
    [edges, nodes, shapes],
  );

  return { view, togglePreview, toggleInspector, resizeInspector, shownId, shown, shownTitle, scrubbed, displayEdges };
}
