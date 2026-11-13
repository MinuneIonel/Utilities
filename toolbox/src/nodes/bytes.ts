// A file's bytes, in memory or in the desktop app's scratch folder, and helpers that work with
// either. No runtime imports, so the tests can load it (and the cache can count disk files).
import type { Bytes, Value } from "../runtime/types";

export type DiskBytes = Extract<Bytes, { in: "disk" }>;

/** Disk files up to this size may be read whole into memory; bigger ones stay on disk. */
export const READ_LIMIT = 256 * 1024 * 1024;

export const fromBytes = (bytes: Uint8Array): Bytes => ({ in: "memory", bytes });

export const fromDisk = (path: string, size: number): Bytes => ({ in: "disk", path, size });

export const sizeOf = (d: Bytes): number => (d.in === "memory" ? d.bytes.byteLength : d.size);

export const onDisk = (d: Bytes): d is DiskBytes => d.in === "disk";

/** Where the desktop app serves a scratch file (with Range support, so it can be read in pieces). */
export function scratchUrl(path: string): string {
  return `app://toolbox/@scratch/${encodeURIComponent(path.split(/[\\/]/).pop() ?? "")}`;
}

/** Where the desktop app serves a file the person gave Toolbox (or one in a folder they chose), by its path. */
export const localUrl = (path: string) => `app://toolbox/@local/${encodeURIComponent(path)}`;

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** The file as a Blob. A disk file is fetched from the scratch folder. */
export async function asBlob(d: Bytes, type = ""): Promise<Blob> {
  if (d.in === "memory") return new Blob([d.bytes as Uint8Array<ArrayBuffer>], { type });
  const res = await fetch(scratchUrl(d.path));
  if (!res.ok) throw new Error("A result Toolbox kept on disk is gone. Render again.");
  const blob = await res.blob();
  return type && blob.type !== type ? new Blob([blob], { type }) : blob;
}

/**
 * The file's bytes, for the few things that need them all in memory. A disk file is read only
 * when it's small enough; a bigger one throws instead of filling the memory.
 */
export async function asBytes(d: Bytes): Promise<Uint8Array> {
  if (d.in === "memory") return d.bytes;
  if (d.size > READ_LIMIT) throw new Error(`This file is ${mb(d.size)}, too big to work on in memory (the limit is ${mb(READ_LIMIT)})`);
  return new Uint8Array(await (await asBlob(d)).arrayBuffer());
}

/** Every scratch file a value holds (a file and its batch), once each. */
export function diskPaths(v: Value | undefined, into = new Set<string>()): Set<string> {
  if (v?.kind === "file") {
    if (v.data.in === "disk") into.add(v.data.path);
    for (const f of v.batch ?? []) if (f !== v) diskPaths(f, into);
  }
  return into;
}

/**
 * How many holders each scratch file has (cached results, the last render of a job node, a
 * download kept for the session). A file whose count drops to 0 is handed to `free`.
 */
export class ScratchRefs {
  private counts = new Map<string, number>();
  private free: (paths: string[]) => void;

  constructor(free: (paths: string[]) => void = () => {}) {
    this.free = free;
  }

  retain(paths: Iterable<string>) {
    for (const p of paths) this.counts.set(p, (this.counts.get(p) ?? 0) + 1);
  }

  release(paths: Iterable<string>) {
    const freed: string[] = [];
    for (const p of paths) {
      const n = (this.counts.get(p) ?? 0) - 1;
      if (n > 0) this.counts.set(p, n);
      else if (this.counts.delete(p)) freed.push(p);
    }
    if (freed.length) this.free(freed);
  }

  /** Who holds `path` now (0 when nothing does). */
  count(path: string) {
    return this.counts.get(path) ?? 0;
  }

  setFree(free: (paths: string[]) => void) {
    this.free = free;
  }
}
