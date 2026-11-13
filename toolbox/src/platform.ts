// What the Electron preload script exposes. In a plain browser tab it's
// missing, and the functions below fall back to downloads and file pickers.
import type { RunRequest, RunResult } from "./headless-plan";
import type { Bytes } from "./runtime/types";

interface ToolboxBridge {
  /** `{ fromPath }` copies a result from Toolbox's scratch folder instead of sending its bytes. */
  saveFile(name: string, data: Uint8Array | { fromPath: string }, folder?: string, opts?: SaveOptions): Promise<SaveResult | null>;
  /** Starts a file in the scratch folder, written chunk by chunk; resolves with its path. */
  scratchOpen(id: string, name: string): Promise<string>;
  /** Writes a chunk at `position`; chunks may come out of order. */
  scratchWrite(id: string, chunk: Uint8Array, position: number): Promise<void>;
  scratchClose(id: string): Promise<{ path: string; size: number }>;
  /** Deletes scratch files nothing holds any more (paths outside the scratch folder are ignored). */
  scratchDelete(paths: string[]): Promise<void>;
  chooseFolder(): Promise<string | null>;
  /** The system's Downloads folder, where Simple view saves until another is picked. */
  defaultFolder(): Promise<string>;
  /** A folder to read files from ("Folder of files"); choosing it lets the window list and read it. */
  chooseInputFolder(): Promise<string | null>;
  /** What's in a folder chosen with chooseInputFolder (or agreed to when a graph named it). */
  listFolder(req: FolderRequest): Promise<FolderListing>;
  /** The files a "Folder of files" node already did (path -> modified time), under its key. */
  folderRunsGet(key: string): Promise<Record<string, number>>;
  folderRunsAdd(key: string, done: Record<string, number>): Promise<void>;
  /** "Forget what was done". */
  folderRunsClear(key: string): Promise<void>;
  openGraph(): Promise<GraphFile | null>;
  /** Asks where to save; resolves with the path, or null if cancelled. */
  saveGraph(text: string, suggestedName: string): Promise<string | null>;
  /** Saves over a graph file opened or saved before, without asking. Rejects for any other path. */
  saveGraphTo(path: string, text: string): Promise<void>;
  /** Graph files opened from outside the window: Open Recent, a double-click in the Finder or Explorer. */
  onOpenFile(handler: (file: GraphFile) => void): void;
  /** A question in a system dialog; resolves with the index of the button pressed (the last one is Cancel). */
  ask(message: string, detail: string, buttons: string[]): Promise<number>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  /** Runs an Edit menu command in the focused text field. */
  editText(command: string): Promise<void>;
  /** A newer Toolbox on GitHub, if there is one. Offline it says there isn't, unless `strict`, which rejects. */
  checkUpdate(strict?: boolean): Promise<UpdateInfo | null>;
  /** Downloads the update found by checkUpdate and gets it ready; resolves with its version. */
  downloadUpdate(): Promise<string>;
  /** Quits, puts the downloaded update in place and opens Toolbox again. */
  installUpdate(): Promise<void>;
  /** Download progress, 0–1, or -1 while it's unpacked and checked. */
  onUpdateProgress(handler: (fraction: number) => void): void;
  /** Where a dropped or chosen file is on disk, or "" if it isn't a file on disk. */
  pathForFile(file: File): string;
  /** Lets the autosaved graphs' files come back on the first launch that checks which files may be read. */
  adoptAutosave(texts: string[]): Promise<void>;
  onMenu(handler: (command: string) => void): void;
  toolsInfo(): Promise<ToolsInfo>;
  /** With `keep`, the new files are moved into the scratch folder and come back as `{ path, size }`. */
  runTool(id: string, tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts?: { keep?: boolean }): Promise<ToolResult>;
  /** Like runTool, but the process reads stdin from writeTool until endTool. */
  openTool(id: string, tool: NativeTool, args: string[], files: Record<string, ToolFile>, opts?: { keep?: boolean }): Promise<ToolResult>;
  writeTool(id: string, bytes: Uint8Array): Promise<void>;
  endTool(id: string): Promise<void>;
  cancelTool(id: string): Promise<void>;
  /** A model file kept in Toolbox's folder, downloaded (with progress under `id`) the first time. */
  getModel(id: string, file: string): Promise<Uint8Array>;
  onToolProgress(handler: (id: string, fraction: number, label?: string) => void): void;
  /** A run from the command line (Toolbox --run): the hidden window gets the graph to run here. */
  onHeadlessRun?(handler: (req: RunRequest) => void): void;
  /** A progress line for the command line. */
  headlessLog(line: string): void;
  /** The run is over; the main process prints the result and exits. */
  headlessDone(result: RunResult): void;
}

/** A graph file's text, its file name, and (desktop app) where it is. */
export interface GraphFile {
  name: string;
  text: string;
  path?: string;
}

export interface UpdateInfo {
  version: string;
  /** The release page, for downloading by hand. */
  url: string;
  /** Whether this copy can update itself (not when it runs from the .dmg, say). */
  canInstall: boolean;
}

/** What a Save node does when its file is already in the folder. */
export type ExistsPolicy = "replace-own" | "number" | "skip";

export interface SaveOptions {
  exists?: ExistsPolicy;
  /** Files this Save node wrote before: the only ones it may replace. */
  own?: string[];
  /** A sub-folder of the folder to save in ("2024/beach"); it can't lead out of the folder. */
  sub?: string;
}

/** What a "Folder of files" node asks to list. */
export interface FolderRequest {
  folder: string;
  kind: string;
  pattern: string;
  recursive: boolean;
}

/** A folder's files, sorted by name; `name` is relative to the folder, with "/" between sub-folders. */
export interface FolderListing {
  entries: { path: string; name: string; size: number; mtimeMs: number }[];
  /** There were more files than a listing holds. */
  more: boolean;
  missing?: boolean;
  /** Toolbox wasn't given this folder. */
  refused?: boolean;
}

export interface SaveResult {
  /** Where the file is (a path on desktop, the name in a browser). */
  path: string;
  /** The file was already there and was left as it was ("Skip it"). */
  kept: boolean;
}

export type NativeTool = "ffmpeg" | "yt-dlp" | "sips";

/** A file for a tool's temp folder: its bytes, or where it already is on disk. */
export type ToolFile = Uint8Array | { path: string };

export interface ToolsInfo {
  ffmpeg: boolean;
  ytdlp: boolean;
  sips?: boolean;
  /** ffmpeg's encoders and hardware decoders, e.g. prores_videotoolbox and videotoolbox. */
  encoders?: string[];
  hwaccels?: string[];
}

export interface ToolResult {
  code: number;
  files: Record<string, Uint8Array | { path: string; size: number }>;
  log: string;
}

export const bridge: ToolboxBridge | undefined = (window as unknown as { toolbox?: ToolboxBridge }).toolbox;

export const isDesktop = !!bridge;

/** A file from an earlier session, read again from disk (desktop app only). */
export async function reopenFile(path: string, name: string): Promise<File | null> {
  if (!bridge || !path) return null;
  try {
    const res = await fetch(`app://toolbox/@local/${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], name || path.split(/[\\/]/).pop() || "file", { type: blob.type });
  } catch {
    return null; // moved or deleted since
  }
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * Saves a file and returns where it went, or null if cancelled. A result on disk (desktop app) is
 * copied there by the main process, so its bytes never pass through the window.
 */
export async function saveFile(name: string, mime: string, data: Bytes, folder?: string, opts?: SaveOptions): Promise<SaveResult | null> {
  if (bridge) return bridge.saveFile(name, data.in === "disk" ? { fromPath: data.path } : data.bytes, folder || undefined, opts);
  // A browser tab never makes files on disk.
  if (data.in === "disk") throw new Error("This file is on disk, which only the desktop app can save");
  download(new Blob([data.bytes as Uint8Array<ArrayBuffer>], { type: mime }), name);
  return { path: name, kept: false };
}

export async function saveGraphFile(text: string, suggestedName: string): Promise<string | null> {
  if (bridge) return bridge.saveGraph(text, suggestedName);
  download(new Blob([text], { type: "application/json" }), suggestedName);
  return suggestedName;
}

export function openGraphFile(): Promise<GraphFile | null> {
  if (bridge) return bridge.openGraph();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".toolbox,.json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}
