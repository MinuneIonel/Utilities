// Exposes the few native abilities the UI needs, as window.toolbox (see src/platform.ts).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("toolbox", {
  saveFile: (name, bytes, folder) => ipcRenderer.invoke("save-file", name, bytes, folder),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openGraph: () => ipcRenderer.invoke("open-graph"),
  saveGraph: (text, suggestedName) => ipcRenderer.invoke("save-graph", text, suggestedName),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  onMenu: (handler) => ipcRenderer.on("menu", (_e, command) => handler(command)),
  toolsInfo: () => ipcRenderer.invoke("tools-info"),
  runTool: (id, tool, args, files) => ipcRenderer.invoke("tool-run", id, tool, args, files),
  cancelTool: (id) => ipcRenderer.invoke("tool-cancel", id),
  onToolProgress: (handler) => ipcRenderer.on("tool-progress", (_e, id, fraction, label) => handler(id, fraction, label)),
});
