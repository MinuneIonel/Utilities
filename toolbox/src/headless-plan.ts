// A graph run from the command line (Toolbox --run, see headless.ts): the command line's settings,
// input files and out folder put into the graph, and the checks a run without the window needs.
// No imports with side effects, so the tests can run it in plain Node.
import type { Graph, GraphNode, Params } from "./runtime/types";

/** What a run needs to know about a kind of node (from its NodeDef). */
export interface NodeInfo {
  title: string;
  category: string;
  /** A Save node: writes files on Render. */
  saves?: boolean;
  defaults: Params;
}

/** An --input, checked by the main process: `files` is the file, or the images in the folder (`dir`). */
export interface RunInput {
  node: string;
  path: string;
  dir: boolean;
  files: string[];
}

/** What the main process sends for a run (see electron/cli.js). */
export interface RunRequest {
  graphText: string;
  /** Where the graph file is, for messages. */
  graphPath: string;
  sets: { node: string; param: string; value: unknown }[];
  inputs: RunInput[];
  /** The folder for Save nodes without one; "" for none. */
  out: string;
  /** The files each Save node wrote in earlier runs of this graph: the ones it may replace. */
  own?: Record<string, string[]>;
}

/** What the run did, for the main process: `code` 0 ok, 1 a node failed, 2 bad arguments or graph. */
export interface RunResult {
  code: 0 | 1 | 2;
  error?: string;
  /** Every file written (or kept, when it was there already and the Save node says to skip). */
  files: { nodeId: string; path: string; kept: boolean }[];
}

/** Why a run stopped: code 2 for the command line or the graph file, 1 for something the graph can't do. */
export class RunError extends Error {
  readonly code: 1 | 2;
  constructor(message: string, code: 1 | 2) {
    super(message);
    this.code = code;
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** How a node is named in messages: its title, with its id when another node has the same title. */
export function nodeLabel(graph: Graph, id: string, info: (type: string) => NodeInfo | undefined): string {
  const n = graph.nodes.find((x) => x.id === id);
  if (!n) return id;
  const title = info(n.type)?.title ?? n.type;
  const same = graph.nodes.filter((x) => (info(x.type)?.title ?? x.type) === title).length;
  return same > 1 ? `${title} (${n.id})` : title;
}

/** The node a command line names: by id, or by title when only one node has it (case doesn't matter). */
export function findNode(graph: Graph, name: string, info: (type: string) => NodeInfo | undefined): GraphNode {
  const byId = graph.nodes.find((n) => n.id === name);
  if (byId) return byId;
  const want = name.trim().toLowerCase();
  const matches = graph.nodes.filter((n) => (info(n.type)?.title ?? n.type).toLowerCase() === want);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new RunError(`${matches.length} nodes are called "${name}". Name one by its id: ${matches.map((n) => n.id).join(", ")}`, 2);
  const titles = [...new Set(graph.nodes.map((n) => info(n.type)?.title ?? n.type))];
  throw new RunError(`The graph has no node called "${name}". Its nodes: ${titles.join(", ")}`, 2);
}

/** Puts an --input's file (or files, or folder) into the node that reads it. */
function applyInput(node: GraphNode, input: RunInput, label: string, defaults: Params, category: string, already: boolean): Params {
  const p = node.params;
  // Folder input (C6): its folder comes from a `folder` setting.
  if (node.type === "input.folder" || (category === "input" && "folder" in defaults)) {
    if (!input.dir) throw new RunError(`${label} reads a folder, and ${input.path} is a file`, 2);
    return { ...p, folder: input.path };
  }
  // Several images: each --input adds files; a folder adds its images.
  if (Array.isArray(defaults.assetIds)) {
    if (input.dir && !input.files.length) throw new RunError(`There are no images in ${input.path}`, 2);
    const paths = [...(already && Array.isArray(p.paths) ? (p.paths as string[]) : []), ...input.files];
    return { ...p, paths, names: paths.map(baseName), assetIds: [], name: paths.length === 1 ? baseName(paths[0]) : `${paths.length} images` };
  }
  if ("assetId" in defaults) {
    if (input.dir) throw new RunError(`${label} reads one file, and ${input.path} is a folder`, 2);
    if (already) throw new RunError(`${label} reads one file; it was given more than one`, 2);
    return { ...p, path: input.path, name: baseName(input.path), assetId: "" };
  }
  throw new RunError(`${label} doesn't read files`, 2);
}

/**
 * The graph as the command line wants it run: --set settings, --input files, and --out for Save
 * nodes without a folder. Throws a RunError for anything that can't run without the window.
 */
export function prepareRun(graph: Graph, req: Pick<RunRequest, "sets" | "inputs" | "out">, info: (type: string) => NodeInfo | undefined): Graph {
  if (graph.nodes.some((n) => n.type === "input.webcam")) throw new RunError("A webcam graph needs the window", 1);
  const nodes = new Map(graph.nodes.map((n) => [n.id, { ...n, params: { ...n.params } }]));
  const label = (id: string) => nodeLabel(graph, id, info);
  for (const s of req.sets) {
    const n = nodes.get(findNode(graph, s.node, info).id)!;
    if (!(s.param in n.params)) {
      const keys = Object.keys(n.params).filter((k) => !["assetId", "assetIds", "lastSaved"].includes(k));
      throw new RunError(`${label(n.id)} has no setting "${s.param}". Its settings: ${keys.join(", ") || "none"}`, 2);
    }
    n.params[s.param] = s.value;
  }
  const given = new Set<string>();
  for (const input of req.inputs) {
    const n = nodes.get(findNode(graph, input.node, info).id)!;
    const def = info(n.type);
    n.params = applyInput(n, input, label(n.id), def?.defaults ?? {}, def?.category ?? "", given.has(n.id));
    given.add(n.id);
  }
  for (const n of nodes.values()) {
    if (!info(n.type)?.saves || n.params.folder) continue;
    if (!req.out) throw new RunError(`${label(n.id)} has no folder. Add --out <folder>, or pick a folder on the node in the app.`, 2);
    n.params.folder = req.out;
  }
  // An input with nothing to read would ask for a file to be dropped on it; say how to give it one here.
  for (const n of nodes.values()) {
    const d = info(n.type)?.defaults ?? {};
    const p = n.params;
    const empty = Array.isArray(d.assetIds) ? !(Array.isArray(p.paths) && p.paths.length) : "assetId" in d && !p.path;
    if (!empty || !graph.edges.some((e) => e.source === n.id)) continue;
    const title = info(n.type)?.title ?? n.type;
    const name = label(n.id) === title ? title : n.id;
    throw new RunError(`${label(n.id)} has no file. Give it one with --input "${name}=<file>"`, 1);
  }
  return { ...graph, nodes: graph.nodes.map((n) => nodes.get(n.id)!) };
}

/**
 * Whether a progress update is worth a line: the first one, then every 10% or more, and 100%. Returns the
 * percentage to print (-1 when the node can't tell how far it is), or undefined to stay quiet.
 */
export function progressStep(fraction: number, lastShown: number | undefined): number | undefined {
  if (fraction < 0) return lastShown === undefined ? -1 : undefined;
  const pct = Math.min(100, Math.floor(fraction * 100));
  return lastShown === undefined || pct >= lastShown + 10 || (pct === 100 && lastShown < 100) ? pct : undefined;
}
