// Folders the person chose for a "Folder of files" node: listing what's in them, and whether a
// path is inside one (only then may the window read it through app://toolbox/@local/).
// No Electron here, so the tests can run it in plain Node.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** A listing stops after this many files. */
export const MAX_FILES = 5000;

/** The extensions each kind of file has (lower case, without the dot). */
export const KIND_EXTS = {
  images: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic", "heif"],
};

/** Sorts names as a person would: "IMG_2" before "IMG_10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const naturalCompare = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** A file-name pattern ("IMG_*", "*.jpg", "photo-??"): * is any run of characters, ? one. Empty matches everything. */
export function matchesPattern(pattern, name) {
  const p = String(pattern ?? "").trim();
  if (!p) return true;
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i").test(name);
}

/** Whether a file name passes the listing's filters: not hidden, one of `exts`, and matching `pattern`. */
export function wanted(name, exts, pattern) {
  if (name.startsWith(".")) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  if (Array.isArray(exts) && exts.length && !exts.includes(ext)) return false;
  return matchesPattern(pattern, name);
}

/**
 * The files in `folder` that pass the filters, sorted by name. `name` is relative to the folder,
 * with "/" between sub-folders. Hidden files and folders and links are left out (a link could
 * point outside the folder). `more` is true when there were more than `cap`.
 * @returns {Promise<{ entries: { path: string; name: string; size: number; mtimeMs: number }[]; more: boolean }>}
 */
export async function listFolder(folder, { exts = [], pattern = "", recursive = false, cap = MAX_FILES } = {}) {
  const found = [];
  let more = false;
  const walk = async (dir, prefix) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => naturalCompare(a.name, b.name));
    for (const d of items) {
      if (found.length > cap) return;
      if (d.name.startsWith(".")) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (recursive) await walk(full, `${prefix}${d.name}/`).catch(() => undefined);
      } else if (d.isFile() && wanted(d.name, exts, pattern)) {
        found.push({ path: full, name: `${prefix}${d.name}` });
      }
    }
  };
  await walk(folder, "");
  if (found.length > cap) {
    more = true;
    found.length = cap;
  }
  found.sort((a, b) => naturalCompare(a.name, b.name));
  const entries = [];
  for (const f of found) {
    try {
      const s = await stat(f.path);
      entries.push({ ...f, size: s.size, mtimeMs: Math.round(s.mtimeMs) });
    } catch {
      // Gone since it was listed.
    }
  }
  return { entries, more };
}

/** Whether `p` is inside `folder` (not the folder itself). Both should be real paths (links resolved). */
export function isInside(folder, p) {
  const f = path.resolve(folder);
  const r = path.relative(f, path.resolve(p));
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
}

/** Every folder a graph's "Folder of files" nodes read from, once each. Bad JSON names none. */
export function foldersInGraph(text) {
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    return [];
  }
  const found = new Set();
  for (const n of Array.isArray(g?.nodes) ? g.nodes : []) {
    const f = n?.type === "input.folder" ? n?.params?.folder : undefined;
    if (typeof f === "string" && path.isAbsolute(f)) found.add(f);
  }
  return [...found];
}

/** A file name for what a node did in a folder, from its key (a graph or tab, and the node). */
export const runFileName = (key) => `${createHash("sha256").update(String(key)).digest("hex").slice(0, 24)}.json`;
