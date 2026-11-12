// Undo and redo: snapshots of the whole graph (settings, wires, positions). A change becomes a
// step once things settle, so a slider drag is one step, not fifty. Each tab has its own steps.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "../runtime/types";
import { toFlow, type Flash, type SetEdges, type SetNodes } from "./flow";

/** Undo steps kept. */
const HISTORY = 100;
/** Changes closer together than this (a slider drag, a node drag) undo as one step. */
const HISTORY_SETTLE = 400;

interface Steps {
  past: string[];
  future: string[];
  /** The graph as of the last step. */
  at: string;
  /** Changes now aren't steps (files coming back, where a Save node wrote). */
  quiet: boolean;
}

/** `docId` is the tab on screen; `openIds` every open tab, so closed ones' steps are let go. */
export function useHistory(graph: Graph, docId: string, openIds: string[], setNodes: SetNodes, setEdges: SetEdges, flash: Flash) {
  const graphKey = useMemo(() => JSON.stringify(graph), [graph]);
  const graphKeyRef = useRef(graphKey);
  const history = useRef<Steps>({ past: [], future: [], at: graphKey, quiet: false });
  const byDoc = useRef(new Map<string, Steps>());
  const shownDoc = useRef(docId);
  // Re-renders when the number of steps changes, for the Undo and Redo buttons.
  const [, setCount] = useState(0);
  const countSteps = useCallback(() => setCount((n) => n + 1), []);

  /** Makes the change since the last step a step of its own; says whether there was one. */
  const settle = (h: Steps, now: string) => {
    if (now === h.at) return false;
    if (!h.quiet) {
      h.past.push(h.at);
      if (h.past.length > HISTORY) h.past.shift();
      h.future = [];
    }
    h.at = now;
    return true;
  };
  const commitHistory = useCallback(() => {
    if (settle(history.current, graphKeyRef.current)) countSteps();
  }, [countSteps]);

  // Another tab came on screen (its graph arrives in this same render). What the old tab changed
  // last becomes its step, measured against its own graph, before switching to the new tab's steps.
  if (shownDoc.current !== docId) {
    settle(history.current, graphKeyRef.current);
    byDoc.current.set(shownDoc.current, history.current);
    const mine = byDoc.current.get(docId);
    // A tab in the background only changes by files coming back or Save nodes noting what they
    // wrote: not something to undo.
    if (mine) mine.at = graphKey;
    history.current = mine ?? { past: [], future: [], at: graphKey, quiet: false };
    shownDoc.current = docId;
  }
  graphKeyRef.current = graphKey;

  useEffect(() => {
    for (const id of byDoc.current.keys()) if (!openIds.includes(id)) byDoc.current.delete(id);
  }, [openIds]);

  // A change that hasn't settled into a step yet can still be undone.
  const h = history.current;
  const canUndo = h.past.length > 0 || graphKey !== h.at;
  const canRedo = h.future.length > 0 && graphKey === h.at;
  useEffect(() => {
    if (graphKey === history.current.at) return;
    const t = setTimeout(commitHistory, HISTORY_SETTLE);
    return () => clearTimeout(t);
  }, [commitHistory, graphKey]);

  /** Runs a change that isn't something to undo (files coming back, where a Save node wrote). */
  const withoutHistory = useCallback(
    (change: () => void) => {
      const steps = history.current;
      steps.quiet = true;
      change();
      setTimeout(() => {
        // Another tab may be showing by now; switching already settled this one's change quietly.
        if (history.current === steps) commitHistory();
        steps.quiet = false;
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
