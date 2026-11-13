// A set of file paths kept in a JSON file, newest last, capped so it can't grow forever.
// Used for the files Toolbox wrote (only those can be replaced) and the files the person
// gave it (only those can be read through app://toolbox/@local/).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @param {string | null} file where the set is kept, or null for one that lives only this session
 * @param {number} cap the most paths kept; the oldest go first
 */
export function createPathSet(file, cap = 2000) {
  /** @type {Set<string>} insertion order = age */
  const paths = new Set();
  if (file) {
    try {
      const list = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(list)) for (const p of list.slice(-cap)) if (typeof p === "string") paths.add(p);
    } catch {
      // No file yet, or a broken one: start empty.
    }
  }
  let timer = null;
  const persist = () => {
    timer = null;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // Written next to it, then renamed, so a crash never leaves half a file.
      writeFileSync(`${file}.part`, JSON.stringify([...paths]));
      renameSync(`${file}.part`, file);
    } catch {
      // Not being able to remember isn't worth stopping for.
    }
  };
  const key = (p) => path.resolve(p);
  return {
    /** Adds paths (moving known ones to the newest end) and saves soon after. */
    add(...list) {
      let changed = false;
      for (const p of list) {
        if (typeof p !== "string" || !p || !path.isAbsolute(p)) continue;
        const k = key(p);
        paths.delete(k);
        paths.add(k);
        changed = true;
      }
      while (paths.size > cap) paths.delete(paths.values().next().value);
      if (changed && file && !timer) timer = setTimeout(persist, 200);
    },
    has: (p) => typeof p === "string" && !!p && path.isAbsolute(p) && paths.has(key(p)),
    /** Every path, oldest first. */
    list: () => [...paths],
    get size() {
      return paths.size;
    },
    /** Saves now, even when nothing changed, so the file exists. */
    save() {
      if (timer) clearTimeout(timer);
      persist();
    },
    /** Saves now what hasn't been saved yet (before quitting). */
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      persist();
    },
  };
}
