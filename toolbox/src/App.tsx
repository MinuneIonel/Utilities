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
import { CONVERTERS, NODE_DEFS, REGISTRY } from "./nodes";
import { findConverter } from "./runtime/evaluate";
import { newId, newNode, parseGraph, serializeGraph, starterGraph } from "./graphs";
import { bridge, isDesktop, openGraphFile, saveFile, saveGraphFile } from "./platform";
import { RuntimeClient } from "./runtime/client";
import type { Graph, Params } from "./runtime/types";
import type { NodeUpdate } from "./runtime/worker";
import { ActionsContext, RuntimeContext, type NodeRuntime, type ToolFlowNode } from "./ui/context";
import { Inspector } from "./ui/Inspector";
import { Bitmap, ToolNode } from "./ui/ToolNode";

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

const portType = (nodeType: string, side: "inputs" | "outputs", key: string | null) =>
  REGISTRY.get(nodeType)?.[side].find((p) => p.key === key)?.type;

export function App() {
  const initial = useMemo(() => toFlow(loadInitial()), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [runtime, setRuntime] = useState<Record<string, NodeRuntime>>({});
  const [rendering, setRendering] = useState(false);
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
          savedTo: u.mode === "preview" && u.status === "cached" ? old?.savedTo : undefined,
        },
      };
    });
  }, []);
  const client = useMemo(() => new RuntimeClient(onUpdate), [onUpdate]);

  // Only params and wiring matter to the runtime; dragging nodes around shouldn't re-run anything.
  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const runKey = useMemo(
    () => JSON.stringify([graph.nodes.map((n) => [n.id, n.type, n.params]), graph.edges.map((e) => [e.source, e.sourceHandle, e.target, e.targetHandle])]),
    [graph],
  );
  const graphRef = useRef(graph);
  graphRef.current = graph;

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
    const ids = new Set(g.nodes.map((n) => n.id));
    setRuntime((prev) => Object.fromEntries(Object.entries(prev).map(([id, r]) => [id, ids.has(id) ? { ...r, status: "running" } : r])));
    const result = await client.render(g);
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
  }, [client, flash, rendering]);

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
      const a = portType(s.data.type, "outputs", c.sourceHandle ?? null);
      const b = portType(t.data.type, "inputs", c.targetHandle ?? null);
      if (!a || !b || (a !== b && !findConverter(CONVERTERS, a, b))) return false;
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
    [flow],
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
      const isText = (f: File) => f.type.startsWith("text/") || /\.(txt|md|csv|srt)$/i.test(f.name);
      all.filter(isText).forEach(async (f, i) => {
        const id = addNode("input.text", { x: pos.x, y: pos.y + i * 40 });
        setParams(id, { text: await f.text() });
      });
      const files = all.filter((f) => f.type.startsWith("image/"));
      if (!files.length) {
        if (all.length && !all.some(isText)) flash("Images and text files work so far. Video, audio and PDF are coming.");
        return;
      }
      // Fill empty file inputs first, then add new ones.
      const empty = flow.getNodes().filter((n) => n.data.type === "input.file" && !n.data.params.assetId);
      files.forEach((f, i) => {
        const target = empty[i]?.id ?? addNode("input.file", { x: pos.x, y: pos.y + i * 40 });
        setNodeFile(target, f);
      });
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

  // Wires that pass through a converter are dashed and labelled with it.
  const displayEdges = useMemo(
    () =>
      edges.map((e) => {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        const a = s && portType(s.data.type, "outputs", e.sourceHandle ?? null);
        const b = t && portType(t.data.type, "inputs", e.targetHandle ?? null);
        const conv = a && b && a !== b ? findConverter(CONVERTERS, a, b) : undefined;
        return conv ? { ...e, label: conv.label, className: "converted" } : e;
      }),
    [edges, nodes],
  );
  const categories = [...new Set(NODE_DEFS.map((d) => d.category))];

  return (
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
              <button className="primary" onClick={render} disabled={rendering} title="Render (⌘R)">
                {rendering ? "Rendering…" : "Render"}
              </button>
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
              <p className="hint">Click or drag a node onto the canvas. Drop images anywhere.</p>
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
                {dropping && <div className="drop">Drop images to add them</div>}
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
  );
}
