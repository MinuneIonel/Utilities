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
} from "@xyflow/react";
import { CONVERTERS, inputNodeFor, NODE_DEFS, REGISTRY } from "./nodes";
import { canConnect, outputShapes } from "./runtime/evaluate";
import { newId, newNode, parseGraph, serializeGraph, starterGraph } from "./graphs";
import { bridge, isDesktop, openGraphFile, saveFile, saveGraphFile } from "./platform";
import { RuntimeClient } from "./runtime/client";
import type { Graph, Params } from "./runtime/types";
import type { NodeUpdate, ProgressUpdate } from "./runtime/worker";
import { ActionsContext, RuntimeContext, ShapesContext, type NodeRuntime, type ToolFlowNode } from "./ui/context";
import { Inspector } from "./ui/Inspector";
import { Bitmap, ToolNode } from "./ui/ToolNode";
import { Webcams, type CamSpec } from "./ui/webcam";

const STORE = "toolbox.graph";
const VIEW_STORE = "toolbox.view";
const nodeTypes = { tool: ToolNode };
const CATEGORY_LABEL: Record<string, string> = {
  input: "Input",
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
  pdf: "PDF",
  output: "Output",
};

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
  const [view, setView] = useState<{ backdrop: boolean; panel: boolean }>(() => {
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

  const onUpdate = useCallback((u: NodeUpdate) => {
    setRuntime((prev) => {
      const old = prev[u.id];
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
    setRuntime((prev) => (prev[p.id] ? { ...prev, [p.id]: { ...prev[p.id], status: "running", progress: p.fraction, progressLabel: p.label } } : prev));
  }, []);
  const client = useMemo(() => new RuntimeClient(onUpdate, onProgress), [onUpdate, onProgress]);

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

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE, serializeGraph(graph));
      } catch {
        /* storage may be unavailable */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [graph]);

  const flash = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), 4000);
  }, []);

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
  };
  useEffect(() => {
    bridge?.onMenu((c) => commands.current[c]?.());
    const onKey = (e: KeyboardEvent) => {
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

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const type = e.dataTransfer.getData("application/x-toolbox-node");
      if (type) {
        addNode(type, pos);
        return;
      }
      const all = [...e.dataTransfer.files];
      const unknown = all.filter((f) => !inputNodeFor(f));
      if (unknown.length) flash(`Toolbox can't open ${unknown.map((f) => f.name).join(", ")}`);
      // Fill empty inputs of the right kind first, then add new ones.
      const empty = flow.getNodes().filter((n) => n.data.type !== "input.text" && n.data.type.startsWith("input.") && !n.data.params.assetId);
      let row = 0;
      for (const f of all) {
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
    [addNode, flash, flow, setNodeFile, setParams],
  );

  const selected = nodes.find((n) => n.selected);
  const selectedRt = selected ? runtime[selected.id] : undefined;
  // Like TouchDesigner's background view: the selected node's output, or the last one selected.
  const lastShown = useRef<string | undefined>(undefined);
  if (selected) lastShown.current = selected.id;
  const shownId = nodes.some((n) => n.id === lastShown.current) ? lastShown.current : undefined;
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
  const categories = [...new Set(NODE_DEFS.map((d) => d.category))];

  return (
    <ShapesContext.Provider value={shapes}>
    <RuntimeContext.Provider value={runtime}>
      <ActionsContext.Provider value={{ setNodeFile }}>
        <div className="app">
          <header className="topbar">
            <div className="brand">
              <span className="logo" /> TOOLBOX
            </div>
            <div className="group">
              <button onClick={() => commands.current.new()}>New</button>
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
            <aside className="library">
              <h2>Nodes</h2>
              {categories.map((cat) => (
                <div key={cat} className="lib-group">
                  <h3>{CATEGORY_LABEL[cat]}</h3>
                  {NODE_DEFS.filter((d) => d.category === cat).map((d) => (
                    <button
                      key={d.type}
                      className="lib-item"
                      draggable
                      title={d.description}
                      onDragStart={(e) => e.dataTransfer.setData("application/x-toolbox-node", d.type)}
                      onClick={() => addNode(d.type)}
                    >
                      {d.title}
                    </button>
                  ))}
                </div>
              ))}
              <p className="hint">Click or drag a node onto the canvas. Drop images, videos, sound, PDFs or text anywhere.</p>
            </aside>

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
        </div>
      </ActionsContext.Provider>
    </RuntimeContext.Provider>
    </ShapesContext.Provider>
  );
}
