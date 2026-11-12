// Open graphs (one per tab) as plain data: what's kept in localStorage, moving the single graph
// older versions autosaved into the first tab, tab names, and whether a graph has changes its
// file doesn't. No React or node registry here, so the tests can run it in plain Node.
import type { Graph } from "../runtime/types";

export const DOCS_STORE = "toolbox.docs";
/** Where Toolbox kept its one graph before tabs. Read once to move it over; left as it was, so going back a version still finds it. */
export const OLD_STORE = "toolbox.graph";
export const UNTITLED = "Untitled";

/** One open graph as kept in localStorage. */
export interface SavedDoc {
  id: string;
  name: string;
  /** The file it was opened from or saved to (desktop app only). */
  path?: string;
  /** The graph as serializeGraph writes it (no dropped files, only their paths). */
  graph: string;
  /** The graph's fingerprint when it was last opened or saved, or made: what "changed" is measured from. */
  saved?: string;
  /** A starter graph nobody has changed: an opened file or a workflow takes its place instead of a new tab. */
  fresh?: boolean;
}

export interface SavedDocs {
  active: string;
  docs: SavedDoc[];
}

const isDoc = (d: unknown): d is SavedDoc =>
  !!d && typeof d === "object" && typeof (d as SavedDoc).id === "string" && typeof (d as SavedDoc).graph === "string" && typeof (d as SavedDoc).name === "string";

/**
 * The tabs to open at launch: the ones kept last time, or the graph an older Toolbox autosaved as
 * the only tab, or a starter graph. A broken store counts as none.
 */
export function loadDocs(storage: Pick<Storage, "getItem">, newId: () => string, starter: () => string): SavedDocs {
  const read = (key: string) => {
    try {
      return storage.getItem(key);
    } catch {
      return null; // storage unavailable
    }
  };
  const kept = read(DOCS_STORE);
  if (kept) {
    try {
      const v = JSON.parse(kept) as Partial<SavedDocs>;
      const docs = (Array.isArray(v.docs) ? v.docs : []).filter(isDoc).map((d) => ({
        id: d.id,
        name: d.name || UNTITLED,
        graph: d.graph,
        ...(typeof d.path === "string" && d.path ? { path: d.path } : {}),
        ...(typeof d.saved === "string" ? { saved: d.saved } : {}),
        ...(d.fresh ? { fresh: true } : {}),
      }));
      // Two tabs with one id would share their previews and undo steps.
      const unique = docs.filter((d, i) => docs.findIndex((x) => x.id === d.id) === i);
      if (unique.length) return { active: unique.some((d) => d.id === v.active) ? v.active! : unique[0].id, docs: unique };
    } catch {
      /* a broken store: start over below */
    }
  }
  const id = newId();
  const old = read(OLD_STORE);
  if (old) return { active: id, docs: [{ id, name: UNTITLED, graph: old }] };
  return { active: id, docs: [{ id, name: UNTITLED, graph: starter(), fresh: true }] };
}

/** JSON with object keys sorted, so the same graph always gives the same text. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** cyrb53: a quick 53-bit string hash, plenty to tell two versions of a graph apart. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What a graph's file would hold, as a short string: two graphs with the same fingerprint save the
 * same. Files read back (asset ids) and where Save nodes wrote (`lastSaved`) don't count: neither
 * is a change the person made, and a Render shouldn't make the graph look edited.
 */
export function fingerprint(g: Pick<Graph, "nodes" | "edges">): string {
  const nodes = g.nodes.map((n) => {
    const { assetId: _a, assetIds: _b, lastSaved: _c, ...params } = n.params;
    return [n.id, n.type, params, n.position?.x ?? 0, n.position?.y ?? 0];
  });
  const edges = g.edges.map((e) => [e.id, e.source, e.sourceHandle ?? "", e.target, e.targetHandle ?? ""]);
  return hash(stable([nodes, edges]));
}

/** A tab's name for a file: its name without the extension. */
export function nameFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() || p;
  return base.replace(/\.(toolbox|json)$/i, "") || base;
}

/** `base`, or "base 2", "base 3"… when another tab already has that name. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The tab to show after closing `closing`: the one that was showing, or its right (else left) neighbour. */
export function afterClose(ids: string[], closing: string, active: string): string | undefined {
  if (closing !== active) return active;
  const i = ids.indexOf(closing);
  return ids[i + 1] ?? ids[i - 1];
}

/**
 * Whether closing a tab loses something, so it's worth asking first: changes not in its file, or,
 * for a graph with no file, anything it holds (it isn't kept anywhere once the tab is gone).
 */
export function closeLoses(doc: { path?: string; changed: boolean; hasContent: boolean }): boolean {
  return doc.changed || (!doc.path && doc.hasContent);
}
