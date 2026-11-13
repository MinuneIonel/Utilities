// "Folder of files": the rules on top of a folder's listing, kept apart from the nodes and the
// window so they can be tested on their own. Which files are new, what the card says, and how a
// file's sub-folder travels to Save.

/** One file in a folder, as the desktop app lists it (see electron/folder-list.js). */
export interface FolderEntry {
  path: string;
  /** Relative to the folder, with "/" between sub-folders. */
  name: string;
  size: number;
  mtimeMs: number;
}

/** Files a node already did with "Only new files" on: path -> the modified time it had then. */
export type DoneFiles = Record<string, number>;

/** The files not done yet: never done, or changed since. */
export function newOnly(entries: FolderEntry[], done: DoneFiles | undefined): FolderEntry[] {
  if (!done) return entries;
  return entries.filter((e) => done[e.path] !== e.mtimeMs);
}

/** A short fingerprint of a listing, so a file added, removed or changed makes a new cache key. */
export function listingDigest(entries: FolderEntry[]): string {
  let h = 0x811c9dc5;
  let h2 = entries.length;
  for (const e of entries) {
    const s = `${e.path}\u0000${e.size}\u0000${e.mtimeMs}\u0001`;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 31) + s.charCodeAt(i)) >>> 0;
    }
  }
  return `${entries.length}.${h.toString(36)}.${h2.toString(36)}`;
}

/** The folder's own name ("Holiday" for /Users/me/Pictures/Holiday). */
export const folderName = (folder: string) => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;

const plural = (n: number, one: string) => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;

/** What the node's card says: "128 images in Holiday", or with "Only new files", "12 new of 140 in Holiday". */
export function folderSummary(folder: string, total: number, fresh: number, onlyNew: boolean, more = false): string {
  const where = folderName(folder);
  const cut = more ? " (the first ones)" : "";
  if (!onlyNew) return `${plural(total, "image")} in ${where}${cut}`;
  return `${fresh.toLocaleString("en")} new of ${total.toLocaleString("en")} in ${where}${cut}`;
}

/** Why there's nothing to work on, in plain words: an empty folder, or nothing new in it. */
export function nothingToDo(folder: string, total: number, onlyNew: boolean, pattern: string): string {
  const where = folderName(folder);
  if (total && onlyNew) return `Nothing new in ${where}. ${plural(total, "image")} done before`;
  return pattern.trim() ? `No images in ${where} match ${pattern.trim()}` : `No images in ${where} yet`;
}

/** A batch file's name split into its sub-folder ("2024/beach") and its own name, for Save. */
export function splitSub(name: string): { sub: string; base: string } {
  const i = name.lastIndexOf("/");
  return i < 0 ? { sub: "", base: name } : { sub: name.slice(0, i), base: name.slice(i + 1) };
}

/** Where a node's "Only new files" record is kept: the graph's file (or its tab, before it has one) and the node. */
export const doneKey = (graph: string, nodeId: string) => `${graph}#${nodeId}`;
