// The files a saved graph names, read again from where they are on disk (desktop app). Used when a
// graph opens in a tab (useAssets) and when one runs without the window (headless.ts).
import { newId } from "../graphs";
import { bridge, reopenFile } from "../platform";
import type { Graph, Params } from "../runtime/types";

/** Files read back for one node, and the path (or paths) they were read for. */
export type FilePatch = { for: string | string[]; params: Params };

/**
 * Reads the files each node names (`path`, or `paths` for Several images) and hands them to the
 * graph worker through `addAsset`. Resolves with the params to put on each node (its asset ids),
 * and the nodes whose files couldn't be read (moved, deleted, or not allowed).
 */
export async function readGraphFiles(g: Graph, addAsset: (id: string, blob: Blob, path: string) => void): Promise<{ found: Map<string, FilePatch>; missing: string[] }> {
  const missing: string[] = [];
  if (!bridge) return { found: new Map(), missing };
  const patches = await Promise.all(
    g.nodes.map(async (n): Promise<[string, FilePatch] | undefined> => {
      const p = n.params;
      if (typeof p.path === "string" && p.path && !p.assetId) {
        const f = await reopenFile(p.path, String(p.name ?? ""));
        if (!f) return void missing.push(n.id);
        const assetId = newId("a");
        addAsset(assetId, f, p.path);
        return [n.id, { for: p.path, params: { assetId } }];
      }
      const paths = Array.isArray(p.paths) ? (p.paths as string[]) : [];
      if (paths.length && !(p.assetIds as unknown[] | undefined)?.length) {
        const names = Array.isArray(p.names) ? (p.names as string[]) : [];
        const files = await Promise.all(paths.map((path, i) => reopenFile(path, names[i] ?? "")));
        if (files.some((f) => !f)) return void missing.push(n.id);
        const assetIds = files.map((f, i) => {
          const id = newId("a");
          addAsset(id, f!, paths[i]);
          return id;
        });
        return [n.id, { for: paths, params: { assetIds } }];
      }
      return undefined;
    }),
  );
  return { found: new Map(patches.filter((x): x is [string, FilePatch] => !!x)), missing };
}
