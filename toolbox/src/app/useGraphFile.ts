// Graphs as files: Open (in a tab of its own), Save (over its file), Save as, and closing a tab
// that has changes. Files opened from outside the window (Open Recent, a double-click in the
// Finder or Explorer) arrive here too.
import { useCallback, useEffect, useRef } from "react";
import { readGraph, serializeGraph } from "../graphs";
import { REGISTRY } from "../nodes";
import { bridge, openGraphFile, saveGraphFile, type GraphFile } from "../platform";
import type { Graph } from "../runtime/types";
import { closeLoses, fingerprint, nameFromPath } from "./documents";
import { hasContent, type Flash } from "./flow";
import type { Documents } from "./useDocuments";

interface GraphFileDeps {
  docs: Documents;
  restoreFiles: (g: Graph, docId: string) => Promise<number>;
  flash: Flash;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function useGraphFile({ docs, restoreFiles, flash }: GraphFileDeps) {
  const { docOf, graphOf, nodesOf, findByPath, switchTo, openDoc, closeDoc, markSaved, isUntouched } = docs;

  /** Shows a graph from a file in a tab of its own, or the tab that already has that file. */
  const showFile = useCallback(
    async (f: GraphFile) => {
      const open = f.path ? findByPath(f.path) : undefined;
      if (open) {
        switchTo(open.id);
        return flash(`${open.name} is already open.`);
      }
      try {
        const { graph: g, notes } = readGraph(f.text);
        if (!g.nodes.length) return flash(`${f.name} has no nodes this Toolbox can open.${notes.length ? ` ${notes.join(" ")}` : ""}`, 12000);
        // A starter graph nobody has touched gives its tab to the file.
        const id = openDoc({ name: nameFromPath(f.path ?? f.name), path: f.path, graph: g, replace: isUntouched() ? docs.activeId : undefined });
        const missing = await restoreFiles(g, id);
        const needsFiles = g.nodes.some((n) => REGISTRY.get(n.type)?.category === "input" && "assetId" in n.params && !n.params.path);
        const files = missing ? ` ${missing} file${missing === 1 ? " has" : "s have"} moved: drop ${missing === 1 ? "it" : "them"} in again.` : needsFiles ? " Drop the input files in again." : "";
        // Repairs stay up longer: they're worth reading.
        flash(`Opened ${f.name}.${files}${notes.length ? ` ${notes.join(" ")}` : ""}`, notes.length ? 15000 : 5000);
      } catch (err) {
        flash(`Couldn't open ${f.name}. ${errorText(err)}`, 10000);
      }
    },
    [docs.activeId, findByPath, flash, isUntouched, openDoc, restoreFiles, switchTo],
  );

  const openGraph = useCallback(async () => {
    const f = await openGraphFile();
    if (f) await showFile(f);
  }, [showFile]);

  // Files from the menu or the system, for as long as the window is open.
  const showFileRef = useRef(showFile);
  showFileRef.current = showFile;
  useEffect(() => bridge?.onOpenFile((f) => void showFileRef.current(f)), []);

  /** Asks where to save a tab's graph, and from then on it belongs to that file. Says whether it was saved. */
  const saveGraphAs = useCallback(
    async (id = docs.activeId) => {
      const doc = docOf(id);
      if (!doc) return false;
      const g = graphOf(id);
      try {
        const where = await saveGraphFile(serializeGraph(g), `${doc.name}.toolbox`);
        if (!where) return false;
        // A browser downloads the file: there's no path to save to next time.
        if (bridge) markSaved(id, where, fingerprint(g));
        flash(`Saved ${where.split(/[\\/]/).pop()}`);
        return true;
      } catch (err) {
        flash(`Couldn't save ${doc.name}. ${errorText(err)}`, 10000);
        return false;
      }
    },
    [docOf, docs.activeId, flash, graphOf, markSaved],
  );

  /** Saves a tab's graph over its file without asking, or asks where when it has none. */
  const saveGraph = useCallback(
    async (id = docs.activeId) => {
      const doc = docOf(id);
      if (!doc) return false;
      if (!doc.path || !bridge) return saveGraphAs(id);
      const g = graphOf(id);
      try {
        await bridge.saveGraphTo(doc.path, serializeGraph(g));
        markSaved(id, doc.path, fingerprint(g));
        flash(`Saved ${doc.path.split(/[\\/]/).pop()}`);
        return true;
      } catch (err) {
        // The folder may be gone or read-only: ask where instead.
        flash(`Couldn't save to ${doc.path}. ${errorText(err)}`, 10000);
        return saveGraphAs(id);
      }
    },
    [docOf, docs.activeId, flash, graphOf, markSaved, saveGraphAs],
  );

  /** Closes a tab, asking first when that would lose something (see closeLoses). */
  const closeGraph = useCallback(
    async (id = docs.activeId) => {
      const doc = docOf(id);
      if (!doc) return;
      const changed = fingerprint(graphOf(id)) !== doc.saved;
      if (closeLoses({ path: doc.path, changed, hasContent: hasContent(nodesOf(id)) })) {
        if (id !== docs.activeId) switchTo(id);
        const detail = doc.path ? "Your changes are lost if you don't save them." : "This graph isn't in a file, so it's lost if you don't save it.";
        // A browser tab can only ask OK or Cancel.
        const answer = bridge
          ? await bridge.ask(`Save changes to ${doc.name}?`, detail, ["Save", "Don't save", "Cancel"])
          : window.confirm(`Close ${doc.name} without saving?\n\n${detail}`) ? 1 : 2;
        if (answer === 2 || (answer === 0 && !(await saveGraph(id)))) return;
      }
      closeDoc(id);
    },
    [closeDoc, docOf, docs.activeId, graphOf, nodesOf, saveGraph, switchTo],
  );

  return { openGraph, saveGraph, saveGraphAs, closeGraph };
}
