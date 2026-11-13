// Files in input nodes: dropped or chosen ones, and (desktop app) the ones a graph used before,
// read again from where they are on disk.
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { newId } from "../graphs";
import { bridge } from "../platform";
import type { RuntimeClient } from "../runtime/client";
import type { Graph, Params } from "../runtime/types";
import type { SetNodes } from "./flow";
import { readGraphFiles, type FilePatch as Patch } from "./read-files";
import type { Documents } from "./useDocuments";

interface AssetDeps {
  client: RuntimeClient;
  setNodes: SetNodes;
  withoutHistory: (change: () => void) => void;
  graphRef: MutableRefObject<Graph>;
  docs: Pick<Documents, "activeId" | "patchDoc" | "allTexts">;
  /** Read the autosaved graphs' files back at launch (the graph canvas; Simple view starts empty). */
  lastSession?: boolean;
}

export function useAssets({ client, setNodes, withoutHistory, graphRef, docs, lastSession = true }: AssetDeps) {
  const { activeId, patchDoc, allTexts } = docs;
  const setParams = useCallback(
    (id: string, patch: Params) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n))),
    [setNodes],
  );

  const setNodeFile = useCallback(
    (nodeId: string, file: File) => {
      const assetId = newId("a");
      // The desktop app knows where the file is, so it comes back after a restart.
      const path = bridge?.pathForFile(file) ?? "";
      client.addAsset(assetId, file, path);
      setParams(nodeId, { assetId, name: file.name, path });
    },
    [client, setParams],
  );

  const setNodeFiles = useCallback(
    (nodeId: string, files: File[]) => {
      const assetIds = files.map((f) => {
        const id = newId("a");
        client.addAsset(id, f, bridge?.pathForFile(f));
        return id;
      });
      const paths = files.map((f) => bridge?.pathForFile(f) ?? "");
      setParams(nodeId, { assetIds, paths, names: files.map((f) => f.name), name: files.length === 1 ? files[0].name : `${files.length} images` });
    },
    [client, setParams],
  );

  /** Reads the files a saved graph used from where they were on disk (desktop app). */
  const readBack = useCallback(
    async (g: Graph, docId: string) => {
      if (!bridge) return 0;
      const { found, missing: gone } = await readGraphFiles(g, (id, blob, path) => client.addAsset(id, blob, path));
      const missing = gone.length;
      if (!found.size) return missing;
      // Reading takes a while, and the node may have changed meanwhile. A file only goes back into a
      // node that still names it and hasn't got it already, in the tab it was read for, even if
      // another tab is showing by now.
      const stillWants = (params: Params, patch: Patch) =>
        typeof patch.for === "string"
          ? params.path === patch.for && !params.assetId
          : Array.isArray(params.paths) && JSON.stringify(params.paths) === JSON.stringify(patch.for) && !(params.assetIds as unknown[] | undefined)?.length;
      // Files coming back isn't something to undo.
      patchDoc(
        docId,
        (ns) =>
          ns.map((n) => {
            const patch = found.get(n.id);
            return patch && stillWants(n.data.params, patch) ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch.params } } } : n;
          }),
        withoutHistory,
      );
      return missing;
    },
    [client, patchDoc, withoutHistory],
  );

  /**
   * Reads back the files a tab's graph names; resolves with how many have moved. A tab already
   * being read back isn't read twice (opening a file and showing its tab both ask).
   */
  const reading = useRef(new Map<string, Promise<number>>());
  const restoreFiles = useCallback(
    (g: Graph, docId: string) => {
      const busy = reading.current.get(docId);
      if (busy) return busy;
      const job = readBack(g, docId).finally(() => reading.current.delete(docId));
      reading.current.set(docId, job);
      return job;
    },
    [readBack],
  );

  // The files of the tab on screen: the last session's at launch, and each tab's when it first shows.
  // Before the first, the files every autosaved tab names are adopted, once (see adopt-autosave).
  const adopted = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    if (!lastSession) return;
    void (async () => {
      adopted.current ??= bridge?.adoptAutosave(allTexts());
      await adopted.current;
      await restoreFiles(graphRef.current, activeId);
    })();
  }, [activeId, allTexts, graphRef, lastSession, restoreFiles]);

  return { setParams, setNodeFile, setNodeFiles, restoreFiles };
}
