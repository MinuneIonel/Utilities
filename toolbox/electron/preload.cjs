// Exposes the few native abilities the UI needs, as window.toolbox (see src/platform.ts).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("toolbox", {
  saveFile: (name, data, folder, opts) => ipcRenderer.invoke("save-file", name, data, folder, opts),
  scratchOpen: (id, name) => ipcRenderer.invoke("scratch-open", id, name),
  scratchWrite: (id, chunk, position) => ipcRenderer.invoke("scratch-write", id, chunk, position),
  scratchClose: (id) => ipcRenderer.invoke("scratch-close", id),
  scratchDelete: (paths) => ipcRenderer.invoke("scratch-delete", paths),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  defaultFolder: () => ipcRenderer.invoke("default-folder"),
  openGraph: () => ipcRenderer.invoke("open-graph"),
  saveGraph: (text, suggestedName) => ipcRenderer.invoke("save-graph", text, suggestedName),
  saveGraphTo: (p, text) => ipcRenderer.invoke("save-graph-to", p, text),
  /** Graph files opened from Open Recent or the system; the main process holds them until this is called. */
  onOpenFile: (handler) => {
    ipcRenderer.on("open-file", (_e, file) => handler(file));
    void ipcRenderer.invoke("open-file-ready");
  },
  ask: (message, detail, buttons) => ipcRenderer.invoke("ask", message, detail, buttons),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  editText: (command) => ipcRenderer.invoke("edit-text", command),
  checkUpdate: (strict) => ipcRenderer.invoke("check-update", strict),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  onUpdateProgress: (handler) => ipcRenderer.on("update-progress", (_e, fraction) => handler(fraction)),
  /** Where a dropped or chosen file is on disk ("" for files that aren't). */
  pathForFile: (file) => {
    let p = "";
    try {
      p = webUtils.getPathForFile(file);
    } catch {
      return "";
    }
    // Only a real drop or file dialog makes a File, so this is the person giving Toolbox the file.
    if (p) ipcRenderer.send("local-allow", p);
    return p;
  },
  adoptAutosave: (texts) => ipcRenderer.invoke("adopt-autosave", texts),
  onMenu: (handler) => ipcRenderer.on("menu", (_e, command) => handler(command)),
  toolsInfo: () => ipcRenderer.invoke("tools-info"),
  runTool: (id, tool, args, files, opts) => ipcRenderer.invoke("tool-run", id, tool, args, files, opts),
  openTool: (id, tool, args, files, opts) => ipcRenderer.invoke("tool-open", id, tool, args, files, opts),
  writeTool: (id, bytes) => ipcRenderer.invoke("tool-write", id, bytes),
  endTool: (id) => ipcRenderer.invoke("tool-end", id),
  cancelTool: (id) => ipcRenderer.invoke("tool-cancel", id),
  getModel: (id, file) => ipcRenderer.invoke("model-get", id, file),
  onToolProgress: (handler) => ipcRenderer.on("tool-progress", (_e, id, fraction, label) => handler(id, fraction, label)),
});
