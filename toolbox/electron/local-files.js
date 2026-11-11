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

/** The question asked before a graph may read the files it names. */
export function consentText(paths, shown = 8) {
  const n = paths.length;
  const more = n > shown ? `\n…and ${n - shown} more` : "";
  return {
    message: `This graph uses ${n === 1 ? "a file" : `${n} files`} on this computer`,
    detail: `${paths.slice(0, shown).join("\n")}${more}\n\nOpen ${n === 1 ? "it" : "them"} only if you trust where the graph came from.`,
  };
}
