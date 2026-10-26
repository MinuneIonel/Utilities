// Electron main process: one window, native menus, and the file access a
// browser tab doesn't have. The UI itself is the Vite build in dist/.
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, session, shell, systemPreferences } from "electron";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerTools } from "./tools.js";
import { registerUpdater } from "./updater.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const devUrl = process.env.TOOLBOX_DEV_URL;

// A real origin for the UI (instead of file://) so module workers and wasm load normally.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

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

/** `name` in `folder`, or "name (2).ext" and so on when that's taken, so a Render never writes over an earlier file. */
async function freeName(folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let n = 1; ; n++) {
    const p = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    try {
      await access(p);
    } catch {
      return p;
    }
  }
}

ipcMain.handle("save-file", async (_e, name, bytes, folder) => {
  let target;
  if (folder) {
    await mkdir(folder, { recursive: true });
    target = await freeName(folder, path.basename(name));
  } else {
    const r = await dialog.showSaveDialog(win, { defaultPath: name });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await writeFile(target, bytes);
  return target;
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
