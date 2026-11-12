// Render: runs the graph at full size and writes what the Save nodes got, plus the Outputs tray.
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { newId, newNode } from "../graphs";
import { CONVERTERS, REGISTRY } from "../nodes";
import { bridge, saveFile, type ExistsPolicy } from "../platform";
import type { RuntimeClient } from "../runtime/client";
import { canConnect, type outputShapes } from "../runtime/evaluate";
import type { Graph } from "../runtime/types";
import type { NodeRuntime, ToolFlowNode } from "../ui/context";
import type { Webcams } from "../ui/webcam";
import { OUTPUTS_STORE, readStore, upstreamOf, writeStore, type Flash, type OutputEntry, type SetEdges, type SetNodes } from "./flow";

interface RenderDeps {
  flow: ReactFlowInstance<ToolFlowNode, Edge>;
  client: RuntimeClient;
  webcams: Webcams;
  graphRef: MutableRefObject<Graph>;
  shapes: ReturnType<typeof outputShapes>;
  nodes: ToolFlowNode[];
  runtime: Record<string, NodeRuntime>;
  setNodes: SetNodes;
  setEdges: SetEdges;
  setRuntime: Dispatch<SetStateAction<Record<string, NodeRuntime>>>;
  flash: Flash;
  withoutHistory: (change: () => void) => void;
}

export function useRender({ flow, client, webcams, graphRef, shapes, nodes, runtime, setNodes, setEdges, setRuntime, flash, withoutHistory }: RenderDeps) {
  const [rendering, setRendering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [outputs, setOutputs] = useState<OutputEntry[]>(() => readStore<{ list: OutputEntry[] }>(OUTPUTS_STORE, { list: [] }).list);
  useEffect(() => writeStore(OUTPUTS_STORE, { list: outputs }), [outputs]);

  // The Render button says "Render & save" when something will be saved, and carries a dot when a result is out of date.
  const hasSave = nodes.some((n) => REGISTRY.get(n.data.type)?.saves);
  const hasSaveRef = useRef(hasSave);
  hasSaveRef.current = hasSave;
  const stale = Object.values(runtime).some((r) => r?.status === "stale");

  /** What each Save node last wrote, so an unchanged file isn't saved again. */
  const savedKeys = useRef(new Map<string, string>());
  /** The files each Save node wrote this session, the ones it may replace on the next Render. */
  const written = useRef(new Map<string, string[]>());
  /** Keeps a Save node's files in its settings too, so they're still its own after a restart. Not an undo step. */
  const rememberSaved = useCallback(
    (nodeId: string, paths: string[]) =>
      withoutHistory(() =>
        setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, params: { ...n.data.params, lastSaved: paths } } } : n))),
      ),
    [setNodes, withoutHistory],
  );

  /**
   * Renders the graph, or just what feeds one Save node (`only`), and writes the files.
   * A Save node whose file hasn't changed since it last saved is skipped, unless it's `only`.
   */
  const render = useCallback(
    async (only?: string, { save = true } = {}) => {
      if (rendering) return;
      let full = graphRef.current;
      // Nothing to save to: save the selected node's output, if a Save node can take it.
      if (save && !only && !full.nodes.some((n) => REGISTRY.get(n.type)?.saves)) {
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
      if (!save) {
        if (!result.error) flash(`Rendered. Press ${hasSaveRef.current ? "Render & save" : "Render"} to write files.`);
        return;
      }
      let unchanged = 0;
      let saved = 0;
      let kept = 0;
      const byNode = new Map<string, typeof result.files>();
      for (const f of result.files) byNode.set(f.nodeId, [...(byNode.get(f.nodeId) ?? []), f]);
      for (const [nodeId, files] of byNode) {
        const key = files[0].key;
        if (nodeId !== only && key && savedKeys.current.get(nodeId) === key) {
          unchanged += files.length;
          continue;
        }
        const node = g.nodes.find((n) => n.id === nodeId);
        let folder = node?.params.folder ? String(node.params.folder) : undefined;
        // A batch goes into one folder, asked for once, rather than a save dialog per file.
        if (!folder && files.length > 1 && bridge) {
          folder = (await bridge.chooseFolder()) ?? undefined;
          if (!folder) continue;
        }
        // The files this Save node wrote before are the only ones it may replace.
        const own = [...(written.current.get(nodeId) ?? []), ...(Array.isArray(node?.params.lastSaved) ? (node.params.lastSaved as string[]) : [])];
        const opts = { exists: (node?.params.exists as ExistsPolicy | undefined) ?? "replace-own", own };
        let last = "";
        let keptHere = 0;
        const paths: string[] = [];
        for (const f of files) {
          const r = await saveFile(f.name, f.mime, f.data, folder, opts);
          if (!r) continue;
          last = r.path;
          if (r.kept) {
            kept++;
            keptHere++;
            continue;
          }
          saved++;
          paths.push(r.path);
          setOutputs((o) => [{ id: newId("o"), name: r.path.split(/[\\/]/).pop() ?? f.name, bytes: f.size, savedTo: r.path }, ...o].slice(0, 30));
        }
        if (!last) continue;
        if (key) savedKeys.current.set(nodeId, key);
        if (paths.length && folder) {
          written.current.set(nodeId, paths);
          rememberSaved(nodeId, paths);
        }
        const dir = last.split(/[\\/]/).slice(-2, -1)[0] ?? "the folder";
        const savedTo =
          keptHere === files.length ? (files.length > 1 ? `Kept the ${files.length} files already in ${dir}` : `Kept ${last.split(/[\\/]/).pop()}, already there`)
          : files.length > 1 ? `${files.length - keptHere} files in ${dir}${keptHere ? `, kept ${keptHere}` : ""}`
          : last;
        setRuntime((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], savedTo } }));
      }
      if (result.error) return;
      const count = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
      if (unchanged && !saved && !kept) flash("Nothing changed since the last save. Press Save on a Save node to write it again.");
      else if (unchanged || kept) {
        const rest = [kept && `kept ${count(kept)} that ${kept === 1 ? "was" : "were"} already there`, unchanged && `${unchanged} unchanged since the last save`].filter(Boolean).join(", ");
        flash(saved ? `Saved ${count(saved)}; ${rest}.` : `Nothing saved: ${rest}.`);
      }
    },
    [client, flash, flow, graphRef, rememberSaved, rendering, setEdges, setNodes, setRuntime, shapes, webcams],
  );
  const saveNode = useCallback((id: string) => void render(id), [render]);
  const runNode = useCallback((id: string) => void render(id, { save: false }), [render]);
  const renderRef = useRef(render);
  renderRef.current = render;

  return { render, renderRef, saveNode, runNode, rendering, recording, outputs, setOutputs, hasSave, stale };
}
