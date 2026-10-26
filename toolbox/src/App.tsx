import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
} from "@xyflow/react";
import { CONVERTERS, inputNodeFor, NODE_DEFS, REGISTRY } from "./nodes";
import { canConnect, outputShapes } from "./runtime/evaluate";
import { newId, newNode, parseGraph, placeWorkflow, serializeGraph, starterGraph, WORKFLOWS } from "./graphs";
import { bridge, isDesktop, openGraphFile, reopenFile, saveFile, saveGraphFile } from "./platform";
import { RuntimeClient } from "./runtime/client";
import type { Graph, NodeDef, Params } from "./runtime/types";
import type { NodeUpdate, ProgressUpdate } from "./runtime/worker";
import { ActionsContext, PreviewContext, RuntimeContext, ShapesContext, type NodeRuntime, type ToolFlowNode } from "./ui/context";
import { Inspector } from "./ui/Inspector";
import { NodeMenu } from "./ui/NodeMenu";
import { Tutorial, tutorialSeen } from "./ui/Tutorial";
import { Bitmap, ToolNode } from "./ui/ToolNode";
import { Webcams, type CamSpec } from "./ui/webcam";
import logoUrl from "../build/icon.svg?url";

const STORE = "toolbox.graph";
const VIEW_STORE = "toolbox.view";
const OUTPUTS_STORE = "toolbox.outputs";
const UPDATE_STORE = "toolbox.update-check";
const nodeTypes = { tool: ToolNode };
/** Roughly half a node card, so a new node lands centred under the pointer. */
const NODE_HALF_WIDTH = 110;
/** Undo steps kept. */
const HISTORY = 100;
/** Changes closer together than this (a slider drag, a node drag) undo as one step. */
const HISTORY_SETTLE = 400;

/** The Add node menu: where it is, and the wire it was opened from, if any. */
interface MenuState {
  /** Pointer position in the canvas, in pixels. */
  x: number;
  y: number;
  /** Where the new node goes, in graph coordinates. */
  at: { x: number; y: number };
  from?: { node: string; handle: string };
  /** Opens on the Workflows tab. */
  workflows?: boolean;
}

interface OutputEntry {
  id: string;
  name: string;
  bytes: number;
  savedTo: string;
}

interface View {
  /** The node whose output fills the canvas background. */
  preview?: string;
  inspectorWidth: number;
  inspectorHidden: boolean;
}

function toFlow(g: Graph): { nodes: ToolFlowNode[]; edges: Edge[] } {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: "tool", position: n.position, data: { type: n.type, params: n.params } })),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

function toGraph(nodes: ToolFlowNode[], edges: Edge[]): Graph {
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

function loadInitial(): Graph {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) return parseGraph(saved);
  } catch {
    /* storage unavailable or a broken save */
  }
  return starterGraph();
}

function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable */
  }
}

/** The node and everything that feeds it, so one Save node can render on its own. */
function upstreamOf(g: Graph, id: string): Graph {
  const keep = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const t = stack.pop()!;
    for (const e of g.edges) if (e.target === t && !keep.has(e.source)) keep.add(e.source), stack.push(e.source);
  }
  return { ...g, nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

/** Whether a graph holds anything the user put in: files, links or their own text. */
function hasContent(nodes: ToolFlowNode[]): boolean {
  const defaultText = REGISTRY.get("input.text")?.defaults().text;
  return nodes.some(({ data: { type, params: p } }) => {
    if (p.assetId || (p.assetIds as unknown[] | undefined)?.length || p.path || (p.paths as unknown[] | undefined)?.length) return true;
    if (type === "input.download") return !!String(p.url ?? "").trim();
    if (type === "input.text") return !!String(p.text ?? "").trim() && p.text !== defaultText;
    return false;
  });
}

/** Whether keys typed now belong to a text field rather than the graph. */
const typingIn = (el: Element | null) => !!el?.closest("input, textarea, select, [contenteditable]");

const inputPort = (nodeType: string, key: string | null) => REGISTRY.get(nodeType)?.inputs.find((p) => p.key === key);

export function App() {
  const initial = useMemo(() => toFlow(loadInitial()), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});
  const [rendering, setRendering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [outputs, setOutputs] = useState<OutputEntry[]>(() => readStore<{ list: OutputEntry[] }>(OUTPUTS_STORE, { list: [] }).list);
  const [message, setMessage] = useState("");
  const [dropping, setDropping] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tutorial, setTutorial] = useState(() => !tutorialSeen());
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [view, setView] = useState<View>(() => readStore<View>(VIEW_STORE, { inspectorWidth: 320, inspectorHidden: false }));
  useEffect(() => writeStore(VIEW_STORE, view), [view]);
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => writeStore(OUTPUTS_STORE, { list: outputs }), [outputs]);
  const flow = useReactFlow<ToolFlowNode, Edge>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);

  const onUpdate = useCallback((u: NodeUpdate) => {
    setRuntime((prev) => {
      const old = prev[u.id];
      if (u.thumb) {
        if (!old || !u.bitmap) return prev;
        old.bitmap?.close();
        return { ...prev, [u.id]: { ...old, bitmap: u.bitmap, size: u.size } };
      }
      const hasOutput = u.status === "ok" || u.status === "cached";
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
  const flashRef = useRef<(text: string) => void>(() => {});
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

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), 5000);
  }, []);
  flashRef.current = flash;

  // Autosave. Storage holds a few MB, so a very large pasted or dropped text can fill it: say so once.
  const autosaveFailed = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE, serializeGraph(graph));
        autosaveFailed.current = false;
      } catch {
        if (!autosaveFailed.current) flash("This graph is too large to autosave. Use Save to keep it.");
        autosaveFailed.current = true;
      }
    }, 400);
    return () => clearTimeout(t);
  }, [flash, graph]);

  // ---------------------------------------------------------------- undo
  // Snapshots of the whole graph (settings, wires, positions). A change becomes a step once
  // things settle, so a slider drag is one step, not fifty.
  const graphKey = useMemo(() => JSON.stringify(graph), [graph]);
  const graphKeyRef = useRef(graphKey);
  graphKeyRef.current = graphKey;
  const history = useRef({ past: [] as string[], future: [] as string[], at: graphKey, quiet: false });
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
  }, []);
  useEffect(() => {
    if (graphKey === history.current.at) return;
    const t = setTimeout(commitHistory, HISTORY_SETTLE);
    return () => clearTimeout(t);
  }, [commitHistory, graphKey]);

  const applySnapshot = useCallback(
    (key: string) => {
      const f = toFlow(JSON.parse(key) as Graph);
      setNodes(f.nodes);
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
  }, [applySnapshot, commitHistory, flash]);
  const redo = useCallback(() => {
    commitHistory();
    const h = history.current;
    const next = h.future.pop();
    if (next === undefined) return flash("Nothing to redo");
    h.past.push(h.at);
    h.at = next;
    applySnapshot(next);
  }, [applySnapshot, commitHistory, flash]);

  // ---------------------------------------------------------------- files

  const setParams = useCallback(
    (id: string, patch: Params) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n))),
    [setNodes],
  );

  const setNodeFile = useCallback(
    (nodeId: string, file: File) => {
      const assetId = newId("a");
      // The desktop app knows where the file is, so it comes back after a restart.
      const path = bridge?.pathForFile(file) ?? "";
      client.addAsset(assetId, file, path);
      setParams(nodeId, { assetId, name: file.name, path });
    },
    [client, setParams],
  );

  const setNodeFiles = useCallback(
    (nodeId: string, files: File[]) => {
      const assetIds = files.map((f) => {
        const id = newId("a");
        client.addAsset(id, f, bridge?.pathForFile(f));
        return id;
      });
      const paths = files.map((f) => bridge?.pathForFile(f) ?? "");
      setParams(nodeId, { assetIds, paths, names: files.map((f) => f.name), name: files.length === 1 ? files[0].name : `${files.length} images` });
    },
    [client, setParams],
  );

  /** Reads the files a saved graph used from where they were on disk (desktop app). */
  const restoreFiles = useCallback(
    async (g: Graph) => {
      if (!bridge) return 0;
      let missing = 0;
      const patches = await Promise.all(
        g.nodes.map(async (n): Promise<[string, Params] | undefined> => {
          const p = n.params;
          if (typeof p.path === "string" && p.path && !p.assetId) {
            const f = await reopenFile(p.path, String(p.name ?? ""));
            if (!f) return void missing++;
            const assetId = newId("a");
            client.addAsset(assetId, f, p.path);
            return [n.id, { assetId }];
          }
          const paths = Array.isArray(p.paths) ? (p.paths as string[]) : [];
          if (paths.length && !(p.assetIds as unknown[] | undefined)?.length) {
            const names = Array.isArray(p.names) ? (p.names as string[]) : [];
            const files = await Promise.all(paths.map((path, i) => reopenFile(path, names[i] ?? "")));
            if (files.some((f) => !f)) return void missing++;
            const assetIds = files.map((f, i) => {
              const id = newId("a");
              client.addAsset(id, f!, paths[i]);
              return id;
            });
            return [n.id, { assetIds }];
          }
          return undefined;
        }),
      );
      const found = new Map(patches.filter((x): x is [string, Params] => !!x));
      if (!found.size) return missing;
      // Files coming back isn't something to undo.
      history.current.quiet = true;
      setNodes((ns) => ns.map((n) => (found.has(n.id) ? { ...n, data: { ...n.data, params: { ...n.data.params, ...found.get(n.id) } } } : n)));
      setTimeout(() => {
        commitHistory();
        history.current.quiet = false;
      }, HISTORY_SETTLE + 100);
      return missing;
    },
    [client, commitHistory, setNodes],
  );

  // The last session's files, and (once a day) whether there's a newer Toolbox.
  useEffect(() => {
    void restoreFiles(graphRef.current);
    if (!bridge) return;
    const last = readStore<{ at: number }>(UPDATE_STORE, { at: 0 }).at;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    void bridge.checkUpdate().then((u) => {
      writeStore(UPDATE_STORE, { at: Date.now() });
      setUpdate(u);
    });
  }, [restoreFiles]);

  // ---------------------------------------------------------------- editing

  // The background shows one chosen node (its eye button, or ⌥-click), not whatever is selected.
  const togglePreview = useCallback((id: string) => setView((v) => ({ ...v, preview: v.preview === id ? undefined : id })), []);

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      let pos = position;
      if (!pos) {
        const r = canvasRef.current!.getBoundingClientRect();
        pos = flow.screenToFlowPosition({ x: r.left + r.width / 2 - 110, y: r.top + r.height / 2 - 60 });
      }
      const n = newNode(type, pos);
      setNodes((ns) => [
        ...ns.map((x) => ({ ...x, selected: false })),
        { id: n.id, type: "tool", position: n.position, data: { type: n.type, params: n.params }, selected: true },
      ]);
      return n.id;
    },
    [flow, setNodes],
  );

  /** Adds a graph's nodes and wires next to what's there, selected, with fresh ids. */
  const insertGraph = useCallback(
    (g: Graph, offset: { x: number; y: number }) => {
      const ids = new Map(g.nodes.map((n) => [n.id, newId("n")]));
      const added: ToolFlowNode[] = g.nodes.map((n) => ({
        id: ids.get(n.id)!,
        type: "tool",
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
        data: { type: n.type, params: structuredClone(n.params) },
        selected: true,
      }));
      setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), ...added]);
      setEdges((es) => [
        ...es.map((e) => ({ ...e, selected: false })),
        ...g.edges.map((e) => ({ ...e, id: newId("e"), source: ids.get(e.source)!, target: ids.get(e.target)! })),
      ]);
    },
    [setEdges, setNodes],
  );

  const clipboard = useRef<{ graph: Graph; pastes: number } | null>(null);
  const copy = useCallback(() => {
    const picked = flow.getNodes().filter((n) => n.selected);
    if (!picked.length) return false;
    const ids = new Set(picked.map((n) => n.id));
    const g = toGraph(picked, flow.getEdges().filter((e) => ids.has(e.source) && ids.has(e.target)));
    clipboard.current = { graph: g, pastes: 0 };
    return true;
  }, [flow]);
  const deleteSelected = useCallback(() => {
    const ids = new Set(flow.getNodes().filter((n) => n.selected).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
  }, [flow, setEdges, setNodes]);
  /** Pastes under the pointer when it's on the canvas, otherwise a step down and right of the copies. */
  const paste = useCallback(
    (nearCopies = false) => {
      const clip = clipboard.current;
      if (!clip?.graph.nodes.length) return;
      clip.pastes++;
      const left = Math.min(...clip.graph.nodes.map((n) => n.position.x));
      const top = Math.min(...clip.graph.nodes.map((n) => n.position.y));
      const r = canvasRef.current!.getBoundingClientRect();
      const p = pointer.current;
      const onCanvas = !nearCopies && p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      const at = onCanvas ? flow.screenToFlowPosition(p) : { x: left + 40 * clip.pastes, y: top + 40 * clip.pastes };
      insertGraph(clip.graph, { x: at.x - left, y: at.y - top });
    },
    [flow, insertGraph],
  );
  const duplicate = useCallback(() => {
    if (copy()) paste(true);
  }, [copy, paste]);

  /** Opens the Add node menu at a point on screen, or the canvas centre. */
  const openMenu = useCallback(
    (client?: { x: number; y: number }, from?: MenuState["from"], workflows?: boolean) => {
      const r = canvasRef.current!.getBoundingClientRect();
      const inside = client && client.x >= r.left && client.x <= r.right && client.y >= r.top && client.y <= r.bottom;
      const c = inside ? client : { x: r.left + r.width / 2, y: r.top + r.height / 3 };
      const at = flow.screenToFlowPosition(c);
      setMenu({ x: c.x - r.left, y: c.y - r.top, at: { x: at.x - NODE_HALF_WIDTH, y: at.y - 20 }, from, workflows });
    },
    [flow],
  );

  /** The first input of `def` that the menu's wire can feed. */
  const portFor = useCallback(
    (def: NodeDef, from: MenuState["from"]) => {
      const shape = from && shapes.get(`${from.node}:${from.handle}`);
      return shape ? def.inputs.find((p) => canConnect(shape, def, p, CONVERTERS).ok) : undefined;
    },
    [shapes],
  );

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          { ...c, id: newId("e") },
          // One wire per input: a new wire replaces the old one.
          es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)),
        ),
      ),
    [setEdges],
  );

  // ---------------------------------------------------------------- render

  /** What each Save node last wrote, so an unchanged file isn't saved again. */
  const savedKeys = useRef(new Map<string, string>());

  /**
   * Renders the graph, or just what feeds one Save node (`only`), and writes the files.
   * A Save node whose file hasn't changed since it last saved is skipped, unless it's `only`.
   */
  const render = useCallback(
    async (only?: string) => {
      if (rendering) return;
      let full = graphRef.current;
      // Nothing to save to: save the selected node's output, if a Save node can take it.
      if (!only && !full.nodes.some((n) => REGISTRY.get(n.type)?.saves)) {
        const sel = flow.getNodes().find((n) => n.selected);
        const def = sel && REGISTRY.get(sel.data.type);
        const save = REGISTRY.get("output.save-file")!;
        const out = def?.outputs.find((o) => {
          const s = shapes.get(`${sel!.id}:${o.key}`);
          return s && canConnect(s, save, save.inputs[0], CONVERTERS).ok;
        });
        if (!sel || !out) return flash("Add a Save node (or select the node whose result you want) to write files.");
        const n = newNode(save.type, { x: sel.position.x + 300, y: sel.position.y });
        const edge = { id: newId("e"), source: sel.id, sourceHandle: out.key, target: n.id, targetHandle: save.inputs[0].key };
        setNodes((ns) => [...ns, { id: n.id, type: "tool", position: n.position, data: { type: n.type, params: n.params } }]);
        setEdges((es) => [...es, edge]);
        full = { ...full, nodes: [...full.nodes, n], edges: [...full.edges, edge] };
        flash(`Added a Save node after ${def!.title}.`);
      }
      const g = only ? upstreamOf(full, only) : full;
      setRendering(true);
      // A webcam records from now until Stop.
      const live = g.nodes.some((n) => n.type === "input.webcam") && g.edges.some((e) => g.nodes.find((n) => n.id === e.source)?.type === "input.webcam");
      if (live) {
        webcams.startRecording();
        flash("Recording. Press Stop to finish.");
      }
      setRecording(live);
      const result = await client.render(g);
      webcams.stopRecording();
      setRecording(false);
      setRendering(false);
      if (result.error) flash(result.error);
      let unchanged = 0;
      let saved = 0;
      for (const f of result.files) {
        if (f.nodeId !== only && f.key && savedKeys.current.get(f.nodeId) === f.key) {
          unchanged++;
          continue;
        }
        const node = g.nodes.find((n) => n.id === f.nodeId);
        const where = await saveFile(f.name, f.mime, f.bytes, node?.params.folder ? String(node.params.folder) : undefined);
        if (!where) continue;
        saved++;
        if (f.key) savedKeys.current.set(f.nodeId, f.key);
        setOutputs((o) => [{ id: newId("o"), name: where.split(/[\\/]/).pop() ?? f.name, bytes: f.bytes.byteLength, savedTo: where }, ...o].slice(0, 30));
        setRuntime((prev) => ({ ...prev, [f.nodeId]: { ...prev[f.nodeId], savedTo: where } }));
      }
      if (result.error) return;
      if (unchanged && !saved) flash("Nothing changed since the last save. Press Save on a Save node to write it again.");
      else if (unchanged) flash(`Saved ${saved} file${saved === 1 ? "" : "s"}; ${unchanged} unchanged since the last save.`);
    },
    [client, flash, flow, rendering, setEdges, setNodes, shapes, webcams],
  );
  const saveNode = useCallback((id: string) => void render(id), [render]);

  const loadGraph = useCallback(
    (g: Graph) => {
      const f = toFlow(g);
      setNodes(f.nodes);
      setEdges(f.edges);
      setRuntime({});
      setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
    },
    [flow, setEdges, setNodes],
  );

  const openGraph = useCallback(async () => {
    const f = await openGraphFile();
    if (!f) return;
    try {
      const g = parseGraph(f.text);
      loadGraph(g);
      const missing = await restoreFiles(g);
      const needsFiles = g.nodes.some((n) => REGISTRY.get(n.type)?.category === "input" && "assetId" in n.params && !n.params.path);
      flash(missing ? `Opened ${f.name}. ${missing} file${missing === 1 ? " has" : "s have"} moved: drop ${missing === 1 ? "it" : "them"} in again.` : needsFiles ? `Opened ${f.name}. Drop the input files in again.` : `Opened ${f.name}`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }, [flash, loadGraph, restoreFiles]);

  const saveGraph = useCallback(async () => {
    const where = await saveGraphFile(serializeGraph(graphRef.current), "graph.toolbox");
    if (where) flash(`Saved ${where.split(/[\\/]/).pop()}`);
  }, [flash]);

  // ---------------------------------------------------------------- commands

  const commands = useRef<Record<string, () => void>>({});
  commands.current = {
    render: () => void render(),
    open: () => void openGraph(),
    save: () => void saveGraph(),
    new: () => {
      loadGraph(starterGraph());
      flash("New graph. ⌘Z brings the old one back.");
    },
    addNode: () => openMenu(pointer.current),
    workflows: () => openMenu(undefined, undefined, true),
    tutorial: () => setTutorial(true),
    undo,
    redo,
    copy: () => void copy(),
    cut: () => {
      if (copy()) deleteSelected();
    },
    paste: () => paste(),
    duplicate,
    selectAll: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
  };
  useEffect(() => {
    const TEXT = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    // The desktop Edit menu sends its commands here; in a text field they edit the text instead.
    bridge?.onMenu((c) => {
      if (TEXT.has(c) && typingIn(document.activeElement)) void bridge!.editText(c);
      else if (c === "duplicate" && typingIn(document.activeElement)) return;
      else commands.current[c]?.();
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // Tab opens the Add node menu at the pointer, unless you're typing or moving between inspector fields.
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (t.closest("input, textarea, select, [contenteditable], .inspector, .node-menu, .tutorial")) return;
        e.preventDefault();
        commands.current.addNode();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || isDesktop) return; // the desktop menu owns these
      const k = e.key.toLowerCase();
      const c =
        k === "z" ? (e.shiftKey ? "redo" : "undo")
        : ({ y: "redo", r: "render", o: "open", s: "save", c: "copy", x: "cut", v: "paste", d: "duplicate", a: "selectAll" } as Record<string, string>)[k];
      if (!c || (typingIn(t) && !["render", "open", "save"].includes(c))) return;
      e.preventDefault();
      commands.current[c]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isValidConnection = useCallback(
    (c: Edge | Connection) => {
      const s = flow.getNode(c.source);
      const t = flow.getNode(c.target);
      if (!s || !t || s.id === t.id) return false;
      const from = shapes.get(`${s.id}:${c.sourceHandle}`);
      const def = REGISTRY.get(t.data.type);
      const port = inputPort(t.data.type, c.targetHandle ?? null);
      if (!from || !def || !port || !canConnect(from, def, port, CONVERTERS).ok) return false;
      // Refuse wires that would make a loop: the target must not already feed the source.
      const seen = new Set<string>();
      const stack = [t.id];
      const es = flow.getEdges();
      while (stack.length) {
        const id = stack.pop()!;
        if (id === s.id) return false;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const e of es) if (e.source === id) stack.push(e.target);
      }
      return true;
    },
    [flow, shapes],
  );

  // A wire dropped on empty canvas opens the menu with the nodes that can take it.
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent, c: FinalConnectionState) => {
      if (c.isValid || c.toNode || !c.fromNode || c.fromHandle?.type !== "source" || !c.fromHandle.id) return;
      const p = "changedTouches" in e ? e.changedTouches[0] : e;
      openMenu({ x: p.clientX, y: p.clientY }, { node: c.fromNode.id, handle: c.fromHandle.id });
    },
    [openMenu],
  );

  const menuDefs = useMemo(() => NODE_DEFS.filter((d) => !d.hidden && (!menu?.from || portFor(d, menu.from))), [menu, portFor]);

  const pickFromMenu = useCallback(
    (type: string) => {
      if (!menu) return;
      setMenu(null);
      const id = addNode(type, menu.at);
      const port = menu.from && portFor(REGISTRY.get(type)!, menu.from);
      if (menu.from && port) onConnect({ source: menu.from.node, sourceHandle: menu.from.handle, target: id, targetHandle: port.key });
    },
    [addNode, menu, onConnect, portFor],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // A workflow takes over a graph that holds nothing of yours yet; otherwise it drops in under what's there.
  // Its first node is selected so the inspector shows what to fill in.
  const pickWorkflow = useCallback(
    (id: string) => {
      const w = WORKFLOWS.find((x) => x.id === id);
      if (!menu || !w) return;
      setMenu(null);
      const current = flow.getNodes();
      const replace = !hasContent(current);
      const box = (n: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }) => ({
        l: n.position.x,
        t: n.position.y,
        r: n.position.x + (n.measured?.width ?? 2 * NODE_HALF_WIDTH),
        b: n.position.y + (n.measured?.height ?? 160),
      });
      const existing = replace ? [] : current.map(box);
      let placed = placeWorkflow(w, menu.at);
      const covers = placed.nodes.map(box).some((a) => existing.some((e) => a.l < e.r && e.l < a.r && a.t < e.b && e.t < a.b));
      if (covers) {
        placed = placeWorkflow(w, { x: Math.min(...existing.map((e) => e.l)), y: Math.max(...existing.map((e) => e.b)) + 80 });
      }
      const f = toFlow(placed);
      f.nodes[0].selected = true;
      if (replace) {
        setNodes(f.nodes);
        setEdges(f.edges);
      } else {
        setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), ...f.nodes]);
        setEdges((es) => [...es, ...f.edges]);
      }
      const first = REGISTRY.get(f.nodes[0].data.type)!;
      const todo = first.type === "input.download" ? "paste a link in the inspector" : first.type === "input.text" ? "type or paste your text" : "drop in your file";
      flash(`${w.title}: ${todo}, then Render.${replace && current.length ? " ⌘Z brings back the old graph." : ""}`);
      setTimeout(() => flow.fitView({ nodes: f.nodes.map((n) => ({ id: n.id })), padding: 0.25, maxZoom: 1, duration: 300 }), 50);
    },
    [flash, flow, menu, setEdges, setNodes],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const all = [...e.dataTransfer.files];
      const unknown = all.filter((f) => !inputNodeFor(f));
      if (unknown.length) flash(`Toolbox can't open ${unknown.map((f) => f.name).join(", ")}`);
      // A file dropped onto an input node goes into that node.
      const onto = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
      const ontoNode = onto ? flow.getNode(onto) : undefined;
      // An empty Images node (or the one dropped onto) takes all the dropped images at once.
      const images = all.filter((f) => inputNodeFor(f) === "input.file");
      const imagesNode =
        ontoNode?.data.type === "input.images" ? ontoNode : flow.getNodes().find((n) => n.data.type === "input.images" && !(n.data.params.assetIds as unknown[] | undefined)?.length);
      if (imagesNode && images.length) setNodeFiles(imagesNode.id, images);
      // Fill empty inputs of the right kind first, then add new ones.
      const empty = flow.getNodes().filter((n) => n.data.type !== "input.text" && n.data.type.startsWith("input.") && !n.data.params.assetId);
      if (ontoNode && ontoNode.data.type !== "input.images") empty.unshift(ontoNode);
      let row = 0;
      for (const f of imagesNode && images.length ? all.filter((f) => !images.includes(f)) : all) {
        const type = inputNodeFor(f);
        if (!type) continue;
        const at = { x: pos.x, y: pos.y + row++ * 40 };
        if (type === "input.text") {
          const id = addNode(type, at);
          void f.text().then((text) => setParams(id, { text }));
          continue;
        }
        const i = empty.findIndex((n) => n.data.type === type);
        const target = i >= 0 ? empty.splice(i, 1)[0].id : addNode(type, at);
        setNodeFile(target, f);
      }
    },
    [addNode, flash, flow, setNodeFile, setNodeFiles, setParams],
  );

  // ---------------------------------------------------------------- layout

  const selected = nodes.find((n) => n.selected);
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

  const actions = useMemo(() => ({ setNodeFile, setNodeFiles, togglePreview, saveNode }), [saveNode, setNodeFile, setNodeFiles, togglePreview]);
  const inspectorWidth = view.inspectorHidden ? 0 : view.inspectorWidth;

  return (
    <ShapesContext.Provider value={shapes}>
    <RuntimeContext.Provider value={runtime}>
      <PreviewContext.Provider value={shownId}>
      <ActionsContext.Provider value={actions}>
        <div className="app">
          <header className="topbar">
            <div className="brand">
              <img className="logo" src={logoUrl} alt="" /> TOOLBOX
            </div>
            <div className="group">
              <button onClick={() => commands.current.new()}>New</button>
              <button className="add-node" onClick={() => commands.current.addNode()} title="Add a node (Tab, or right-click the canvas)">
                Add node <kbd>Tab</kbd>
              </button>
              <button className="workflows" onClick={() => commands.current.workflows()} title="Drop in a ready-made chain, like downloading a video">
                Workflows
              </button>
              <button onClick={openGraph}>Open</button>
              <button onClick={saveGraph}>Save</button>
            </div>
            <div className="message">{message}</div>
            <div className="group right">
              {update && (
                <a className="update" href={update.url} target="_blank" rel="noreferrer" title="Opens the download page">
                  Toolbox {update.version} is out
                </a>
              )}
              <button className="help" onClick={() => setTutorial(true)} title="Show the tutorial again">
                ?
              </button>
              {rendering && <button onClick={() => client.cancelRender()}>Cancel</button>}
              {recording ? (
                <button
                  className="primary rec"
                  onClick={() => {
                    client.stopRecording();
                    webcams.stopRecording();
                  }}
                  title="Stop recording and write the files"
                >
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={() => void render()} disabled={rendering} title="Render and save what changed (⌘R)">
                  {rendering ? "Rendering…" : "Render"}
                </button>
              )}
            </div>
          </header>

          <div className="main" style={{ gridTemplateColumns: `minmax(0, 1fr) ${inspectorWidth}px` }}>
            <section className="center">
              <div
                className="canvas"
                ref={canvasRef}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.types.includes("Files")) setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={onDrop}
                onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
              >
                {shown && (shown.bitmap || shown.text !== undefined) && (
                  <div className="backdrop">
                    {shown.bitmap ? <Bitmap bitmap={shown.bitmap} className="backdrop-img" /> : <pre className="backdrop-text">{shown.text}</pre>}
                    <span className="backdrop-label">
                      {shownTitle}
                      {shown.size ? ` · ${shown.size.width}×${shown.size.height}` : ""}
                    </span>
                  </div>
                )}
                <ReactFlow
                  nodes={nodes}
                  edges={displayEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onConnectEnd={onConnectEnd}
                  onNodeClick={(e, n) => e.altKey && togglePreview(n.id)}
                  connectionRadius={26}
                  onPaneContextMenu={(e) => {
                    e.preventDefault();
                    openMenu({ x: e.clientX, y: e.clientY });
                  }}
                  isValidConnection={isValidConnection}
                  colorMode="dark"
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  deleteKeyCode={["Backspace", "Delete"]}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
                {shown && scrubbed && (
                  <label className="scrub" title="Playhead: the frame every live node previews">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={0.1}
                      value={Number(scrubbed.data.params.at ?? 0)}
                      onChange={(e) => setParams(scrubbed.id, { at: e.target.valueAsNumber })}
                    />
                  </label>
                )}
                {dropping && <div className="drop">Drop files to add them</div>}
                {menu && (
                  <NodeMenu
                    defs={menuDefs}
                    workflows={menu.from ? undefined : WORKFLOWS}
                    x={menu.x}
                    y={menu.y}
                    title={menu.from ? "Add a node to this wire" : menu.workflows ? "Workflows: type to search" : undefined}
                    tab={menu.workflows ? "workflow" : undefined}
                    onPick={pickFromMenu}
                    onPickWorkflow={pickWorkflow}
                    onClose={closeMenu}
                  />
                )}
                {nodes.length === 0 && !menu && (
                  <p className="canvas-hint">Press Tab or right-click to add a node, or pick a ready-made one under Workflows. Drop images, videos, sound, PDFs or text anywhere.</p>
                )}
              </div>
            </section>

            <div className="inspector-wrap">
              <div
                className="inspector-resize"
                onPointerDown={resizeInspector}
                onDoubleClick={() => setView((v) => ({ ...v, inspectorHidden: !v.inspectorHidden }))}
                title="Drag to resize the settings panel; double-click to hide or show it"
              />
              {!view.inspectorHidden && <Inspector node={selected} onParams={setParams} />}
            </div>
          </div>

          <footer className="tray">
            <strong>Outputs</strong>
            {outputs.length === 0 && <span className="muted">Rendered files show up here.</span>}
            {outputs.map((o) => (
              <span key={o.id} className="out-item" title={o.savedTo}>
                {bridge ? (
                  <button className="link" onClick={() => void bridge!.openPath(o.savedTo)} title={`Open ${o.savedTo}`}>
                    {o.name}
                  </button>
                ) : (
                  o.name
                )}
                <span className="muted">{(o.bytes / 1024).toFixed(0)} KB</span>
                {bridge && (
                  <button className="icon" onClick={() => bridge!.reveal(o.savedTo)}>
                    Show
                  </button>
                )}
              </span>
            ))}
            {outputs.length > 0 && (
              <button className="icon clear" onClick={() => setOutputs([])} title="Clear this list (the files stay)">
                Clear
              </button>
            )}
          </footer>
          {tutorial && <Tutorial onClose={() => setTutorial(false)} />}
        </div>
      </ActionsContext.Provider>
      </PreviewContext.Provider>
    </RuntimeContext.Provider>
    </ShapesContext.Provider>
  );
}
