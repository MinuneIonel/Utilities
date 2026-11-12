// Simple view's rules, kept apart from React and the nodes so they can be tested on their own: what
// a workflow's form declares, whether it fits the workflow's graph, which view a launch opens in,
// and what a form remembers between launches (settings and folder, never files or links).
import type { ParamDef, Params } from "./runtime/types";

/** What the person gives a workflow: a file, several, a link, some text, the camera, or nothing. */
export type InputKind = "file" | "files" | "link" | "text" | "camera" | "none";

/** What a workflow is about, for the icon on its tile. */
export type Topic = "video" | "sound" | "image" | "pdf" | "text" | "link" | "camera";

/** A workflow shown as a form in Simple view. Nodes are counted by their place in the chain, from 0. */
export interface WorkflowForm {
  /** Which node takes the person's input, and what kind. `label` heads the input area. */
  input: { node: number; kind: InputKind; label?: string; accept?: string };
  /** Settings shown on the form: a node's param under a friendlier label. At most 4. */
  fields: { node: number; param: string; label?: string }[];
  /** The node whose output is shown as the preview (default: the last node that runs live). */
  preview?: number;
  /** Button text: "Download", "Convert", "Make PDF"… */
  action: string;
  topic: Topic;
  /** The tile's text, when the workflow's description talks about the graph. */
  blurb?: string;
}

export const MAX_FIELDS = 4;

/** The param each input kind writes into its node. */
export const INPUT_PARAM: Record<InputKind, string | undefined> = {
  file: "assetId",
  files: "assetIds",
  link: "url",
  text: "text",
  camera: undefined,
  none: undefined,
};

/** Custom params a form can still show: Dither's effect stack, as a pick of its ready-made looks. */
export const LOOK_PARAMS = new Set(["dither.recipe:recipe"]);

/** What the checks need to know about a node type (a NodeDef fits). */
export interface FormNodeDef {
  kind: "frame" | "job";
  params: ParamDef[];
  defaults(): Params;
  saves?: boolean;
}

/** One sentence per thing in `form` that doesn't fit the workflow's chain of node types. Empty when it all fits. */
export function formProblems(form: WorkflowForm, types: string[], defOf: (type: string) => FormNodeDef | undefined): string[] {
  const problems: string[] = [];
  const nodeAt = (i: number, what: string) => {
    if (!Number.isInteger(i) || i < 0 || i >= types.length) {
      problems.push(`${what} points at node ${i}, but the chain has ${types.length}.`);
      return undefined;
    }
    const def = defOf(types[i]);
    if (!def) problems.push(`${what} points at ${types[i]}, which isn't a node type.`);
    return def;
  };
  for (const t of types) if (!defOf(t)) problems.push(`The chain has ${t}, which isn't a node type.`);

  const input = nodeAt(form.input.node, "The input");
  const param = INPUT_PARAM[form.input.kind];
  if (input && param && !(param in input.defaults())) problems.push(`The ${form.input.kind} input needs ${types[form.input.node]} to have ${param}.`);
  if (form.input.kind === "camera" && input && types[form.input.node] !== "input.webcam") problems.push("The camera input must be a Webcam node.");

  if (form.fields.length > MAX_FIELDS) problems.push(`${form.fields.length} fields; a form shows at most ${MAX_FIELDS}.`);
  const seen = new Set<string>();
  for (const f of form.fields) {
    const def = nodeAt(f.node, `The field ${f.param}`);
    if (!def) continue;
    const key = `${f.node}.${f.param}`;
    if (seen.has(key)) problems.push(`The field ${key} is there twice.`);
    seen.add(key);
    const p = def.params.find((d) => d.key === f.param);
    if (!p) problems.push(`${types[f.node]} has no setting ${f.param}.`);
    else if (p.kind === "custom" && !LOOK_PARAMS.has(`${types[f.node]}:${f.param}`)) problems.push(`${types[f.node]}'s ${f.param} has its own panel, which a form can't show.`);
    if (f.node === form.input.node && f.param === param) problems.push(`The field ${f.param} is the input itself.`);
  }
  if (form.preview !== undefined) nodeAt(form.preview, "The preview");
  if (!form.action.trim()) problems.push("The button has no text.");
  const saves = types.filter((t) => defOf(t)?.saves).length;
  if (saves !== 1) problems.push(`A form saves through exactly one Save node; this chain has ${saves}.`);
  return problems;
}

/** The node the preview shows: the form's choice, or the last one that runs live. */
export function previewNode(form: WorkflowForm, types: string[], defOf: (type: string) => FormNodeDef | undefined): number | undefined {
  if (form.preview !== undefined) return form.preview;
  for (let i = types.length - 1; i >= 0; i--) if (defOf(types[i])?.kind === "frame") return i;
  return undefined;
}

/** Why the button can't run yet, in plain words, or undefined when the input is there. */
export function inputProblem(kind: InputKind, params: Params | undefined, link = ""): string | undefined {
  const p = params ?? {};
  switch (kind) {
    case "file":
      return p.assetId ? undefined : "Choose a file first.";
    case "files":
      return Array.isArray(p.assetIds) && p.assetIds.length ? undefined : "Choose your files first.";
    case "link": {
      const t = link.trim();
      if (!t) return "Paste a link first.";
      return /^https?:\/\/\S+$/i.test(t) ? undefined : "That doesn't look like a link. It starts with https://";
    }
    case "text":
      return String(p.text ?? "").trim() ? undefined : "Type or paste some text first.";
    default:
      return undefined;
  }
}

/** Whether `v` is a value this param can take, so a remembered setting can't break the node. */
export function validValue(def: ParamDef, v: unknown): boolean {
  switch (def.kind) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) && v >= def.min && v <= def.max;
    case "select":
      return def.options.some((o) => o.value === v);
    case "toggle":
      return typeof v === "boolean";
    case "text":
      return typeof v === "string";
    case "custom":
      return !!v && typeof v === "object";
  }
}

// ------------------------------------------------------------ what a form remembers

/** Per workflow in localStorage: the fields' values by "node.param", and the folder if one was picked. */
export interface SimpleSettings {
  fields: Record<string, unknown>;
  folder?: string;
}

export const settingsKey = (workflowId: string) => `toolbox.simple.${workflowId}`;

export function readSettings(text: string | null | undefined): SimpleSettings {
  try {
    const raw = text ? JSON.parse(text) : undefined;
    if (!raw || typeof raw !== "object") return { fields: {} };
    const fields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields : {};
    return typeof raw.folder === "string" && raw.folder ? { fields, folder: raw.folder } : { fields };
  } catch {
    return { fields: {} };
  }
}

/** What to remember: the current value of each field. */
export function settingsOf(form: WorkflowForm, paramsAt: (node: number) => Params | undefined, folder?: string): SimpleSettings {
  const fields: Record<string, unknown> = {};
  for (const f of form.fields) {
    const v = paramsAt(f.node)?.[f.param];
    if (v !== undefined) fields[`${f.node}.${f.param}`] = v;
  }
  return folder ? { fields, folder } : { fields };
}

/**
 * Remembered values to put back, as param patches by node index. Only the form's own fields come
 * back, and only values their param can take: a stale or edited entry is dropped, not applied.
 */
export function settingsPatches(form: WorkflowForm, saved: SimpleSettings, paramDef: (node: number, key: string) => ParamDef | undefined): Map<number, Params> {
  const patches = new Map<number, Params>();
  for (const f of form.fields) {
    const key = `${f.node}.${f.param}`;
    if (!(key in saved.fields)) continue;
    const def = paramDef(f.node, f.param);
    const v = saved.fields[key];
    if (!def || !validValue(def, v)) continue;
    patches.set(f.node, { ...patches.get(f.node), [f.param]: v });
  }
  return patches;
}

// ------------------------------------------------------------ which view opens

export type ViewMode = "simple" | "graph";

export const MODE_STORE = "toolbox.mode";

/** New people start in Simple view; someone who already has a graph (an autosave) stays in Graph view. */
export function startMode(stored: string | null | undefined, hasAutosave: boolean): ViewMode {
  if (stored === "simple" || stored === "graph") return stored;
  return hasAutosave ? "graph" : "simple";
}
