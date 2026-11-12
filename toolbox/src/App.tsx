// The window: wires the hooks under app/ together and lays out the top bar, canvas, settings
// panel and Outputs tray.
import { useCallback, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, useEdgesState, useNodesState, useReactFlow, type Edge } from "@xyflow/react";
import { starterGraph, WORKFLOWS } from "./graphs";
import { loadInitial, toFlow, typingIn, type Point } from "./app/flow";
import { useAssets } from "./app/useAssets";
import { useClipboard } from "./app/useClipboard";
import { useCommands } from "./app/useCommands";
import { useDrop } from "./app/useDrop";
import { useGraphFile } from "./app/useGraphFile";
import { useHistory } from "./app/useHistory";
import { useNodeMenu } from "./app/useNodeMenu";
import { useRender } from "./app/useRender";
import { useRuntime } from "./app/useRuntime";
import { useUpdates } from "./app/useUpdates";
import { useView } from "./app/useView";
import { ActionsContext, PreviewContext, RuntimeContext, ShapesContext, type ToolFlowNode } from "./ui/context";
import { Inspector } from "./ui/Inspector";
import { NodeMenu } from "./ui/NodeMenu";
import { OutputsTray } from "./ui/OutputsTray";
import { TopBar } from "./ui/TopBar";
import { Tutorial, tutorialSeen } from "./ui/Tutorial";
import { Bitmap, ToolNode } from "./ui/ToolNode";

const nodeTypes = { tool: ToolNode };

export function App() {
  const initial = useMemo(() => toFlow(loadInitial()), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<ToolFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [message, setMessage] = useState("");
  const [tutorial, setTutorial] = useState(() => !tutorialSeen());
  const flow = useReactFlow<ToolFlowNode, Edge>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<Point | undefined>(undefined);

  const flash = useCallback((text: string, ms = 5000) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), ms);
  }, []);

  const { runtime, setRuntime, client, graph, graphRef, shapes, webcams } = useRuntime(nodes, edges, flash);
  const { undo, redo, canUndo, canRedo, withoutHistory } = useHistory(graph, setNodes, setEdges, flash);
  const { setParams, setNodeFile, setNodeFiles, restoreFiles } = useAssets(client, setNodes, withoutHistory, graphRef);
  const { update, checkUpdate } = useUpdates(flash);
  const { copy, deleteSelected, paste, duplicate } = useClipboard(flow, setNodes, setEdges, canvasRef, pointer);
  const nodeMenu = useNodeMenu(flow, canvasRef, shapes, setNodes, setEdges, flash);
  const { menu, addNode, openMenu } = nodeMenu;
  const r = useRender({ flow, client, webcams, graphRef, shapes, nodes, runtime, setNodes, setEdges, setRuntime, flash, withoutHistory });
  const { loadGraph, openGraph, saveGraph } = useGraphFile({ graph, graphRef, client, flow, setNodes, setEdges, setRuntime, restoreFiles, flash });
  const v = useView(nodes, edges, shapes, runtime);
  const { dropping, setDropping, onDrop } = useDrop({ flow, flash, addNode, setNodeFile, setNodeFiles, setParams });

  const commands = useCommands({
    render: () => {
      // The Link box applies what was typed when it loses focus. ⌘R while typing a link would
      // otherwise render the old one, so let the box apply it first, then render once that's in.
      const el = document.activeElement;
      if (el instanceof HTMLElement && typingIn(el)) {
        el.blur();
        setTimeout(() => void r.renderRef.current(), 0);
      } else void r.render();
    },
    open: () => void openGraph(),
    save: () => void saveGraph(),
    new: () => {
      loadGraph(starterGraph());
      flash("New graph. ⌘Z brings the old one back.");
    },
    addNode: () => openMenu(pointer.current),
    workflows: () => openMenu(undefined, undefined, true),
    tutorial: () => setTutorial(true),
    checkUpdate,
    undo,
    redo,
    copy: () => void copy(),
    cut: () => {
      if (copy()) deleteSelected();
    },
    paste: () => paste(),
    duplicate,
    selectAll: () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true }))),
  });

  const selected = nodes.find((n) => n.selected);
  // A pasted link downloads during the live preview, where there's no Render to cancel.
  const downloading = nodes.some((n) => n.data.type === "input.download" && runtime[n.id]?.status === "running");
  const { saveNode, runNode } = r;
  const actions = useMemo(
    () => ({ setNodeFile, setNodeFiles, togglePreview: v.togglePreview, saveNode, runNode }),
    [runNode, saveNode, setNodeFile, setNodeFiles, v.togglePreview],
  );
  const inspectorWidth = v.view.inspectorHidden ? 0 : v.view.inspectorWidth;
  const { shown, scrubbed } = v;

  return (
    <ShapesContext.Provider value={shapes}>
    <RuntimeContext.Provider value={runtime}>
      <PreviewContext.Provider value={v.shownId}>
      <ActionsContext.Provider value={actions}>
        <div className="app">
          <TopBar
            commands={commands.current}
            canUndo={canUndo}
            canRedo={canRedo}
            message={message}
            update={update}
            rendering={r.rendering}
            recording={r.recording}
            downloading={downloading}
            hasSave={r.hasSave}
            stale={r.stale}
            flash={flash}
            onHelp={() => setTutorial(true)}
            onCancel={() => client.cancelRender()}
            onStopDownloads={() => client.stopDownloads()}
            onStopRecording={() => {
              client.stopRecording();
              webcams.stopRecording();
            }}
            onRender={() => void r.render()}
          />

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
                      {v.shownTitle}
                      {shown.size ? ` · ${shown.size.width}×${shown.size.height}` : ""}
                    </span>
                  </div>
                )}
                <ReactFlow
                  nodes={nodes}
                  edges={v.displayEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={nodeMenu.onConnect}
                  onConnectEnd={nodeMenu.onConnectEnd}
                  onNodeClick={(e, n) => e.altKey && v.togglePreview(n.id)}
                  connectionRadius={26}
                  onPaneContextMenu={(e) => {
                    e.preventDefault();
                    openMenu({ x: e.clientX, y: e.clientY });
                  }}
                  isValidConnection={nodeMenu.isValidConnection}
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
                    defs={nodeMenu.menuDefs}
                    workflows={menu.from ? undefined : WORKFLOWS}
                    x={menu.x}
                    y={menu.y}
                    title={menu.from ? "Add a node to this wire" : menu.workflows ? "Workflows: type to search" : undefined}
                    tab={menu.workflows ? "workflow" : undefined}
                    onPick={nodeMenu.pickFromMenu}
                    onPickWorkflow={nodeMenu.pickWorkflow}
                    onClose={nodeMenu.closeMenu}
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
                onPointerDown={v.resizeInspector}
                onDoubleClick={v.toggleInspector}
                title="Drag to resize the settings panel; double-click to hide or show it"
              />
              {!v.view.inspectorHidden && <Inspector node={selected} onParams={setParams} />}
            </div>
          </div>

          <OutputsTray outputs={r.outputs} onClear={() => r.setOutputs([])} />
          {tutorial && <Tutorial onClose={() => setTutorial(false)} />}
        </div>
      </ActionsContext.Provider>
      </PreviewContext.Provider>
    </RuntimeContext.Provider>
    </ShapesContext.Provider>
  );
}
