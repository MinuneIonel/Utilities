// Media files a node reads: a Blob (a dropped file), or a file in the desktop app's scratch folder
// (a download, a converted copy), which Mediabunny reads through app:// a range at a time.
// No Mediabunny here, so this stays out of the lazily loaded codec chunk; video-codec.ts turns a
// MediaFile into an input source.
import type { Bytes, DiskMedia, MediaFile } from "../runtime/types";
import { fromDisk, scratchUrl } from "./bytes.ts";

export type { DiskMedia, MediaFile };

export const isDisk = (f: MediaFile): f is DiskMedia => !(f instanceof Blob);

export function diskMedia(path: string, size: number, name: string, type: string): DiskMedia {
  return { kind: "disk", path, size, name, type, url: scratchUrl(path) };
}

/** The file's name ("" when a Blob has none). */
export const mediaName = (f: MediaFile | undefined): string => (!f ? "" : isDisk(f) ? f.name : (f as File).name || "");

export const mediaType = (f: MediaFile): string => f.type;

export const mediaSize = (f: MediaFile): number => f.size;

/** A disk file as a file value's bytes (still on disk). */
export const bytesOfDisk = (f: DiskMedia): Bytes => fromDisk(f.path, f.size);

/** Something kept per file: a Blob by identity (and dropped with it), a disk file by its path. */
export class MediaCache<V> {
  private blobs = new WeakMap<Blob, V>();
  private paths = new Map<string, V>();

  get(f: MediaFile): V | undefined {
    return isDisk(f) ? this.paths.get(f.path) : this.blobs.get(f);
  }

  set(f: MediaFile, v: V) {
    if (isDisk(f)) this.paths.set(f.path, v);
    else this.blobs.set(f, v);
  }

  delete(f: MediaFile) {
    if (isDisk(f)) this.paths.delete(f.path);
    else this.blobs.delete(f);
  }
}
