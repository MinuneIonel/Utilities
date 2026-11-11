// Electron main process: one window, native menus, and the file access a
// browser tab doesn't have. The UI itself is the Vite build in dist/.
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, session, shell, systemPreferences } from "electron";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerModels } from "./models.js";
import { createPathSet } from "./path-set.js";
import { numberedOwn, saveAction } from "./save-policy.js";
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
        { label: "Save Graph…", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { type: "separator" },
        { label: "Render", accelerator: "CmdOrCtrl+R", click: () => send("render") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
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
    { role: "windowMenu" },
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

/**
 * Writes a file for a Save node. With a folder, `opts.exists` says what happens when the name is
 * taken (see save-policy.js); `opts.own` lists the files this Save node wrote before, the only ones
 * it may replace. Returns where the file is and whether the old one was kept, or null if cancelled.
 */
ipcMain.handle("save-file", async (_e, name, bytes, folder, opts = {}) => {
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
        await writeFile(part, bytes);
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
  await writeFile(target, bytes);
  writtenFiles().add(target);
  return { path: target, kept: false };
});

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("open-graph", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Toolbox graph", extensions: ["toolbox", "json"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { name: path.basename(r.filePaths[0]), text: await readFile(r.filePaths[0], "utf8") };
});

ipcMain.handle("save-graph", async (_e, text, suggestedName) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: "Toolbox graph", extensions: ["toolbox"] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, text, "utf8");
  return r.filePath;
});

ipcMain.handle("reveal", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("open-path", (_e, p) => shell.openPath(p));

/** Edit menu commands for text fields, which the window hands back when one has focus. */
const TEXT_EDITS = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
ipcMain.handle("edit-text", (e, command) => {
  if (TEXT_EDITS.has(command)) e.sender[command]();
});

app.whenReady().then(() => {
  allowCamera();
  registerTools();
  registerModels();
  registerUpdater(() => win);
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    // Files dropped into a graph earlier, read again from where they are on disk.
    if (pathname.startsWith("/@local/")) return net.fetch(pathToFileURL(decodeURIComponent(pathname.slice("/@local/".length))).toString());
    const file = path.normalize(path.join(dist, decodeURIComponent(pathname)));
    if (!file.startsWith(dist + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

app.on("will-quit", () => written?.flush());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
