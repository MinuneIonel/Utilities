// Running a saved graph from the command line, without the window:
//   Toolbox --run graph.toolbox [--set <node>.<param>=<value>]... [--input <node>=<file>]... [--out <folder>] [--quiet]
// This reads the arguments and finds the files they name. No Electron here, so the tests can run it in plain Node.
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How to use it, printed after a mistake in the arguments. */
export const USAGE = `Usage: Toolbox --run <graph.toolbox> [options]
  --set <node>.<setting>=<value>   change a setting, e.g. --set Dither.size=4
  --input <node>=<file or folder>  the file an input node reads (repeat it for Several images)
  --out <folder>                   where Save nodes without a folder write their files
  --quiet                          print only the saved files and errors
A node is named by its id, or by its title when only one node has it.`;

/** Switches Electron and Chromium read themselves; they can go anywhere on the line. */
const PASSTHROUGH = /^--(no-sandbox|disable-gpu|disable-gpu-sandbox|disable-dev-shm-usage|headless|enable-logging(=.*)?|v=\d+|user-data-dir=.+|inspect(-brk)?(=.*)?|remote-debugging-port=\d+|ozone-platform(-hint)?=.+|enable-features=.+|disable-features=.+|use-gl=.+|use-angle=.+)$/;

/** Whether this command line asks for a run without the window. */
export const isRun = (argv) => Array.isArray(argv) && argv.some((a) => a === "--run" || (typeof a === "string" && a.startsWith("--run=")));

/** A --set value: JSON when it reads as JSON (numbers, true, lists), otherwise the text as it is. */
export function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `~/x` is the home folder's x (a shell leaves `~` alone after `=` or in quotes); others are made absolute against `cwd`. */
export function resolvePath(p, cwd, home) {
  if (home && (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))) return path.join(home, p.slice(1));
  return path.resolve(cwd, p);
}

/**
 * Reads a --run command line. Everything before --run is Electron's (the app's folder in
 * development); after it come the graph and the options. Returns the run, or `{ error }` for
 * arguments that don't make sense (the app then exits with code 2).
 */
export function parseRunArgs(argv, cwd = process.cwd(), home = "") {
  const at = argv.findIndex((a) => a === "--run" || a.startsWith("--run="));
  if (at < 0) return { error: "Missing --run" };
  const rest = argv.slice(at + 1);
  if (argv[at].startsWith("--run=")) rest.unshift(argv[at].slice("--run=".length));
  const run = { graph: "", sets: [], inputs: [], out: "", quiet: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (PASSTHROUGH.test(a)) continue;
    // --flag value, or --flag=value.
    const flag = a.match(/^--(set|input|out)(?:=(.*))?$/s);
    if (flag) {
      let value = flag[2];
      if (value === undefined) {
        if (i + 1 >= rest.length) return { error: `--${flag[1]} needs a value` };
        value = rest[++i];
      }
      if (flag[1] === "out") {
        if (!value) return { error: "--out needs a folder" };
        if (run.out) return { error: "--out is given twice" };
        run.out = resolvePath(value, cwd, home);
      } else if (flag[1] === "set") {
        const eq = value.indexOf("=");
        // The setting is after the last dot, so a title may have dots in it.
        const dot = eq < 0 ? -1 : value.lastIndexOf(".", eq);
        if (eq < 0 || dot <= 0 || dot === eq - 1) return { error: `--set ${value}: write it as <node>.<setting>=<value>, e.g. Dither.size=4` };
        run.sets.push({ node: value.slice(0, dot), param: value.slice(dot + 1, eq), value: parseValue(value.slice(eq + 1)) });
      } else {
        const eq = value.indexOf("=");
        if (eq <= 0 || eq === value.length - 1) return { error: `--input ${value}: write it as <node>=<file>, e.g. "Image file=photo.png"` };
        run.inputs.push({ node: value.slice(0, eq), path: resolvePath(value.slice(eq + 1), cwd, home) });
      }
    } else if (a === "--quiet" || a === "-q") run.quiet = true;
    else if (a.startsWith("-")) return { error: `Unknown option ${a}` };
    else if (!run.graph) run.graph = resolvePath(a, cwd, home);
    else return { error: `Only one graph runs at a time (got ${path.basename(run.graph)} and ${a})` };
  }
  if (!run.graph) return { error: "Name the graph to run: Toolbox --run <graph.toolbox>" };
  return run;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

/** The images in a folder (not in folders inside it), in name order with numbers counted as numbers. */
export function imagesIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && IMAGE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((n) => path.join(dir, n));
}

/**
 * Checks the files and folders named by --input, and lists the images in each folder. Returns
 * `{ inputs }`, each with `dir` (a folder) and `files` (the file, or the folder's images), or `{ error }`.
 */
export function findInputs(inputs) {
  const found = [];
  for (const i of inputs) {
    let s;
    try {
      s = statSync(i.path);
    } catch {
      return { error: `--input ${i.node}: can't find ${i.path}` };
    }
    if (s.isDirectory()) found.push({ ...i, dir: true, files: imagesIn(i.path) });
    else if (s.isFile()) found.push({ ...i, dir: false, files: [i.path] });
    else return { error: `--input ${i.node}: ${i.path} isn't a file or a folder` };
  }
  return { inputs: found };
}

/**
 * Every path the command line names for the graph to read: --input files and folders (with the
 * images found in them) and path settings given with --set. A run may read these, for this run only.
 */
export function commandLinePaths(run, inputs = run.inputs) {
  const out = new Set();
  for (const i of inputs) {
    out.add(i.path);
    for (const f of i.files ?? []) out.add(f);
  }
  for (const s of run.sets) {
    if (!["path", "paths", "folder"].includes(s.param)) continue;
    for (const v of Array.isArray(s.value) ? s.value : [s.value]) if (typeof v === "string" && path.isAbsolute(v)) out.add(v);
  }
  return [...out];
}

/**
 * A read check for one run: true for a path in `paths`, or anywhere inside one of `folders`
 * (a folder given with --input is read as a whole).
 */
export function runAllowList(paths, folders = []) {
  const set = new Set(paths.map((p) => path.resolve(p)));
  const dirs = folders.map((d) => path.resolve(d) + path.sep);
  return (p) => {
    if (typeof p !== "string" || !p || !path.isAbsolute(p)) return false;
    const r = path.resolve(p);
    return set.has(r) || dirs.some((d) => r.startsWith(d));
  };
}

/**
 * What each Save node of a graph wrote in earlier runs, kept in a JSON file by graph path: a run
 * can't keep it in the graph file (it doesn't write the graph), and a Save node may only replace
 * its own files ("Replace my last save"), so a scheduled run replaces its file instead of piling up copies.
 * @param {string | null} file where it's kept, or null for this session only
 */
export function createRunSaves(file, cap = 200) {
  /** @type {Record<string, Record<string, string[]>>} */
  let all = {};
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) all = saved;
    } catch {
      // No file yet, or a broken one: start empty.
    }
  }
  return {
    /** The files each Save node (by id) of this graph wrote last time. */
    get: (graph) => {
      const g = all[path.resolve(graph)];
      return g && typeof g === "object" ? g : {};
    },
    /** Remembers what this run wrote, per Save node; nodes that wrote nothing keep what they had. */
    set(graph, byNode) {
      const key = path.resolve(graph);
      const next = { ...this.get(graph) };
      for (const [id, paths] of Object.entries(byNode)) if (paths.length) next[id] = paths;
      // Newest last, so the oldest graphs go first.
      delete all[key];
      all[key] = next;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete all[k];
      if (!file) return;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(`${file}.part`, JSON.stringify(all));
        renameSync(`${file}.part`, file);
      } catch {
        // Not being able to remember isn't worth stopping for.
      }
    },
  };
}
