// A graph run from the command line (Toolbox --run), in a hidden window: the same graph worker and
// the same Save path as the app, with no canvas. main.tsx comes here instead of showing the app
// when the page is loaded with ?headless=1. The main process prints what this reports and exits.
import { readGraph } from "./graphs";
import { prepareRun, nodeLabel, progressStep, RunError, type NodeInfo, type RunRequest, type RunResult } from "./headless-plan";
import { REGISTRY } from "./nodes";
import { bridge, saveFile, type ExistsPolicy } from "./platform";
import { readGraphFiles } from "./app/read-files";
import { RuntimeClient } from "./runtime/client";
import type { Graph } from "./runtime/types";

const info = (type: string): NodeInfo | undefined => {
  const d = REGISTRY.get(type);
  return d && { title: d.title, category: d.category, saves: d.saves, defaults: d.defaults() };
};

const seconds = (ms = 0) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

async function run(req: RunRequest, log: (line: string) => void): Promise<RunResult> {
  const files: RunResult["files"] = [];
  let graph: Graph;
  try {
    const read = readGraph(req.graphText);
    for (const note of read.notes) log(note);
    graph = prepareRun(read.graph, req, info);
  } catch (e) {
    return { code: e instanceof RunError ? e.code : 2, error: (e as Error).message, files };
  }
  const label = (id: string) => nodeLabel(graph, id, info);
  const SCOPE = "run";

  // Each node's progress, as lines: started, every 10%, done or failed.
  const failed = new Map<string, string>();
  const shown = new Map<string, number>();
  const client = new RuntimeClient(
    (u) => {
      u.bitmap?.close();
      if (u.mode !== "render" || u.thumb) return;
      if (u.status === "running") log(`[${label(u.id)}] started`);
      else if (u.status === "ok") log(`[${label(u.id)}] done in ${seconds(u.ms)}`);
      else if (u.status === "error") {
        failed.set(u.id, u.error ?? "failed");
        log(`[${label(u.id)}] failed: ${u.error ?? ""}`);
      }
    },
    (p) => {
      const step = progressStep(p.fraction, shown.get(p.id));
      if (step === undefined) return;
      shown.set(p.id, step);
      log(`[${label(p.id)}] ${step < 0 ? "working" : `${step}%`}${p.label ? ` ${p.label}` : ""}`);
    },
  );

  // The files the graph names, read from disk as when it opens in a tab.
  const { found, missing } = await readGraphFiles(graph, (id, blob, path) => client.addAsset(id, blob, path));
  if (missing.length) {
    const n = graph.nodes.find((x) => x.id === missing[0])!;
    const what = typeof n.params.path === "string" && n.params.path ? n.params.path : "its files";
    return { code: 1, error: `${label(n.id)}: can't read ${what}. It may have been moved or deleted.`, files };
  }
  graph = { ...graph, nodes: graph.nodes.map((n) => (found.has(n.id) ? { ...n, params: { ...n.params, ...found.get(n.id)!.params } } : n)) };

  const result = await client.render(graph, SCOPE);

  // What the Save nodes got is written as Render & save writes it, failed nodes or not.
  const byNode = new Map<string, typeof result.files>();
  for (const f of result.files) byNode.set(f.nodeId, [...(byNode.get(f.nodeId) ?? []), f]);
  let saveError = "";
  for (const [nodeId, list] of byNode) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const folder = String(node?.params.folder ?? "");
    const own = [...(Array.isArray(node?.params.lastSaved) ? (node.params.lastSaved as string[]) : []), ...(req.own?.[nodeId] ?? [])];
    const opts = { exists: (node?.params.exists as ExistsPolicy | undefined) ?? "replace-own", own };
    for (const f of list) {
      try {
        const r = await saveFile(f.name, f.mime, f.data, folder, opts);
        if (r) files.push({ nodeId, path: r.path, kept: r.kept });
      } catch (e) {
        saveError ||= `${label(nodeId)}: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`;
      }
    }
  }

  const first = [...failed][0];
  if (first) return { code: 1, error: `${label(first[0])}: ${first[1]}`, files };
  if (result.error) return { code: 1, error: result.error, files };
  if (saveError) return { code: 1, error: saveError, files };
  if (!result.files.length) return { code: 1, error: "Nothing was saved: the graph has no Save node with something wired into it.", files };
  return { code: 0, files };
}

/** Waits for the main process to send the run, does it, and reports back. */
export function runHeadless() {
  document.title = "Toolbox (running a graph)";
  const b = bridge;
  if (!b?.onHeadlessRun) return;
  b.onHeadlessRun(async (req) => {
    let result: RunResult;
    try {
      result = await run(req, (line) => b.headlessLog(line));
    } catch (e) {
      result = { code: 1, error: (e as Error).message ?? String(e), files: [] };
    }
    b.headlessDone(result);
  });
}
