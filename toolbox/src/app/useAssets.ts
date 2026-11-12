// Files in input nodes: dropped or chosen ones, and (desktop app) the ones a graph used before,
// read again from where they are on disk.
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { newId } from "../graphs";
import { bridge, reopenFile } from "../platform";
import type { RuntimeClient } from "../runtime/client";
import type { Graph, Params } from "../runtime/types";
import type { SetNodes } from "./flow";
import type { Documents } from "./useDocuments";

/** Files read back for one node, and the path (or paths) they were read for. */
type Patch = { for: string | string[]; params: Params };

interface AssetDeps {
  client: RuntimeClient;
  setNodes: SetNodes;
  withoutHistory: (change: () => void) => void;
  graphRef: MutableRefObject<Graph>;
  docs: Pick<Documents, "activeId" | "patchDoc" | "allTexts">;
}

export function useAssets({ client, setNodes, withoutHistory, graphRef, docs }: AssetDeps) {
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
      let missing = 0;
      const patches = await Promise.all(
        g.nodes.map(async (n): Promise<[string, Patch] | undefined> => {
          const p = n.params;
          if (typeof p.path === "string" && p.path && !p.assetId) {
            const f = await reopenFile(p.path, String(p.name ?? ""));
            if (!f) return void missing++;
            const assetId = newId("a");
            client.addAsset(assetId, f, p.path);
            return [n.id, { for: p.path, params: { assetId } }];
          }
          const paths = Array.isArray(p.paths) ? (p.paths as string[]) : [];
          if (paths.length && !(p.assetIds as unknown[] | undefined)?.length) {
            const names = Array.isArray(p.names) ? (p.names as string[]) : [];
            const files = await Promise.all(paths.map((path, i) => reopenFile(path, names[i] ?? "")));
            if (files.some((f) => !f)) return void missing++;
            const assetIds = files.map((f, i) => {
              const id = newId("a");
              client.addAsset(id, f!, paths[i]);
              return id;
            });
            return [n.id, { for: paths, params: { assetIds } }];
          }
          return undefined;
        }),
      );
      const found = new Map(patches.filter((x): x is [string, Patch] => !!x));
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
    void (async () => {
      adopted.current ??= bridge?.adoptAutosave(allTexts());
      await adopted.current;
      await restoreFiles(graphRef.current, activeId);
    })();
  }, [activeId, allTexts, graphRef, restoreFiles]);

  return { setParams, setNodeFile, setNodeFiles, restoreFiles };
}
