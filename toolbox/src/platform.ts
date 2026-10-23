// What the Electron preload script exposes. In a plain browser tab it's
// missing, and the functions below fall back to downloads and file pickers.

interface ToolboxBridge {
  saveFile(name: string, bytes: Uint8Array, folder?: string): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
  openGraph(): Promise<{ name: string; text: string } | null>;
  saveGraph(text: string, suggestedName: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  onMenu(handler: (command: string) => void): void;
}

export const bridge: ToolboxBridge | undefined = (window as unknown as { toolbox?: ToolboxBridge }).toolbox;

export const isDesktop = !!bridge;

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
