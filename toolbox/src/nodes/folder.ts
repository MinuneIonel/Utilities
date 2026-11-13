// "Folder of files": every image in a folder on the computer, as a list, read again on each
// Render so next week's files are picked up (desktop app only). The worker lists the folders a
// graph names before running it (refreshFolders), so the node's cache key knows what's in them.
import { folderName, folderSummary, listingDigest, newOnly, nothingToDo, type DoneFiles, type FolderEntry } from "../folder-input";
import type { Graph, NodeDef, NodeResult, Params } from "../runtime/types";
import { localUrl } from "./bytes";
import { listOfImages } from "./file";
import { folderLister, type FolderQuery } from "./native";

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
  return { folder: String(p.folder ?? ""), kind: String(p.kind || "images"), pattern: String(p.pattern ?? ""), recursive: !!p.subfolders, onlyNew: !!p.onlyNew };
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
                ? nothingToDo(q.folder, r.entries.length, q.onlyNew, q.pattern)
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
    out.push({ nodeId: n.id, done: Object.fromEntries(l.entries.map((e) => [e.path, e.mtimeMs])) });
  }
  return out;
}

/** Thrown for a normal state that just needs something (a folder, files in it), not a failure. */
const waiting = (message: string) => Object.assign(new Error(message), { waiting: true });

export const folderInput: NodeDef = {
  type: FOLDER_TYPE,
  title: "Folder of files",
  category: "input",
  description:
    "Every image in a folder, as a list: nodes after it run on each one, and Save writes one file per image. Render looks in the folder again, so new files are picked up. With Only new files, the ones done before are left out.",
  inputs: [],
  outputs: [{ key: "images", label: "Images", type: "video" }],
  params: [
    { key: "pattern", label: "Only names like", kind: "text", commit: true, placeholder: "e.g. IMG_*" },
    { key: "subfolders", label: "Include sub-folders", kind: "toggle" },
    { key: "onlyNew", label: "Only new files", kind: "toggle" },
    { key: "at", label: "Preview image", kind: "number", min: 1, max: 500, step: 1 },
  ],
  // `kind` picks the files: images for now (videos, sounds and PDFs are for later).
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
    if (q.kind !== "images") throw waiting("Only images for now");
    const l = listings.get(keyOf(ctx.scope, ctx.nodeId));
    if (!l || l.folder !== q.folder) throw waiting("Looking in the folder…");
    if (l.problem) throw waiting(l.problem);
    const items = l.entries.map((e) => ({
      name: e.name,
      // Read when its turn comes, and let go after: a folder can hold thousands.
      async read() {
        const res = await fetch(localUrl(e.path));
        if (!res.ok) throw new Error(res.status === 404 ? `${e.name} was moved or deleted. Render again` : `Toolbox can't read ${e.name}`);
        const blob = await res.blob();
        return new File([blob], e.name.split("/").pop() ?? e.name, { type: blob.type });
      },
    }));
    return { images: await listOfImages(items, params.at, ctx, folderSummary(q.folder, l.total, l.entries.length, q.onlyNew, l.more)) };
  },
};
