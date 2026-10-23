// Electron main process: one window, native menus, and the file access a
// browser tab doesn't have. The UI itself is the Vite build in dist/.
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
const devUrl = process.env.TOOLBOX_DEV_URL;

// A real origin for the UI (instead of file://) so module workers and wasm load normally.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Toolbox",
    backgroundColor: "#111214",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.loadURL(devUrl ?? "app://toolbox/index.html");
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
    { role: "editMenu" },
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("save-file", async (_e, name, bytes, folder) => {
  let target;
  if (folder) {
    await mkdir(folder, { recursive: true });
    target = path.join(folder, path.basename(name));
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

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
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
