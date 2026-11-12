// Open graphs, one per tab. The one on screen lives in React Flow's state; the others wait here
// with their own nodes, selection and view. All of them are autosaved together, so the app
// reopens with the same tabs, and a graph from a file knows whether it has changes to save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEdgesState, useNodesState, type Edge, type ReactFlowInstance, type Viewport } from "@xyflow/react";
import { newId, parseGraph, serializeGraph, starterGraph } from "../graphs";
import type { Graph } from "../runtime/types";
import type { ToolFlowNode } from "../ui/context";
import { DOCS_STORE, fingerprint, loadDocs, nameFromPath, uniqueName, UNTITLED, afterClose, type SavedDocs } from "./documents";
import { hasContent, toFlow, toGraph, type Flash } from "./flow";

export interface Doc {
  id: string;
  name: string;
  /** The file it was opened from or saved to (desktop app only). */
  path?: string;
  /** The graph's fingerprint when last opened or saved (or made, without a file). */
  saved: string;
  /** A starter graph as it was made: an opened file or a workflow takes its tab. */
  fresh: boolean;
  /** The graph while its tab isn't showing. */
  nodes: ToolFlowNode[];
  edges: Edge[];
  viewport?: Viewport;
}

/** What a tab shows. */
export interface TabInfo {
  id: string;
  name: string;
  path?: string;
  /** It has a file, and changes that aren't in it. */
  unsaved: boolean;
}

export interface NewDoc {
  name: string;
  path?: string;
  graph: Graph;
  /** Nodes to select, so the settings panel shows what to fill in. */
  select?: string[];
  fresh?: boolean;
  /** The tab it takes the place of, instead of opening a new one. */
  replace?: string;
}

function makeDoc(id: string, name: string, g: Graph, extra: Partial<Doc> = {}): Doc {
  const f = toFlow(g);
  return { id, name, saved: fingerprint(g), fresh: false, nodes: f.nodes, edges: f.edges, ...extra };
}

/** The tabs from last time (see loadDocs). */
function initialDocs(): { docs: Doc[]; active: string } {
  const s = loadDocs({ getItem: (k) => localStorage.getItem(k) }, () => newId("d"), () => serializeGraph(starterGraph(), 0));
  const docs = s.docs.map((d) => {
    let g: Graph;
    try {
      g = parseGraph(d.graph);
    } catch {
      g = starterGraph(); // a broken save
    }
    return makeDoc(d.id, d.name, g, { path: d.path, fresh: !!d.fresh, ...(d.saved ? { saved: d.saved } : {}) });
  });
  return { docs, active: s.active };
}

export function useDocuments(flow: ReactFlowInstance<ToolFlowNode, Edge>, flash: Flash) {
  const init = useMemo(initialDocs, []);
  const first = init.docs.find((d) => d.id === init.active)!;
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolFlowNode>(first.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(first.edges);
  const [docs, setDocs] = useState<Doc[]>(init.docs);
  const [activeId, setActiveId] = useState(init.active);

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const activeFp = useMemo(() => fingerprint(graph), [graph]);
  // The latest of everything, for callbacks that run later (a file read, a dialog).
  // Changes made here update it straight away too, as they may be read again before React renders.
  const live = useRef({ nodes, edges, docs, activeId });
  live.current = { nodes, edges, docs, activeId };

  const docOf = useCallback((id: string) => live.current.docs.find((d) => d.id === id), []);
  /** A tab's graph: the one on screen as it is now, the others as they were left. */
  const graphOf = useCallback((id: string): Graph => {
    const l = live.current;
    if (id === l.activeId) return toGraph(l.nodes, l.edges);
    const d = l.docs.find((x) => x.id === id);
    return d ? toGraph(d.nodes, d.edges) : { version: 1, nodes: [], edges: [] };
  }, []);
  const nodesOf = useCallback((id: string) => (id === live.current.activeId ? live.current.nodes : (docOf(id)?.nodes ?? [])), [docOf]);
  const findByPath = useCallback((path: string) => live.current.docs.find((d) => d.path === path), []);

  /** Puts a tab's graph on screen. The caller has already put away the one that was showing. */
  const show = useCallback(
    (to: Doc) => {
      Object.assign(live.current, { activeId: to.id, nodes: to.nodes, edges: to.edges });
      setNodes(to.nodes);
      setEdges(to.edges);
      setActiveId(to.id);
      if (to.viewport) flow.setViewport(to.viewport);
      else setTimeout(() => flow.fitView({ padding: 0.2, maxZoom: 1 }), 50);
    },
    [flow, setEdges, setNodes],
  );

  /** The tab on screen as it is now, to keep while another one shows. */
  const putAway = useCallback(
    (list: Doc[]) => {
      const { activeId: from, nodes: ns, edges: es } = live.current;
      const viewport = flow.getViewport();
      return list.map((d) => (d.id === from ? { ...d, nodes: ns, edges: es, viewport } : d));
    },
    [flow],
  );

  const switchTo = useCallback(
    (id: string) => {
      if (id === live.current.activeId) return;
      const to = live.current.docs.find((d) => d.id === id);
      if (!to) return;
      const next = putAway(live.current.docs);
      live.current.docs = next;
      setDocs(next);
      show(to);
    },
    [putAway, show],
  );

  /** Opens a graph in a new tab after the one showing (or in place of `replace`); returns its id. */
  const openDoc = useCallback(
    ({ name, path, graph: g, select = [], fresh = false, replace }: NewDoc) => {
      const id = newId("d");
      const list = putAway(live.current.docs);
      const others = list.filter((d) => d.id !== replace).map((d) => d.name);
      const doc = makeDoc(id, path ? name : uniqueName(name, others), g, { path, fresh });
      if (select.length) doc.nodes = doc.nodes.map((n) => (select.includes(n.id) ? { ...n, selected: true } : n));
      const at = list.findIndex((d) => d.id === (replace ?? live.current.activeId));
      const next = replace && at >= 0 ? list.map((d) => (d.id === replace ? doc : d)) : [...list.slice(0, at + 1), doc, ...list.slice(at + 1)];
      live.current.docs = next;
      setDocs(next);
      show(doc);
      return id;
    },
    [putAway, show],
  );

  const newDoc = useCallback(() => openDoc({ name: UNTITLED, graph: starterGraph(), fresh: true }), [openDoc]);

  /** Closes a tab without asking; the last one leaves a new starter graph behind. */
  const closeDoc = useCallback(
    (id: string) => {
      const { docs: list, activeId: active } = live.current;
      if (!list.some((d) => d.id === id)) return;
      if (list.length === 1) {
        openDoc({ name: UNTITLED, graph: starterGraph(), fresh: true, replace: id });
        return;
      }
      const nextId = afterClose(list.map((d) => d.id), id, active);
      const next = list.filter((d) => d.id !== id);
      live.current.docs = next;
      setDocs(next);
      if (id === active) show(next.find((d) => d.id === nextId)!);
    },
    [openDoc, show],
  );

  /**
   * Changes a tab's nodes, whether it's on screen or not: a file read back or a Save node's files
   * arriving after you've moved to another tab still go to the right graph. `quietly` wraps a change
   * to the graph on screen (so it isn't an undo step).
   */
  const patchDoc = useCallback(
    (id: string, change: (ns: ToolFlowNode[]) => ToolFlowNode[], quietly: (run: () => void) => void = (run) => run()) => {
      if (id === live.current.activeId) return quietly(() => setNodes(change));
      const next = live.current.docs.map((d) => (d.id === id ? { ...d, nodes: change(d.nodes) } : d));
      live.current.docs = next;
      setDocs(next);
    },
    [setNodes],
  );

  /** The tab's graph is now in the file at `path`, as it was when it had fingerprint `fp`. */
  const markSaved = useCallback((id: string, path: string, fp: string) => {
    const next = live.current.docs.map((d) => (d.id === id ? { ...d, path, name: nameFromPath(path), saved: fp, fresh: false } : d));
    live.current.docs = next;
    setDocs(next);
  }, []);

  /** A starter graph nobody has changed, which an opened file or a workflow may replace. */
  const isUntouched = useCallback(() => {
    const d = docOf(live.current.activeId);
    return !!d && d.fresh && !d.path && fingerprint(graphOf(d.id)) === d.saved && !hasContent(live.current.nodes);
  }, [docOf, graphOf]);

  // The other tabs only change when they're put away or patched, so their fingerprints are worked out then.
  const fingerprints = useMemo(() => new Map(docs.map((d) => [d.id, fingerprint(toGraph(d.nodes, d.edges))])), [docs]);
  const changedOf = useCallback((d: Doc) => (d.id === activeId ? activeFp : fingerprints.get(d.id)) !== d.saved, [activeFp, activeId, fingerprints]);
  const tabs = useMemo<TabInfo[]>(() => docs.map((d) => ({ id: d.id, name: d.name, path: d.path, unsaved: !!d.path && changedOf(d) })), [changedOf, docs]);
  const active = docs.find((d) => d.id === activeId)!;
  const openIds = useMemo(() => docs.map((d) => d.id), [docs]);

  // Autosave, every tab at once. Storage holds a few MB, so a very large pasted or dropped text can fill it: say so once.
  const autosaveFailed = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      const kept: SavedDocs = {
        active: activeId,
        docs: docs.map((d) => {
          const g = d.id === activeId ? graph : toGraph(d.nodes, d.edges);
          const unchanged = (d.id === activeId ? activeFp : fingerprints.get(d.id)) === d.saved;
          return { id: d.id, name: d.name, ...(d.path ? { path: d.path } : {}), graph: serializeGraph(g, 0), saved: d.saved, ...(d.fresh && unchanged ? { fresh: true } : {}) };
        }),
      };
      try {
        localStorage.setItem(DOCS_STORE, JSON.stringify(kept));
        autosaveFailed.current = false;
      } catch {
        if (!autosaveFailed.current) flash("These graphs are too large to autosave. Use Save graph to keep them.");
        autosaveFailed.current = true;
      }
    }, 400);
    return () => clearTimeout(t);
  }, [activeFp, activeId, docs, fingerprints, flash, graph]);

  useEffect(() => {
    document.title = `${active.name} – Toolbox`;
  }, [active.name]);

  /** Every open graph as serializeGraph writes it, for adopting the files they name at launch. */
  const allTexts = useCallback(() => live.current.docs.map((d) => serializeGraph(graphOf(d.id), 0)), [graphOf]);

  return {
    nodes,
    edges,
    setNodes,
    setEdges,
    onNodesChange,
    onEdgesChange,
    activeId,
    active,
    tabs,
    openIds,
    activeFp,
    docOf,
    graphOf,
    nodesOf,
    findByPath,
    switchTo,
    openDoc,
    newDoc,
    closeDoc,
    patchDoc,
    markSaved,
    isUntouched,
    allTexts,
  };
}

export type Documents = ReturnType<typeof useDocuments>;
