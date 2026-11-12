// Undo and redo: snapshots of the whole graph (settings, wires, positions). A change becomes a
// step once things settle, so a slider drag is one step, not fifty.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "../runtime/types";
import { toFlow, type Flash, type SetEdges, type SetNodes } from "./flow";

/** Undo steps kept. */
const HISTORY = 100;
/** Changes closer together than this (a slider drag, a node drag) undo as one step. */
const HISTORY_SETTLE = 400;

export function useHistory(graph: Graph, setNodes: SetNodes, setEdges: SetEdges, flash: Flash) {
  const graphKey = useMemo(() => JSON.stringify(graph), [graph]);
  const graphKeyRef = useRef(graphKey);
  graphKeyRef.current = graphKey;
  const history = useRef({ past: [] as string[], future: [] as string[], at: graphKey, quiet: false });
  // How many steps each way, for the Undo and Redo buttons.
  const [steps, setSteps] = useState({ past: 0, future: 0 });
  const countSteps = useCallback(() => setSteps({ past: history.current.past.length, future: history.current.future.length }), []);
  const commitHistory = useCallback(() => {
    const h = history.current;
    const now = graphKeyRef.current;
    if (now === h.at) return;
    if (!h.quiet) {
      h.past.push(h.at);
      if (h.past.length > HISTORY) h.past.shift();
      h.future = [];
    }
    h.at = now;
    countSteps();
  }, [countSteps]);
  // A change that hasn't settled into a step yet can still be undone.
  const canUndo = steps.past > 0 || graphKey !== history.current.at;
  const canRedo = steps.future > 0 && graphKey === history.current.at;
  useEffect(() => {
    if (graphKey === history.current.at) return;
    const t = setTimeout(commitHistory, HISTORY_SETTLE);
    return () => clearTimeout(t);
  }, [commitHistory, graphKey]);

  /** Runs a change that isn't something to undo (files coming back, where a Save node wrote). */
  const withoutHistory = useCallback(
    (change: () => void) => {
      history.current.quiet = true;
      change();
      setTimeout(() => {
        commitHistory();
        history.current.quiet = false;
      }, HISTORY_SETTLE + 100);
    },
    [commitHistory],
  );

  const applySnapshot = useCallback(
    (key: string) => {
      const f = toFlow(JSON.parse(key) as Graph);
      // Keep what's selected, so the inspector stays on the node you were changing.
      setNodes((ns) => {
        const selected = new Set(ns.filter((n) => n.selected).map((n) => n.id));
        return f.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
      });
      setEdges(f.edges);
    },
    [setEdges, setNodes],
  );
  const undo = useCallback(() => {
    commitHistory();
    const h = history.current;
    const prev = h.past.pop();
    if (prev === undefined) return flash("Nothing to undo");
    h.future.push(h.at);
    h.at = prev;
    applySnapshot(prev);
    countSteps();
  }, [applySnapshot, commitHistory, countSteps, flash]);
  const redo = useCallback(() => {
    commitHistory();
    const h = history.current;
    const next = h.future.pop();
    if (next === undefined) return flash("Nothing to redo");
    h.past.push(h.at);
    h.at = next;
    applySnapshot(next);
    countSteps();
  }, [applySnapshot, commitHistory, countSteps, flash]);

  return { undo, redo, canUndo, canRedo, withoutHistory };
}
