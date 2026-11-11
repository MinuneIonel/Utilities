import path from "node:path";

// What a Save node does when its file is already in the folder. No Electron here, so the
// tests can run it in plain Node.

/** The Save node's "If the file exists" choices. */
export const POLICIES = ["replace-own", "number", "skip"];

/**
 * - "write":   nothing there yet, write it.
 * - "replace": the file is the one this Save node wrote last time, so it's replaced.
 * - "number":  someone else's file (or the node asked to keep both): write "name (2).ext".
 * - "skip":    leave the file that's there.
 * A Save node never replaces a file it didn't write itself.
 */
export function saveAction(exists, policy, isOwn) {
  if (!exists) return "write";
  if (policy === "skip") return "skip";
  if (policy === "number") return "number";
  return isOwn ? "replace" : "number";
}

/**
 * Which of `own` is `name` with a number added in `folder` ("qr (2).png" for "qr.png"), so a Save
 * node that had to number its file replaces that one next time instead of adding another.
 */
export function numberedOwn(own, folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numbered = new RegExp(`^${escape(stem)} \\(\\d+\\)${escape(ext)}$`);
  const dir = path.resolve(folder);
  return own.find((p) => path.dirname(path.resolve(p)) === dir && numbered.test(path.basename(p)));
}
