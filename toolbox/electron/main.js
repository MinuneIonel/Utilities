// Electron main process: one window, native menus, and the file access a
// browser tab doesn't have. The UI itself is the Vite build in dist/.
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, session, shell, systemPreferences } from "electron";
import { existsSync } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRecent, graphPathsIn, recentLabel } from "./graph-files.js";
import { consentText, pathsInGraph } from "./local-files.js";
import { registerModels } from "./models.js";
import { createPathSet } from "./path-set.js";
import { serveRange } from "./range.js";
import { numberedOwn, saveAction } from "./save-policy.js";
import { createScratch } from "./scratch.js";
import { registerTools } from "./tools.js";
import { registerUpdater } from "./updater.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const devUrl = process.env.TOOLBOX_DEV_URL;

// A real origin for the UI (instead of file://) so module workers and wasm load normally.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// WebAssembly threads need SharedArrayBuffer, which a page only gets when it is cross-origin
// isolated. The UI only ever loads its own files, so it's turned on for the whole app: Remove
// background's model then uses every CPU core on computers where it can't use the GPU.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

// One Toolbox at a time (per profile): opening a graph file while it runs shows it in a tab of
// the running one (see second-instance below) instead of starting another.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

/** @type {BrowserWindow | null} */
let win = null;

/** Permissions the UI uses. Anything else a page asks for is refused. */
const ALLOWED = new Set(["media", "fullscreen", "clipboard-sanitized-write"]);

/** Webcam nodes need the camera, and the microphone to record sound; macOS asks the user once for each. */
function allowCamera() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (!ALLOWED.has(permission)) return callback(false);
    if (permission !== "media" || process.platform !== "darwin") return callback(true);
    const kinds = "mediaTypes" in details && details.mediaTypes?.length ? details.mediaTypes : ["video"];
    Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k === "audio" ? "microphone" : "camera"))).then(
      (ok) => callback(ok.every(Boolean)),
      () => callback(false),
    );
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Toolbox",
    backgroundColor: "#111214",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Centred in the 52 px top bar.
    trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadURL(devUrl ?? "app://toolbox/index.html");
  // Graph files wait until the page (again, after a reload) says it's listening for them.
  windowListening = false;
  win.webContents.on("did-start-loading", () => (windowListening = false));
  // A file dropped outside the canvas would otherwise replace the app with that file,
  // losing the graph; links open in the browser instead of a bare window.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => (win = null));
}

const send = (command) => win?.webContents.send("menu", command);

function buildMenu() {
  const isMac = process.platform === "darwin";
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Graph", accelerator: "CmdOrCtrl+N", click: () => send("new") },
        { label: "Open Graph…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
        { label: "Open Recent", submenu: recentMenu() },
        { type: "separator" },
        { label: "Save Graph", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { label: "Save Graph As…", accelerator: "Shift+CmdOrCtrl+S", click: () => send("saveAs") },
        { label: "Close Graph", accelerator: "CmdOrCtrl+W", click: () => send("closeTab") },
        { type: "separator" },
        { label: "Render", accelerator: "CmdOrCtrl+R", click: () => send("render") },
        { type: "separator" },
        // ⌘W closes a graph's tab now, so closing the window moves to ⇧⌘W.
        isMac ? { role: "close", accelerator: "Shift+CmdOrCtrl+W" } : { role: "quit" },
      ],
    },
    {
      // The graph has its own undo, copy and paste; text fields keep the usual ones (the window decides which).
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "Redo", accelerator: isMac ? "Shift+CmdOrCtrl+Z" : "CmdOrCtrl+Y", click: () => send("redo") },
        { type: "separator" },
        { label: "Cut", accelerator: "CmdOrCtrl+X", click: () => send("cut") },
        { label: "Copy", accelerator: "CmdOrCtrl+C", click: () => send("copy") },
        { label: "Paste", accelerator: "CmdOrCtrl+V", click: () => send("paste") },
        { label: "Duplicate", accelerator: "CmdOrCtrl+D", click: () => send("duplicate") },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: () => send("selectAll") },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    // Spelled out, as the default one closes the window with Ctrl+W on Windows and Linux.
    { role: "windowMenu", submenu: isMac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }] },
    {
      role: "help",
      submenu: [
        { label: "Tutorial", click: () => send("tutorial") },
        { label: "Workflows…", click: () => send("workflows") },
        { type: "separator" },
        { label: "Check for Updates…", click: () => send("checkUpdate") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** File > Open Recent: the last graphs opened or saved. */
function recentMenu() {
  const list = recent().list();
  if (!list.length) return [{ label: "No recent graphs", enabled: false }];
  return [
    ...list.map((p) => ({ label: recentLabel(p, app.getPath("home")), click: () => openFromOutside(p) })),
    { type: "separator" },
    {
      label: "Clear Menu",
      click: () => {
        recent().clear();
        if (process.platform !== "linux") app.clearRecentDocuments();
        buildMenu();
      },
    },
  ];
}

/** `name` in `folder`, or "name (2).ext" and so on when that's taken. */
async function freeName(folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 1; ; n++) {
    const p = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!(await exists(p))) return p;
  }
}

const exists = (p) => access(p).then(() => true, () => false);

/** Every file Toolbox wrote. A graph file can name any path in `lastSaved`, so a Save node only replaces one that's also here. */
let written;
const writtenFiles = () => (written ??= createPathSet(path.join(app.getPath("userData"), "written-files.json")));

/** Where big results wait on disk (see scratch.js); made when the app starts. */
let scratchFolder;
const scratch = () => (scratchFolder ??= createScratch(app.getPath("temp")));

/**
 * Writes a file for a Save node: `data` is its bytes, or `{ fromPath }` for a result waiting in the
 * scratch folder, which is copied (not moved: the same result can feed another Save node, and stays
 * cached). With a folder, `opts.exists` says what happens when the name is taken (see save-policy.js);
 * `opts.own` lists the files this Save node wrote before, the only ones it may replace. Returns where
 * the file is and whether the old one was kept, or null if cancelled.
 */
ipcMain.handle("save-file", async (_e, name, data, folder, opts = {}) => {
  const from = data && typeof data === "object" && !ArrayBuffer.isView(data) && "fromPath" in data ? data.fromPath : undefined;
  // Only Toolbox's own results are copied by path: the window never names any other file.
  if (from !== undefined && !scratch().inside(from)) throw new Error("Toolbox can only save its own results by path");
  const put = (to) => (from !== undefined ? copyFile(from, to) : writeFile(to, data));
  let target;
  if (folder) {
    await mkdir(folder, { recursive: true });
    target = path.join(folder, path.basename(name));
    const own = Array.isArray(opts.own) ? opts.own.filter((p) => typeof p === "string" && writtenFiles().has(p)).map((p) => path.resolve(p)) : [];
    let isOwn = own.includes(path.resolve(target));
    const taken = await exists(target);
    // It numbered its file last time because the name was taken: that numbered file is the one to replace.
    if (taken && !isOwn && saveAction(true, opts.exists, true) === "replace") {
      const mine = numberedOwn(own, folder, path.basename(name));
      if (mine && (await exists(mine))) [target, isOwn] = [mine, true];
    }
    const action = saveAction(taken, opts.exists, isOwn);
    if (action === "skip") return { path: target, kept: true };
    if (action === "number") target = await freeName(folder, path.basename(name));
    if (action === "replace") {
      // Written next to it first, so a failed write never loses the earlier file.
      const part = `${target}.part`;
      try {
        await put(part);
        await rename(part, target);
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
      writtenFiles().add(target);
      return { path: target, kept: false };
    }
  } else {
    // The system's save dialog asks about replacing by itself.
    const r = await dialog.showSaveDialog(win, { defaultPath: name });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await put(target);
  writtenFiles().add(target);
  return { path: target, kept: false };
});

// Results the graph worker streams to disk (an encoded video), written chunk by chunk.
ipcMain.handle("scratch-open", (_e, id, name) => scratch().open(String(id), String(name)));
ipcMain.handle("scratch-write", (_e, id, chunk, position) => scratch().write(String(id), chunk, position));
ipcMain.handle("scratch-close", (_e, id) => scratch().close(String(id)));
// Results the worker no longer holds; paths outside the scratch folder are ignored.
ipcMain.handle("scratch-delete", (_e, paths) => scratch().remove(paths));

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

/**
 * The files the window may read back by path: ones the person dropped or chose, or agreed to when a
 * graph named them. Kept across restarts, so the autosaved graph's files come back.
 */
const allowedFile = () => path.join(app.getPath("userData"), "allowed-files.json");
let allowed;
/** True on the first launch with an allow-list, when the autosaved graph's files are adopted once. */
let adoptAutosave;
const allowedFiles = () => {
  if (!allowed) {
    adoptAutosave = !existsSync(allowedFile());
    allowed = createPathSet(allowedFile());
  }
  return allowed;
};
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

// A file dropped or chosen in the window (the preload's pathForFile; only a real drop or dialog makes a File).
ipcMain.on("local-allow", (_e, p) => allowedFiles().add(p));
// Graphs autosaved before Toolbox kept this list: their files were the person's own drops.
// The window sends every open graph (one per tab), or a single one from before tabs.
ipcMain.handle("adopt-autosave", (_e, texts) => {
  allowedFiles();
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string");
  if (!adoptAutosave || !list.length) return;
  adoptAutosave = false;
  allowed.add(...list.flatMap((t) => pathsInGraph(t)));
  // Written even when empty: this happens once, so a graph opened later without its files isn't adopted next launch.
  allowed.save();
});

/** Graph files the person picked in an open or save dialog (or opened with Toolbox): the only ones Save writes over without asking. */
let graphFilesSet;
const graphFiles = () => (graphFilesSet ??= createPathSet(path.join(app.getPath("userData"), "graph-files.json")));
/** File > Open Recent. */
let recentList;
const recent = () => (recentList ??= createRecent(path.join(app.getPath("userData"), "recent.json")));

/** A graph file was opened or saved: Save may write over it from now on, and it goes to the top of Open Recent. */
function rememberGraph(p) {
  graphFiles().add(p);
  recent().add(p);
  if (process.platform !== "linux") app.addRecentDocument(p);
  buildMenu();
}

/**
 * Reads a graph file for the window. A graph from someone else can name any file, so this asks
 * before the window may read the ones it doesn't know. Every way of opening a graph comes here:
 * the Open dialog, Open Recent, and files opened with Toolbox from outside.
 */
async function readGraphFile(p) {
  const text = await readFile(p, "utf8");
  const named = pathsInGraph(text).filter((f) => !allowedFiles().has(f));
  const wanted = (await Promise.all(named.map(async (f) => ((await isFile(f)) ? f : null)))).filter(Boolean);
  if (wanted.length) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      ...consentText(wanted),
      buttons: ["Use them", "Open without files"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) allowedFiles().add(...wanted);
  }
  rememberGraph(p);
  return { name: path.basename(p), path: p, text };
}

ipcMain.handle("open-graph", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Toolbox graph", extensions: ["toolbox", "json"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readGraphFile(r.filePaths[0]);
});

/** Writes a graph file next to its old self first, so a failed write never loses the old one. */
async function writeGraph(p, text) {
  const part = `${p}.part`;
  try {
    await writeFile(part, text, "utf8");
    await rename(part, p);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}

ipcMain.handle("save-graph", async (_e, text, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: "Toolbox graph", extensions: ["toolbox"] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeGraph(r.filePath, String(text));
  rememberGraph(r.filePath);
  return r.filePath;
});

// Save over a graph's own file without a dialog: only one the person picked before, never any path the window names.
ipcMain.handle("save-graph-to", async (_e, p, text) => {
  if (typeof p !== "string" || !graphFiles().has(p)) throw new Error("Toolbox can only save over graph files you opened or saved");
  await writeGraph(p, String(text));
  rememberGraph(p);
});

/** A question from the window, with its own answers; resolves with the index of the button pressed. */
ipcMain.handle("ask", async (_e, message, detail, buttons) => {
  const list = Array.isArray(buttons) && buttons.length ? buttons.slice(0, 4).map(String) : ["OK"];
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: String(message),
    detail: String(detail ?? ""),
    buttons: list,
    defaultId: 0,
    cancelId: list.length - 1,
  });
  return response;
});

/** Whether the page is ready for graph files from outside; until then they wait in `waiting`. */
let windowListening = false;
let waiting = [];
/** One at a time, so their questions about files don't pile up on top of each other. */
let opening = Promise.resolve();

/** Opens a graph file in a tab: from Open Recent, a double-click in the Finder or Explorer, or the command line. */
function openFromOutside(p) {
  if (!win || !windowListening) {
    waiting.push(p);
    return;
  }
  opening = opening.then(async () => {
    if (!win) return void waiting.push(p);
    if (win.isMinimized()) win.restore();
    win.focus();
    try {
      win.webContents.send("open-file", await readGraphFile(p));
    } catch {
      recent().remove(p);
      buildMenu();
      await dialog.showMessageBox(win, { type: "warning", message: `Couldn't open ${path.basename(p)}`, detail: "It may have been moved or deleted." });
    }
  });
}

ipcMain.handle("open-file-ready", () => {
  windowListening = true;
  const list = waiting;
  waiting = [];
  for (const p of list) openFromOutside(p);
});

// macOS hands over files opened with Toolbox (a double-click, or dropped on the Dock icon) this way, even before the app is ready.
app.on("open-file", (e, p) => {
  e.preventDefault();
  openFromOutside(p);
});

// Windows and Linux start a second Toolbox with the file's path; it quits at once and the path arrives here.
app.on("second-instance", (_e, argv, cwd) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  for (const p of graphPathsIn(argv.slice(1), cwd)) openFromOutside(p);
});

// shell.openPath runs whatever it's given, so only files Toolbox wrote.
ipcMain.handle("reveal", (_e, p) => {
  if (writtenFiles().has(p)) shell.showItemInFolder(p);
});
ipcMain.handle("open-path", async (_e, p) => (writtenFiles().has(p) ? shell.openPath(p) : "Toolbox didn't write that file"));

/** Edit menu commands for text fields, which the window hands back when one has focus. */
const TEXT_EDITS = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
ipcMain.handle("edit-text", (e, command) => {
  if (TEXT_EDITS.has(command)) e.sender[command]();
});

/**
 * A file the window was given, read again from disk; anything else is refused. With a Range
 * header only that part is sent, so a long video is read as it's needed rather than whole.
 */
async function readLocal(p, range) {
  if (!allowedFiles().has(p)) return new Response("Toolbox wasn't given this file", { status: 403 });
  if (!(await isFile(p))) return new Response("Not found", { status: 404 });
  return range ? serveRange(p, range) : net.fetch(pathToFileURL(p).toString());
}

/** A result in the scratch folder, by its file name; nothing outside that folder. */
async function readScratch(name, range) {
  const p = path.join(scratch().dir, name);
  if (!name || name !== path.basename(name) || !scratch().inside(p) || !(await isFile(p))) return new Response("Not found", { status: 404 });
  return serveRange(p, range);
}

app.whenReady().then(() => {
  if (!firstInstance) return;
  allowCamera();
  scratch();
  // Tools read the files the person gave Toolbox, and Toolbox's own results in the scratch folder.
  registerTools((p) => allowedFiles().has(p) || scratch().inside(p), scratch());
  registerModels();
  registerUpdater(() => win);
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    // Files dropped into a graph earlier, read again from where they are on disk.
    const range = req.headers.get("range");
    if (pathname.startsWith("/@local/")) return readLocal(decodeURIComponent(pathname.slice("/@local/".length)), range);
    // Big results waiting on disk (an encoded video, a download), read a piece at a time.
    if (pathname.startsWith("/@scratch/")) return readScratch(decodeURIComponent(pathname.slice("/@scratch/".length)), range);
    const file = path.normalize(path.join(dist, decodeURIComponent(pathname)));
    if (!file.startsWith(dist + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  buildMenu();
  createWindow();
  // A graph file Toolbox was started with (Windows and Linux).
  for (const p of graphPathsIn(process.argv.slice(1), process.cwd())) openFromOutside(p);
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("will-quit", () => {
  written?.flush();
  allowed?.flush();
  graphFilesSet?.flush();
  scratchFolder?.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
