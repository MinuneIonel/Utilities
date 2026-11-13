// Simple view's state: the workflow picked on Simple home, as its own small graph (apart from the
// graph canvas and its autosave), run by its own worker through the same hooks the canvas uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Edge } from "@xyflow/react";
import { WORKFLOWS, type Workflow } from "../graphs";
import { REGISTRY } from "../nodes";
import { doneKey } from "../folder-input";
import { bridge } from "../platform";
import type { Graph, Params } from "../runtime/types";
import { inputProblem, previewNode, readSettings, settingsKey, settingsOf, settingsPatches } from "../simple-form";
import type { ToolFlowNode } from "../ui/context";
import { toFlow, type Flash } from "./flow";
import { useAssets } from "./useAssets";
import { useRender } from "./useRender";
import { useRuntime } from "./useRuntime";

/** A file the form was given, so "Open as graph" can hand it to the canvas's worker. */
export interface GivenFile {
  id: string;
  blob: Blob;
  path?: string;
}

/** Simple view has no undo: its changes go straight in. */
const noHistory = (change: () => void) => change();
/** Simple view always has its Save node, so Render never looks for a selected node. */
const noFlow = { getNodes: () => [] as ToolFlowNode[] };
/** Simple view's one graph, in the terms the canvas's hooks use for tabs (its worker is its own anyway). */
const SCOPE = "simple";
const ONLY = [SCOPE];

const storage = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

export function useSimple(flash: Flash, active: boolean) {
  const [workflow, setWorkflow] = useState<Workflow | undefined>();
  const [nodes, setNodes] = useState<ToolFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /** The typed link: it only goes into the Download node when the button is pressed, so typing never starts a download. */
  const [link, setLink] = useState("");
  /** The folder picked for this workflow, if any; otherwise files go to the default folder. */
  const [picked, setPicked] = useState<string | undefined>();
  const [defaultFolder, setDefaultFolder] = useState<string | undefined>();
  /** True once the button was pressed for what's on the form now, so the saved files show. */
  const [ran, setRan] = useState(false);

  const { runtime, setRuntime, setRuntimeOf, client, graphRef, shapes, webcams } = useRuntime(nodes, edges, flash, SCOPE, ONLY);
  const docs = useMemo(
    () => ({
      activeId: SCOPE,
      patchDoc: (_id: string, change: (ns: ToolFlowNode[]) => ToolFlowNode[]) => setNodes(change),
      allTexts: () => [],
    }),
    [],
  );
  const { setParams, setNodeFile, setNodeFiles } = useAssets({ client, setNodes, withoutHistory: noHistory, graphRef, docs, lastSession: false });
  const r = useRender({ flow: noFlow, client, webcams, graphRef, shapes, nodes, runtime, setNodes, setEdges, setRuntimeOf, flash, withoutHistory: noHistory, docs, outputsStore: null });

  useEffect(() => {
    void bridge?.defaultFolder().then(setDefaultFolder, () => undefined);
  }, []);

  const form = workflow?.form;
  const idAt = useCallback((i: number | undefined) => (i === undefined ? undefined : nodes[i]?.id), [nodes]);
  const inputId = idAt(form?.input.node);
  const saveId = nodes.find((n) => REGISTRY.get(n.data.type)?.saves)?.id;
  const types = useMemo(() => nodes.map((n) => n.data.type), [nodes]);
  const previewId = form ? idAt(previewNode(form, types, (t) => REGISTRY.get(t))) : undefined;
  const folder = picked ?? defaultFolder;

  /** The files given to each input node, in the order of its asset ids. */
  const given = useRef(new Map<string, File[]>());

  const remember = useCallback(
    (w: Workflow, list: ToolFlowNode[], folderPicked: string | undefined) => {
      try {
        storage()?.setItem(settingsKey(w.id), JSON.stringify(settingsOf(w.form, (i) => list[i]?.data.params, folderPicked)));
      } catch {
        /* storage full or unavailable: the settings last until the app closes */
      }
    },
    [],
  );

  const open = useCallback(
    (id: string) => {
      const w = WORKFLOWS.find((x) => x.id === id);
      if (!w) return;
      const g = w.build();
      const saved = readSettings(storage()?.getItem(settingsKey(w.id)));
      const patches = settingsPatches(w.form, saved, (i, key) => REGISTRY.get(g.nodes[i]?.type ?? "")?.params.find((d) => d.key === key));
      g.nodes.forEach((n, i) => {
        n.params = { ...n.params, ...patches.get(i) };
        // Each press keeps the files from before ("photo.jpg", "photo (2).jpg"), and a text box starts empty.
        // A folder's photos done before are left as they are, so pressing again only adds the new ones.
        if (REGISTRY.get(n.type)?.saves) n.params = { ...n.params, exists: w.form.input.kind === "folder" ? "skip" : "number", folder: "" };
      });
      const input = g.nodes[w.form.input.node];
      if (input && w.form.input.kind === "folder" && saved.input) input.params = { ...input.params, folder: saved.input };
      if (input && w.form.input.kind === "text") input.params = { ...input.params, text: "" };
      if (input && w.form.input.kind === "link") input.params = { ...input.params, url: "" };
      const f = toFlow(g);
      given.current.clear();
      setRuntime({});
      setNodes(f.nodes);
      setEdges(f.edges);
      setWorkflow(w);
      setLink("");
      setPicked(saved.folder);
      setRan(false);
      r.setOutputs([]);
    },
    [r, setRuntime],
  );

  const close = useCallback(() => {
    if (r.recording) {
      client.stopRecording();
      webcams.stopRecording();
    } else if (r.rendering) client.cancelRender();
    given.current.clear();
    setWorkflow(undefined);
    setNodes([]);
    setEdges([]);
    setRuntime({});
    setLink("");
    setRan(false);
  }, [client, r.recording, r.rendering, setRuntime, webcams]);

  // A form that uses the camera lets go of it when Graph view takes over.
  useEffect(() => {
    if (!active && form?.input.kind === "camera") close();
  }, [active, close, form]);

  // The Save node writes to the folder on the form (desktop app); a browser tab downloads instead.
  useEffect(() => {
    if (!saveId || !folder) return;
    const n = nodes.find((x) => x.id === saveId);
    if (n && n.data.params.folder !== folder) setParams(saveId, { folder });
  }, [folder, nodes, saveId, setParams]);

  const setField = useCallback(
    (node: number, param: string, value: unknown) => {
      const id = nodes[node]?.id;
      if (!id || !workflow) return;
      setParams(id, { [param]: value });
      setRan(false);
      remember(workflow, nodes.map((n, i) => (i === node ? { ...n, data: { ...n.data, params: { ...n.data.params, [param]: value } } } : n)), picked);
    },
    [nodes, picked, remember, setParams, workflow],
  );

  const giveFiles = useCallback(
    (files: File[]) => {
      if (!inputId || !form || !files.length) return;
      if (form.input.kind === "file") {
        given.current.set(inputId, [files[0]]);
        setNodeFile(inputId, files[0]);
      } else if (form.input.kind === "files") {
        given.current.set(inputId, files);
        setNodeFiles(inputId, files);
      }
      setRan(false);
    },
    [form, inputId, setNodeFile, setNodeFiles],
  );

  const setText = useCallback(
    (text: string) => {
      if (!inputId) return;
      setParams(inputId, { text });
      setRan(false);
    },
    [inputId, setParams],
  );

  // What a folder workflow did is kept per workflow: its graph is made afresh each time it opens.
  client.doneKeyOf = () => doneKey("simple", workflow?.id ?? "");

  /** A folder workflow's folder, chosen in the system's dialog (which lets Toolbox read it). */
  const chooseInput = useCallback(async () => {
    const f = await bridge?.chooseInputFolder();
    if (!f || !inputId || !workflow || !form) return;
    setParams(inputId, { folder: f });
    setRan(false);
    remember(workflow, nodes.map((n, i) => (i === form.input.node ? { ...n, data: { ...n.data, params: { ...n.data.params, folder: f } } } : n)), picked);
  }, [form, inputId, nodes, picked, remember, setParams, workflow]);

  /** Every photo in the folder counts as new again. */
  const forgetDone = useCallback(async () => {
    if (!inputId) return;
    await client.forgetDone(SCOPE, inputId);
    client.preview(graphRef.current);
  }, [client, graphRef, inputId]);

  const chooseFolder = useCallback(async () => {
    const f = await bridge?.chooseFolder();
    if (!f || !workflow) return;
    setPicked(f);
    remember(workflow, nodes, f);
  }, [nodes, remember, workflow]);

  const inputParams = nodes.find((n) => n.id === inputId)?.data.params;
  const missing = form ? inputProblem(form.input.kind, inputParams, link) : undefined;

  const run = useCallback(async () => {
    if (!form || !saveId || r.rendering) return;
    if (missing) return flash(missing);
    // The link goes in now, just before running, so typing it never started a download.
    if (form.input.kind === "link" && inputId) flushSync(() => setParams(inputId, { url: link.trim() }));
    r.setOutputs([]);
    setRan(true);
    await r.renderRef.current(saveId);
    // Out again, so changing a setting afterwards doesn't download it again in the background.
    if (form.input.kind === "link" && inputId) setParams(inputId, { url: "" });
  }, [flash, form, inputId, link, missing, r, saveId, setParams]);

  const stop = useCallback(() => {
    if (r.recording) {
      client.stopRecording();
      webcams.stopRecording();
    } else client.cancelRender();
  }, [client, r.recording, webcams]);

  /** The form's graph as it stands, with the typed link, and the files it was given. */
  const forGraph = useCallback((): { graph: Graph; files: GivenFile[] } => {
    const g = graphRef.current;
    const files: GivenFile[] = [];
    const nodes = g.nodes.map((n) => {
      let params: Params = n.params;
      if (n.id === inputId && form?.input.kind === "link") params = { ...params, url: link.trim() };
      const list = given.current.get(n.id) ?? [];
      const ids = n.params.assetIds ? (n.params.assetIds as string[]) : n.params.assetId ? [String(n.params.assetId)] : [];
      ids.forEach((id, i) => list[i] && files.push({ id, blob: list[i], path: bridge?.pathForFile(list[i]) || undefined }));
      return { ...n, params };
    });
    return { graph: { ...g, nodes }, files };
  }, [form, graphRef, inputId, link]);

  return {
    workflow,
    form,
    nodes,
    runtime,
    open,
    close,
    setField,
    giveFiles,
    setText,
    link,
    setLink,
    folder,
    chooseFolder,
    chooseInput,
    forgetDone,
    inputId,
    inputParams,
    missing,
    previewId,
    run,
    stop,
    ran,
    rendering: r.rendering,
    recording: r.recording,
    outputs: r.outputs,
    forGraph,
  };
}
