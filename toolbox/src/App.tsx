// The window: wires the hooks under app/ together and lays out the top bar, tabs, canvas,
// settings panel and Outputs tray, or Simple view in its place.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, useReactFlow, type Edge } from "@xyflow/react";
import { WORKFLOWS } from "./graphs";
import { typingIn, type Point } from "./app/flow";
import { DOCS_STORE, OLD_STORE } from "./app/documents";
import { useAssets } from "./app/useAssets";
import { useClipboard } from "./app/useClipboard";
import { useCommands } from "./app/useCommands";
import { useDocuments } from "./app/useDocuments";
import { useDrop } from "./app/useDrop";
import { useGraphFile } from "./app/useGraphFile";
import { useHistory } from "./app/useHistory";
import { useNodeMenu } from "./app/useNodeMenu";
import { usePlayback } from "./app/usePlayback";
import { useRender } from "./app/useRender";
import { useRuntime } from "./app/useRuntime";
import type { GivenFile } from "./app/useSimple";
import { useUpdates } from "./app/useUpdates";
import { useView } from "./app/useView";
import type { Graph } from "./runtime/types";
import { MODE_STORE, startMode, type ViewMode } from "./simple-form";
import { ActionsContext, PlayingContext, PreviewContext, RuntimeContext, ShapesContext, type ToolFlowNode } from "./ui/context";
import { Inspector } from "./ui/Inspector";
import { ModeSwitch } from "./ui/ModeSwitch";
import { NodeMenu } from "./ui/NodeMenu";
import { OutputsTray } from "./ui/OutputsTray";
import { Player, PlayerFrame } from "./ui/Player";
import { TabStrip } from "./ui/TabStrip";
import { SimpleView } from "./ui/SimpleView";
import { TopBar } from "./ui/TopBar";
import { Tutorial, tutorialSeen } from "./ui/Tutorial";
import { Bitmap, ToolNode } from "./ui/ToolNode";

const nodeTypes = { tool: ToolNode };

/** Simple view for someone new; Graph view for someone who already has a graph, and from then on the view last used. */
function initialMode(): ViewMode {
  try {
    return startMode(localStorage.getItem(MODE_STORE), localStorage.getItem(DOCS_STORE) !== null || localStorage.getItem(OLD_STORE) !== null);
  } catch {
    return "graph";
  }
}

export function App() {
  const [message, setMessage] = useState("");
  const [mode, setModeState] = useState(initialMode);
  // Simple view (and its worker) starts the first time it's shown, then stays, so switching back keeps the form.
  const [simpleStarted, setSimpleStarted] = useState(mode === "simple");
  // The tour is about the graph: it starts the first time Graph view opens.
  const [tutorial, setTutorial] = useState(() => mode === "graph" && !tutorialSeen());
  const flow = useReactFlow<ToolFlowNode, Edge>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<Point | undefined>(undefined);

  const flash = useCallback((text: string, ms = 5000) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), ms);
  }, []);

  // The open graphs (tabs); the one on screen is `nodes` and `edges`.
  const docs = useDocuments(flow, flash);
  const { nodes, edges, setNodes, setEdges, onNodesChange, onEdgesChange, activeId, openIds } = docs;
  const { runtime, setRuntimeOf, client, graph, graphRef, shapes, webcams, runKey } = useRuntime(nodes, edges, flash, activeId, openIds);
  const { undo, redo, canUndo, canRedo, withoutHistory } = useHistory(graph, activeId, openIds, setNodes, setEdges, flash);
  const { setParams, setNodeFile, setNodeFiles, restoreFiles } = useAssets({ client, setNodes, withoutHistory, graphRef, docs });
  const { update, checkUpdate } = useUpdates(flash);
  const { copy, deleteSelected, paste, duplicate } = useClipboard(flow, setNodes, setEdges, canvasRef, pointer);
  const nodeMenu = useNodeMenu(flow, canvasRef, shapes, setNodes, setEdges, flash, docs);
  const { menu, addNode, openMenu } = nodeMenu;
  const r = useRender({ flow, client, webcams, graphRef, shapes, nodes, runtime, setNodes, setEdges, setRuntimeOf, flash, withoutHistory, docs });
  const { openGraph, saveGraph, saveGraphAs, closeGraph } = useGraphFile({ docs, restoreFiles, flash });
  const v = useView(nodes, edges, shapes, runtime);
  const playback = usePlayback({
    client, graphRef, runKey, shapes, setParams, withoutHistory, flash,
    shownId: v.shownId,
    shownBitmap: v.shown?.bitmap,
    scrubbed: v.scrubbed,
    show: (id) => v.shownId !== id && v.togglePreview(id),
  });
  // A recording reads the cameras of the graph on screen, so it has to stop before another tab shows.
  const selectTab = (id: string) => (r.recording && id !== activeId ? flash("Stop the recording first.") : docs.switchTo(id));
  const closeTab = (id = activeId) => (r.recording ? flash("Stop the recording first.") : void closeGraph(id));

  // Written at once, so this launch's autosave doesn't make the next launch think it's an old graph.
  useEffect(() => {
    try {
      localStorage.setItem(MODE_STORE, mode);
    } catch {
      /* storage may be unavailable */
    }
  }, [mode]);
  // A canvas hidden since launch was fitted at zero size: fit it the first time it shows.
  const canvasShown = useRef(mode === "graph");
  const setMode = useCallback(
    (m: ViewMode) => {
      setModeState(m);
      if (m === "simple") setSimpleStarted(true);
      if (m === "graph" && !tutorialSeen()) setTutorial(true);
      if (m === "graph" && !canvasShown.current) {
        canvasShown.current = true;
        setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
      }
    },
    [flow],
  );
  /** "Open as graph" from a Simple form: its graph, with its files. */
  const openAsGraph = useCallback(
    (g: Graph, files: GivenFile[], title: string) => {
      for (const f of files) client.addAsset(f.id, f.blob, f.path);
      // In a tab of its own, like a workflow picked from the menu.
      docs.openDoc({ name: title, graph: g, replace: docs.isUntouched() ? docs.activeId : undefined });
      setMode("graph");
      flash(`Opened “${title}” as a graph, in a tab of its own.`, 8000);
    },
    [client, docs, flash, setMode],
  );
  const { dropping, setDropping, onDrop } = useDrop({ flow, flash, addNode, setNodeFile, setNodeFiles, setParams });

  const graphCommands: Record<string, () => void> = {
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
    saveAs: () => void saveGraphAs(),
    new: () => (r.recording ? flash("Stop the recording first.") : docs.newDoc()),
    closeTab: () => closeTab(),
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
  };
  // In Simple view the graph's own commands do nothing; New, Open and the tour switch to Graph view first.
  const toGraph = (c: string) => () => {
    setMode("graph");
    graphCommands[c]();
  };
  useCommands(mode === "graph" ? graphCommands : { new: toGraph("new"), open: toGraph("open"), tutorial: toGraph("tutorial"), checkUpdate });

  const selected = nodes.find((n) => n.selected);
  // A pasted link downloads during the live preview, where there's no Render to cancel.
  const downloading = nodes.some((n) => n.data.type === "input.download" && runtime[n.id]?.status === "running");
  const { saveNode, runNode } = r;
  const actions = useMemo(
    () => ({ setNodeFile, setNodeFiles, togglePreview: v.togglePreview, saveNode, runNode, play: playback.playNode }),
    [runNode, saveNode, setNodeFile, setNodeFiles, v.togglePreview, playback.playNode],
  );
  const inspectorWidth = v.view.inspectorHidden ? 0 : v.view.inspectorWidth;
  const { shown, scrubbed } = v;

  return (
    <>
    <ShapesContext.Provider value={shapes}>
    <RuntimeContext.Provider value={runtime}>
      <PreviewContext.Provider value={v.shownId}>
      <ActionsContext.Provider value={actions}>
      <PlayingContext.Provider value={playback.playingId}>
        <div className="app" hidden={mode !== "graph"}>
          <TopBar
            modeSwitch={<ModeSwitch mode="graph" onMode={setMode} />}
            commands={graphCommands}
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
          <TabStrip tabs={docs.tabs} active={activeId} busy={r.renderingIn} onSelect={selectTab} onClose={closeTab} onNew={() => graphCommands.new()} />

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
                    <PlayerFrame playback={playback} size={shown.size} />
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
                  deleteKeyCode={mode === "graph" ? ["Backspace", "Delete"] : null}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
                {shown && <Player playback={playback} scrubbed={scrubbed} stale={shown.status === "stale"} />}
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
      </PlayingContext.Provider>
      </ActionsContext.Provider>
      </PreviewContext.Provider>
    </RuntimeContext.Provider>
    </ShapesContext.Provider>
    {simpleStarted && <SimpleView active={mode === "simple"} onMode={setMode} openAsGraph={openAsGraph} />}
    </>
  );
}
