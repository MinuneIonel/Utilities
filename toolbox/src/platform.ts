// What the Electron preload script exposes. In a plain browser tab it's
// missing, and the functions below fall back to downloads and file pickers.

interface ToolboxBridge {
  saveFile(name: string, bytes: Uint8Array, folder?: string): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
  openGraph(): Promise<{ name: string; text: string } | null>;
  saveGraph(text: string, suggestedName: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  /** Runs an Edit menu command in the focused text field. */
  editText(command: string): Promise<void>;
  /** A newer Toolbox on GitHub, if there is one. */
  checkUpdate(): Promise<{ version: string; url: string } | null>;
  /** Where a dropped or chosen file is on disk, or "" if it isn't a file on disk. */
  pathForFile(file: File): string;
  onMenu(handler: (command: string) => void): void;
  toolsInfo(): Promise<ToolsInfo>;
  runTool(id: string, tool: NativeTool, args: string[], files: Record<string, ToolFile>): Promise<ToolResult>;
  /** Like runTool, but the process reads stdin from writeTool until endTool. */
  openTool(id: string, tool: NativeTool, args: string[], files: Record<string, ToolFile>): Promise<ToolResult>;
  writeTool(id: string, bytes: Uint8Array): Promise<void>;
  endTool(id: string): Promise<void>;
  cancelTool(id: string): Promise<void>;
  onToolProgress(handler: (id: string, fraction: number, label?: string) => void): void;
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
  files: Record<string, Uint8Array>;
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

/** Saves a file and returns where it went (a path on desktop, the name in a browser), or null if cancelled. */
export async function saveFile(name: string, mime: string, bytes: Uint8Array, folder?: string): Promise<string | null> {
  if (bridge) return bridge.saveFile(name, bytes, folder || undefined);
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), name);
  return name;
}

export async function saveGraphFile(text: string, suggestedName: string): Promise<string | null> {
  if (bridge) return bridge.saveGraph(text, suggestedName);
  download(new Blob([text], { type: "application/json" }), suggestedName);
  return suggestedName;
}

export function openGraphFile(): Promise<{ name: string; text: string } | null> {
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
