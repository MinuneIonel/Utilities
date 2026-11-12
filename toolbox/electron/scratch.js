// Toolbox's scratch folder: big results (encoded videos, ffmpeg and yt-dlp output) are kept here
// on disk instead of in the window's memory, and Save copies them from here. One folder per run
// of the app, removed when it quits; folders a crashed run left behind go after a day.
// No Electron here, so the tests can run it in plain Node.
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { copyFile, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const PREFIX = "toolbox-scratch-";
const DAY = 24 * 3600 * 1000;

/** A file name that is safe in any folder: no separators, no characters Windows refuses. */
const safeName = (name) => String(name || "file").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").slice(-120) || "file";

/**
 * @param {string} root where scratch folders go (the system's temp folder)
 * @param {{ pid?: number, now?: number }} [opts]
 */
export function createScratch(root, { pid = process.pid, now = Date.now() } = {}) {
  const dir = path.join(root, `${PREFIX}${pid}`);
  // Folders other runs left behind (a crash, a forced quit) once they're a day old; a second
  // Toolbox running right now keeps its own.
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(PREFIX) || name === path.basename(dir)) continue;
      const p = path.join(root, name);
      try {
        if (now - statSync(p).mtimeMs > DAY) rmSync(p, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  } catch {
    // No temp folder to look in: nothing to clean.
  }
  mkdirSync(dir, { recursive: true });

  let n = 0;
  /** Files being written, by the id the window gave them. */
  const open_ = new Map();

  /** Whether `p` is a file in the scratch folder (never the folder itself, nor anything outside it). */
  const inside = (p) => {
    if (typeof p !== "string" || !p || !path.isAbsolute(p)) return false;
    const r = path.resolve(p);
    return r.startsWith(dir + path.sep) && path.dirname(r) === dir;
  };

  /** A new, unused path in the folder for a file called `name`. */
  const fresh = (name) => path.join(dir, `${++n}-${safeName(name)}`);

  return {
    dir,
    inside,
    fresh,
    /** Starts a file the window writes in chunks; returns its path. */
    async open(id, name) {
      if (open_.has(id)) throw new Error("That scratch file is already open");
      const p = fresh(name);
      const handle = await open(p, "w");
      open_.set(id, { handle, path: p, size: 0 });
      return p;
    },
    /** Writes a chunk at `position` (chunks can arrive out of order). */
    async write(id, chunk, position) {
      const f = open_.get(id);
      if (!f) throw new Error("That scratch file isn't open");
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      const at = Number.isFinite(position) && position >= 0 ? position : f.size;
      let done = 0;
      while (done < bytes.byteLength) {
        const { bytesWritten } = await f.handle.write(bytes, done, bytes.byteLength - done, at + done);
        done += bytesWritten;
      }
      f.size = Math.max(f.size, at + bytes.byteLength);
    },
    /** Finishes a file; returns where it is and how big. Closing twice is fine. */
    async close(id) {
      const f = open_.get(id);
      if (!f) throw new Error("That scratch file isn't open");
      open_.delete(id);
      await f.handle.close();
      return { path: f.path, size: (await stat(f.path)).size };
    },
    /** Moves a finished file (a tool's output) into the folder; a copy when it's on another drive. */
    async adopt(from, name) {
      const p = fresh(name);
      try {
        await rename(from, p);
      } catch {
        await copyFile(from, p);
        await rm(from, { force: true });
      }
      return { path: p, size: (await stat(p)).size };
    },
    /** Deletes scratch files; anything outside the folder is left alone. */
    async remove(paths) {
      for (const p of Array.isArray(paths) ? paths : [paths]) {
        if (!inside(p)) continue;
        for (const [id, f] of open_) {
          if (f.path !== path.resolve(p)) continue;
          open_.delete(id);
          await f.handle.close().catch(() => undefined);
        }
        await rm(p, { force: true });
      }
    },
    /** Removes the whole folder (when the app quits). */
    clear() {
      for (const f of open_.values()) f.handle.close().catch(() => undefined);
      open_.clear();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
