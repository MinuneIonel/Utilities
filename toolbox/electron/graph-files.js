// Graph files the app opens from outside the window: the recent list under File > Open Recent,
// and files handed over on the command line (a double-click on a .toolbox file in Explorer or a
// Linux file manager starts Toolbox with its path). No Electron here, so the tests can run it in plain Node.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The last graph files opened or saved, newest first, kept in a JSON file.
 * @param {string | null} file where the list is kept, or null for one that lives only this session
 * @param {number} cap how many are kept
 */
export function createRecent(file, cap = 10) {
  /** @type {string[]} */
  let list = [];
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(saved)) list = saved.filter((p) => typeof p === "string" && path.isAbsolute(p)).slice(0, cap);
    } catch {
      // No list yet, or a broken one: start empty.
    }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // Written next to it, then renamed, so a crash never leaves half a file.
      writeFileSync(`${file}.part`, JSON.stringify(list));
      renameSync(`${file}.part`, file);
    } catch {
      // Not being able to remember isn't worth stopping for.
    }
  };
  return {
    list: () => [...list],
    /** Puts a path at the top (moving it there if it's already listed). */
    add(p) {
      if (typeof p !== "string" || !path.isAbsolute(p)) return;
      list = [p, ...list.filter((x) => x !== p)].slice(0, cap);
      save();
    },
    remove(p) {
      list = list.filter((x) => x !== p);
      save();
    },
    clear() {
      list = [];
      save();
    },
  };
}

/** Graph files named on a command line: arguments ending in .toolbox, made absolute against `cwd`. Switches are skipped. */
export function graphPathsIn(argv, cwd) {
  return argv.filter((a) => typeof a === "string" && !a.startsWith("-") && /\.toolbox$/i.test(a)).map((a) => path.resolve(cwd, a));
}

/** How a recent file is listed in the menu: its name, then the folder it's in (with ~ for the home folder). */
export function recentLabel(p, home = "") {
  const dir = path.dirname(p);
  const shown = home && (dir === home || dir.startsWith(home + path.sep)) ? `~${dir.slice(home.length)}` : dir;
  // A menu label treats & as a shortcut marker; && shows one.
  return `${path.basename(p)} — ${shown}`.replace(/&/g, "&&");
}
