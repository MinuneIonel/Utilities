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
import { bridge, isDesktop, openGraphFile, saveFile, saveGraphFile } from "./platform";
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
const nodeTypes = { tool: ToolNode };
/** Roughly half a node card, so a new node lands centred under the pointer. */
const NODE_HALF_WIDTH = 110;

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

const inputPort = (nodeType: string, key: string | null) => REGISTRY.get(nodeType)?.inputs.find((p) => p.key === key);

export function App() {
  const initial = useMemo(() => toFlow(loadInitial()), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});
  const [rendering, setRendering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [message, setMessage] = useState("");
  const [dropping, setDropping] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tutorial, setTutorial] = useState(() => !tutorialSeen());
  const [view, setView] = useState<{ backdrop: boolean; panel: boolean; preview?: string }>(() => {
    try {
      return { backdrop: true, panel: false, ...JSON.parse(localStorage.getItem(VIEW_STORE) ?? "{}") };
    } catch {
      return { backdrop: true, panel: false };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORE, JSON.stringify(view));
    } catch {
      /* storage may be unavailable */
    }
  }, [view]);
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
        return { id: n.id, width: w || 1280, height: h || 720, mirror: n.params.mirror !== false };
      }),
  );
  useEffect(() => webcams.sync(JSON.parse(camKey)), [camKey, webcams]);
  useEffect(() => () => webcams.closeAll(), [webcams]);

  useEffect(() => {
    client.preview(graphRef.current);
  }, [runKey, client]);

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), 4000);
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

  const setParams = useCallback(
    (id: string, patch: Params) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n))),
    [setNodes],
  );

  const setNodeFile = useCallback(
    (nodeId: string, file: File) => {
      const assetId = newId("a");
      client.addAsset(assetId, file);
      setParams(nodeId, { assetId, name: file.name });
    },
    [client, setParams],
  );

  // The background shows one chosen node (its eye button, or ⌥-click), not whatever is selected.
  const togglePreview = useCallback(
    (id: string) => setView((v) => (v.preview === id ? { ...v, preview: undefined } : { ...v, preview: id, backdrop: true })),
    [],
  );

  const setNodeFiles = useCallback(
    (nodeId: string, files: File[]) => {
      const assetIds = files.map((f) => {
        const id = newId("a");
        client.addAsset(id, f);
        return id;
      });
      setParams(nodeId, { assetIds, names: files.map((f) => f.name), name: files.length === 1 ? files[0].name : `${files.length} images` });
    },
    [client, setParams],
  );

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

  const render = useCallback(async () => {
    if (rendering) return;
    setRendering(true);
    const g = graphRef.current;
    // A webcam records from now until Stop.
    const live = g.nodes.some((n) => n.type === "input.webcam") && g.edges.some((e) => g.nodes.find((n) => n.id === e.source)?.type === "input.webcam");
    webcams.recording = live;
    setRecording(live);
    if (live) flash("Recording. Press Stop to finish.");
    const result = await client.render(g);
    webcams.recording = false;
    setRecording(false);
    setRendering(false);
    if (result.error) flash(result.error);
    for (const f of result.files) {
      const node = g.nodes.find((n) => n.id === f.nodeId);
      const where = await saveFile(f.name, f.mime, f.bytes, node?.params.folder ? String(node.params.folder) : undefined);
      if (!where) continue;
      setOutputs((o) => [{ id: newId("o"), name: f.name, bytes: f.bytes.byteLength, savedTo: where }, ...o].slice(0, 30));
      setRuntime((prev) => ({ ...prev, [f.nodeId]: { ...prev[f.nodeId], savedTo: where } }));
    }
    if (!result.error && !result.files.length) flash("Rendered. Add a Save node to write files.");
  }, [client, flash, rendering, webcams]);

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
      loadGraph(parseGraph(f.text));
      flash(`Opened ${f.name}. Drop the input files again.`);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }, [flash, loadGraph]);

  const saveGraph = useCallback(async () => {
    const where = await saveGraphFile(serializeGraph(graphRef.current), "graph.toolbox");
    if (where) flash(`Saved ${where.split(/[\\/]/).pop()}`);
  }, [flash]);

  // Keyboard and menu shortcuts.
  const commands = useRef<Record<string, () => void>>({});
  commands.current = {
    render: () => void render(),
    open: () => void openGraph(),
    save: () => void saveGraph(),
    new: () => loadGraph(starterGraph()),
    addNode: () => openMenu(pointer.current),
    workflows: () => openMenu(undefined, undefined, true),
    tutorial: () => setTutorial(true),
  };
  useEffect(() => {
    bridge?.onMenu((c) => commands.current[c]?.());
    const onKey = (e: KeyboardEvent) => {
      // Tab opens the Add node menu at the pointer, unless you're typing or moving between inspector fields.
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, select, [contenteditable], .inspector, .node-menu, .tutorial")) return;
        e.preventDefault();
        commands.current.addNode();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || isDesktop) return; // the desktop menu owns these
      const c = { r: "render", o: "open", s: "save" }[e.key.toLowerCase()];
      if (c) {
        e.preventDefault();
        commands.current[c]();
      }
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

  // A wire dropped on empty canvas opens the menu with the nodes that can take it.
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent, c: FinalConnectionState) => {
      if (c.isValid || c.toNode || !c.fromNode || c.fromHandle?.type !== "source" || !c.fromHandle.id) return;
      const p = "changedTouches" in e ? e.changedTouches[0] : e;
      openMenu({ x: p.clientX, y: p.clientY }, { node: c.fromNode.id, handle: c.fromHandle.id });
    },
    [openMenu],
  );

  /** The first input of `def` that the menu's wire can feed. */
  const portFor = useCallback(
    (def: NodeDef, from: MenuState["from"]) => {
      const shape = from && shapes.get(`${from.node}:${from.handle}`);
      return shape ? def.inputs.find((p) => canConnect(shape, def, p, CONVERTERS).ok) : undefined;
    },
    [shapes],
  );
  const menuDefs = useMemo(() => (menu?.from ? NODE_DEFS.filter((d) => portFor(d, menu.from)) : NODE_DEFS), [menu, portFor]);

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

  // A workflow drops in next to what's already there; its first node is selected so the inspector shows what to fill in.
  const pickWorkflow = useCallback(
    (id: string) => {
      const w = WORKFLOWS.find((x) => x.id === id);
      if (!menu || !w) return;
      setMenu(null);
      // Where it was asked for, unless that covers nodes already there: then under them.
      const box = (n: { position: { x: number; y: number }; measured?: { width?: number; height?: number } }) => ({
        l: n.position.x,
        t: n.position.y,
        r: n.position.x + (n.measured?.width ?? 2 * NODE_HALF_WIDTH),
        b: n.position.y + (n.measured?.height ?? 160),
      });
      const existing = flow.getNodes().map(box);
      let placed = placeWorkflow(w, menu.at);
      const covers = placed.nodes.map(box).some((a) => existing.some((e) => a.l < e.r && e.l < a.r && a.t < e.b && e.t < a.b));
      if (covers) {
        placed = placeWorkflow(w, { x: Math.min(...existing.map((e) => e.l)), y: Math.max(...existing.map((e) => e.b)) + 80 });
      }
      const f = toFlow(placed);
      f.nodes[0].selected = true;
      setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), ...f.nodes]);
      setEdges((es) => [...es, ...f.edges]);
      const first = REGISTRY.get(f.nodes[0].data.type)!;
      flash(`${w.title}: ${first.type === "input.download" ? "paste a link in the inspector" : first.type === "input.text" ? "type or paste your text" : "drop in your file"}, then Render.`);
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
      // An empty Images node takes all the dropped images at once.
      const images = all.filter((f) => inputNodeFor(f) === "input.file");
      const imagesNode = flow.getNodes().find((n) => n.data.type === "input.images" && !(n.data.params.assetIds as unknown[] | undefined)?.length);
      if (imagesNode && images.length) setNodeFiles(imagesNode.id, images);
      // Fill empty inputs of the right kind first, then add new ones.
      const empty = flow.getNodes().filter((n) => n.data.type !== "input.text" && n.data.type.startsWith("input.") && !n.data.params.assetId);
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

  const selected = nodes.find((n) => n.selected);
  const selectedRt = selected ? runtime[selected.id] : undefined;
  // Like TouchDesigner's background view, for the node picked with its eye button.
  const shownId = nodes.some((n) => n.id === view.preview) ? view.preview : undefined;
  const shown = shownId ? runtime[shownId] : undefined;
  const shownTitle = shownId ? REGISTRY.get(nodes.find((n) => n.id === shownId)!.data.type)?.title : undefined;

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

  return (
    <ShapesContext.Provider value={shapes}>
    <RuntimeContext.Provider value={runtime}>
      <PreviewContext.Provider value={shownId}>
      <ActionsContext.Provider value={{ setNodeFile, setNodeFiles, togglePreview }}>
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
              <button
                className={view.backdrop ? "active" : ""}
                onClick={() => setView((v) => ({ ...v, backdrop: !v.backdrop }))}
                title="Show the selected node's output behind the graph"
              >
                Background
              </button>
              <button className={view.panel ? "active" : ""} onClick={() => setView((v) => ({ ...v, panel: !v.panel }))} title="Preview panel under the graph">
                Panel
              </button>
              <button className="help" onClick={() => setTutorial(true)} title="Show the tutorial again">
                ?
              </button>
              {rendering && <button onClick={() => client.cancelRender()}>Cancel</button>}
              {recording ? (
                <button className="primary rec" onClick={() => client.stopRecording()} title="Stop recording and write the files">
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={render} disabled={rendering} title="Render (⌘R)">
                  {rendering ? "Rendering…" : "Render"}
                </button>
              )}
            </div>
          </header>

          <div className="main">
            <section className={`center${view.panel ? "" : " no-panel"}`}>
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
                {view.backdrop && shown && (shown.bitmap || shown.text !== undefined) && (
                  <div className="backdrop">
                    {shown.bitmap ? <Bitmap bitmap={shown.bitmap} className="backdrop-img" /> : <pre className="backdrop-text">{shown.text}</pre>}
                    <span className="backdrop-label">{shownTitle}</span>
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
              {view.panel && (
              <div className="preview">
                <div className="preview-bar">
                  <strong>{selected ? REGISTRY.get(selected.data.type)?.title : "Preview"}</strong>
                  <span className="muted">
                    {selectedRt?.size ? `${selectedRt.size.width}×${selectedRt.size.height}` : selected ? (selectedRt?.error ?? "") : "Select a node to see its output"}
                  </span>
                </div>
                <div className="preview-body">
                  {selectedRt?.bitmap ? (
                    <Bitmap bitmap={selectedRt.bitmap} className="preview-canvas" />
                  ) : (
                    selectedRt?.text !== undefined && <pre className="preview-text">{selectedRt.text}</pre>
                  )}
                </div>
              </div>
              )}
            </section>

            <Inspector node={selected} onParams={setParams} />
          </div>

          <footer className="tray">
            <strong>Outputs</strong>
            {outputs.length === 0 && <span className="muted">Rendered files show up here.</span>}
            {outputs.map((o) => (
              <span key={o.id} className="out-item" title={o.savedTo}>
                {o.name} <span className="muted">{(o.bytes / 1024).toFixed(0)} KB</span>
                {bridge && (
                  <button className="icon" onClick={() => bridge!.reveal(o.savedTo)}>
                    Show
                  </button>
                )}
              </span>
            ))}
          </footer>
          {tutorial && <Tutorial onClose={() => setTutorial(false)} />}
        </div>
      </ActionsContext.Provider>
      </PreviewContext.Provider>
    </RuntimeContext.Provider>
    </ShapesContext.Provider>
  );
}
