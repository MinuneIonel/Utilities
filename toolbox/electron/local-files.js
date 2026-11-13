// Which files on this computer the window may read back by path (app://toolbox/@local/…).
// Only files the person dropped or chose, or agreed to when opening a graph that names them.
// No Electron here, so the tests can run it in plain Node.
import path from "node:path";

/** Every file path a graph's nodes name (`params.path`, `params.paths`), once each. Bad JSON names none. */
export function pathsInGraph(text) {
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    return [];
  }
  const found = new Set();
  for (const n of Array.isArray(g?.nodes) ? g.nodes : []) {
    const p = n?.params;
    if (!p || typeof p !== "object") continue;
    for (const v of [p.path, ...(Array.isArray(p.paths) ? p.paths : [])]) if (typeof v === "string" && path.isAbsolute(v)) found.add(v);
  }
  return [...found];
}

/** The question asked before a graph may read the files (and folders, see folder-list.js) it names. */
export function consentText(paths, shown = 8, folders = []) {
  const n = paths.length;
  const k = folders.length;
  const all = [...folders, ...paths];
  const more = all.length > shown ? `\n…and ${all.length - shown} more` : "";
  const files = n === 1 ? "a file" : `${n} files`;
  const dirs = k === 1 ? "a folder" : `${k} folders`;
  const what = n && k ? `${files} and ${dirs}` : k ? dirs : files;
  return {
    message: `This graph uses ${what} on this computer`,
    detail: `${all.slice(0, shown).join("\n")}${more}\n\nOpen ${all.length === 1 ? "it" : "them"} only if you trust where the graph came from.`,
  };
}
