// "Folder of files": every image in a folder on the computer, as a list, read again on each
// Render so next week's files are picked up (desktop app only). The worker lists the folders a
// graph names before running it (refreshFolders), so the node's cache key knows what's in them.
import { FOLDER_KINDS, folderKind, folderName, folderSummary, listingDigest, newOnly, nothingToDo, type DoneFiles, type FolderEntry, type FolderKind } from "../folder-input";
import type { EachValue, Graph, NodeDef, NodeResult, Params, PortDef, RunContext, Value } from "../runtime/types";
import { audioCodec } from "./audio";
import { localUrl } from "./bytes";
import { listOfImages } from "./file";
import { folderLister, type FolderQuery } from "./native";
import { documentOf } from "./pdf";
import { videoCodec, videoInput } from "./video";

export const FOLDER_TYPE = "input.folder";

/** A preview lists a folder again once its listing is this old; Render always does. */
const PREVIEW_RELIST_MS = 3000;

interface Listing {
  /** What was asked, so a changed setting lists again. */
  asked: string;
  at: number;
  folder: string;
  /** Every file that passes the filters. */
  total: number;
  /** The ones to work on (all of them, or the new ones). */
  entries: FolderEntry[];
  more: boolean;
  problem?: string;
  digest: string;
}

/** The newest listing for each folder node, keyed `scope:node`. */
const listings = new Map<string, Listing>();
const keyOf = (scope: string | undefined, nodeId: string | undefined) => `${scope ?? ""}:${nodeId ?? ""}`;

export function folderQuery(p: Params): FolderQuery {
  return { folder: String(p.folder ?? ""), kind: folderKind(p.kind), pattern: String(p.pattern ?? ""), recursive: !!p.subfolders, onlyNew: !!p.onlyNew };
}

/**
 * Lists the folders of a graph's folder nodes, before it runs. A preview reuses a listing that's
 * only a few seconds old; Render (`force`) and a window that got focus back always look again.
 */
export async function refreshFolders(graph: Graph, scope: string, force: boolean) {
  const list = folderLister();
  await Promise.all(
    graph.nodes
      .filter((n) => n.type === FOLDER_TYPE)
      .map(async (n) => {
        const k = keyOf(scope, n.id);
        const q = folderQuery(n.params);
        if (!q.folder || !list) return void listings.delete(k);
        const asked = JSON.stringify(q);
        const old = listings.get(k);
        if (!force && old && old.asked === asked && Date.now() - old.at < PREVIEW_RELIST_MS) return;
        let next: Listing;
        try {
          const r = await list(scope, n.id, q);
          const entries = q.onlyNew ? newOnly(r.entries, r.done) : r.entries;
          const problem = r.refused
            ? `Toolbox wasn't given ${folderName(q.folder)}. Choose the folder again`
            : r.missing
              ? `Can't find ${folderName(q.folder)}. It may have been moved`
              : !entries.length
                ? nothingToDo(q.folder, r.entries.length, q.onlyNew, q.pattern, folderKind(q.kind))
                : undefined;
          next = { asked, at: Date.now(), folder: q.folder, total: r.entries.length, entries, more: r.more, problem, digest: listingDigest(entries) };
        } catch (e) {
          next = { asked, at: Date.now(), folder: q.folder, total: 0, entries: [], more: false, problem: e instanceof Error ? e.message : String(e), digest: "x" };
        }
        listings.set(k, next);
      }),
  );
}

/** The window got focus back (files may have been added meanwhile), or a Render marked files done: look again. */
export function relistFolders() {
  for (const l of listings.values()) l.at = 0;
}

/** A graph was closed. */
export function forgetFolders(scope: string) {
  for (const k of [...listings.keys()]) if (k.startsWith(`${scope}:`)) listings.delete(k);
}

/**
 * After a Render: the files each folder node with "Only new files" worked on, to remember as done.
 * Only nodes that ran without a problem count.
 */
export function folderRuns(graph: Graph, scope: string, results: Map<string, NodeResult>): { nodeId: string; done: DoneFiles }[] {
  const out: { nodeId: string; done: DoneFiles }[] = [];
  for (const n of graph.nodes) {
    if (n.type !== FOLDER_TYPE || !n.params.onlyNew) continue;
    const r = results.get(n.id);
    const l = listings.get(keyOf(scope, n.id));
    if (!l || l.problem || (r?.status !== "ok" && r?.status !== "cached")) continue;
    // Whole files (videos, sounds, PDFs) that failed on the way aren't done.
    const each = Object.values(r.outputs).find((v) => v.kind === "each");
    const failed = new Set(each?.kind === "each" ? each.items.filter((i) => i.failed).map((i) => i.id) : []);
    out.push({ nodeId: n.id, done: Object.fromEntries(l.entries.filter((e) => !failed.has(itemId(e))).map((e) => [e.path, e.mtimeMs])) });
  }
  return out;
}

/** Tells a file apart from the same path with other contents, for cache keys. */
const itemId = (e: FolderEntry) => `${e.path}\u0000${e.size}\u0000${e.mtimeMs}`;

/** What each kind of folder gives: images as a list, the others as whole files, one after another. */
const PORTS: Record<FolderKind, PortDef> = {
  images: { key: "images", label: "Images", type: "video" },
  videos: { key: "images", label: "Videos", type: "video" },
  sounds: { key: "images", label: "Sounds", type: "audio" },
  pdfs: { key: "images", label: "PDFs", type: "document" },
};

/** A file of the folder, read when its turn comes. */
async function readEntry(e: FolderEntry): Promise<File> {
  const res = await fetch(localUrl(e.path));
  if (!res.ok) throw new Error(res.status === 404 ? `${e.name} was moved or deleted. Render again` : `Toolbox can't read ${e.name}`);
  const blob = await res.blob();
  return new File([blob], e.name.split("/").pop() ?? e.name, { type: blob.type });
}

/** A whole video, sound or PDF of the folder, as its own input node would give it. */
async function openEntry(kind: FolderKind, e: FolderEntry, ctx: RunContext, about?: string): Promise<Value> {
  const file = await readEntry(e);
  if (kind === "videos") {
    const video = await (await videoCodec()).videoFromFile(file, videoInput.defaults(), ctx);
    return { ...video, about };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "sounds") return { kind: "audio", name: file.name, mime: file.type, bytes, duration: await (await audioCodec()).duration(bytes), about };
  return { ...(await documentOf(file.name, bytes)), about };
}

/** Thrown for a normal state that just needs something (a folder, files in it), not a failure. */
const waiting = (message: string) => Object.assign(new Error(message), { waiting: true });

export const folderInput: NodeDef = {
  type: FOLDER_TYPE,
  title: "Folder of files",
  category: "input",
  description:
    "Every image, video, sound or PDF in a folder. Images come as a list: nodes after it run on each one. Videos, sounds and PDFs come one whole file at a time: on Render everything after it runs once per file. Save writes one file for each. Render looks in the folder again, so new files are picked up. With Only new files, the ones done before are left out.",
  inputs: [],
  outputs: [PORTS.images],
  outputsFor: (p) => [PORTS[folderKind(p.kind)]],
  each: (p) => folderKind(p.kind) !== "images",
  params: [
    { key: "kind", label: "Files", kind: "select", options: Object.entries(FOLDER_KINDS).map(([value, k]) => ({ value, label: k.label })) },
    { key: "pattern", label: "Only names like", kind: "text", commit: true, placeholder: "e.g. IMG_*" },
    { key: "subfolders", label: "Include sub-folders", kind: "toggle" },
    { key: "onlyNew", label: "Only new files", kind: "toggle" },
    { key: "at", label: "Preview file", kind: "number", min: 1, max: 500, step: 1 },
  ],
  defaults: () => ({ folder: "", kind: "images", pattern: "", subfolders: false, onlyNew: false, at: 1 }),
  kind: "frame",
  desktopOnly: true,
  // What's in the folder now, not just which folder: a new file makes a new result.
  cacheKey: (_p, ctx) => `${ctx.mode}|${listings.get(keyOf(ctx.scope, ctx.nodeId))?.digest ?? ""}`,
  previewParams: ["at"],
  async run(_inputs, params, ctx) {
    const q = folderQuery(params);
    if (!folderLister()) throw waiting("Folders work in the desktop app");
    if (!q.folder) throw waiting("Choose a folder");
    const l = listings.get(keyOf(ctx.scope, ctx.nodeId));
    if (!l || l.folder !== q.folder) throw waiting("Looking in the folder…");
    if (l.problem) throw waiting(l.problem);
    const kind = folderKind(q.kind);
    const about = folderSummary(q.folder, l.total, l.entries.length, q.onlyNew, l.more, kind);
    if (kind !== "images") {
      // Live preview: the previewed file, as its own input node would give it. Render: every file, in turn.
      if (ctx.mode === "preview") {
        const i = Math.min(l.entries.length, Math.max(1, Math.floor(Number(params.at) || 1))) - 1;
        return { images: await openEntry(kind, l.entries[i], ctx, about) };
      }
      const each: EachValue = {
        kind: "each",
        of: PORTS[kind].type as EachValue["of"],
        about,
        items: l.entries.map((e) => ({ id: itemId(e), name: e.name, load: () => openEntry(kind, e, ctx) })),
      };
      return { images: each };
    }
    // Read when its turn comes, and let go after: a folder can hold thousands.
    const items = l.entries.map((e) => ({ name: e.name, read: () => readEntry(e) }));
    return { images: await listOfImages(items, params.at, ctx, about) };
  },
};
