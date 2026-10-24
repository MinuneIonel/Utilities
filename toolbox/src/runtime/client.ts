import { bridge } from "../platform";
import type { Graph } from "./types";
import type { FromWorker, NodeUpdate, ProgressUpdate, ToWorker } from "./worker";
import RuntimeWorker from "./worker?worker";

export interface RenderOutcome {
  files: { nodeId: string; name: string; mime: string; bytes: Uint8Array }[];
  error?: string;
}

/**
 * The window's handle on the graph worker. Previews are coalesced so only
 * the newest graph is evaluated; renders queue behind them.
 */
export class RuntimeClient {
  private worker: Worker = new RuntimeWorker();
  private reqId = 0;
  private previewBusy = false;
  private nextPreview: Graph | null = null;
  private renders = new Map<number, { files: RenderOutcome["files"]; resolve: (r: RenderOutcome) => void }>();

  constructor(
    private onUpdate: (u: NodeUpdate) => void,
    private onProgress: (p: ProgressUpdate) => void = () => {},
    /** A preview that failed as a whole (e.g. a graph file with a loop), not one node. */
    private onPreviewError: (error: string) => void = () => {},
  ) {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    // Native ffmpeg and yt-dlp, when running in the desktop app.
    if (bridge) {
      bridge.onToolProgress((callId, fraction, label) => this.send({ type: "tool-progress", callId, fraction, label }));
      void bridge.toolsInfo().then((t) => this.send({ type: "tools", ...t }));
    }
  }

  /** True while no preview is running, so a webcam can send its next frame. */
  get previewIdle() {
    return !this.previewBusy;
  }

  camFrame(id: string, bitmap: ImageBitmap, t: number) {
    this.worker.postMessage({ type: "cam-frame", id, bitmap, t } satisfies ToWorker, [bitmap]);
  }

  /** Ends webcam recordings; the render then finishes writing its files. */
  stopRecording() {
    this.send({ type: "cam-stop" });
  }

  addAsset(id: string, blob: Blob) {
    this.send({ type: "asset", id, blob });
  }

  preview(graph: Graph) {
    if (this.previewBusy) {
      this.nextPreview = graph;
      return;
    }
    this.previewBusy = true;
    this.send({ type: "run", reqId: ++this.reqId, mode: "preview", graph });
  }

  render(graph: Graph): Promise<RenderOutcome> {
    const reqId = ++this.reqId;
    return new Promise((resolve) => {
      this.renders.set(reqId, { files: [], resolve });
      this.send({ type: "run", reqId, mode: "render", graph });
    });
  }

  cancelRender() {
    this.send({ type: "cancel" });
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  private handle(msg: FromWorker) {
    if (msg.type === "progress") {
      this.onProgress(msg);
      return;
    }
    if (msg.type === "tool-run") {
      const { callId } = msg;
      bridge
        ?.runTool(callId, msg.tool, msg.args, msg.files)
        .then((result) => this.send({ type: "tool-result", callId, result }))
        .catch((e: Error) => this.send({ type: "tool-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "tool-open") {
      const { callId } = msg;
      bridge
        ?.openTool(callId, msg.tool, msg.args, msg.files)
        .then((result) => this.send({ type: "tool-result", callId, result }))
        .catch((e: Error) => this.send({ type: "tool-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "tool-write") {
      const { callId, writeId } = msg;
      bridge
        ?.writeTool(callId, msg.bytes)
        .then(() => this.send({ type: "tool-written", writeId }))
        .catch((e: Error) => this.send({ type: "tool-written", writeId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "tool-end") {
      void bridge?.endTool(msg.callId);
      return;
    }
    if (msg.type === "tool-cancel") {
      void bridge?.cancelTool(msg.callId);
      return;
    }
    if (msg.type === "node") {
      const r = this.renders.get(msg.reqId);
      if (r && msg.file) r.files.push({ nodeId: msg.id, ...msg.file });
      this.onUpdate(msg);
      return;
    }
    if (msg.mode === "render") {
      const r = this.renders.get(msg.reqId);
      this.renders.delete(msg.reqId);
      r?.resolve({ files: r.files, error: msg.error });
      return;
    }
    this.previewBusy = false;
    if (msg.error) this.onPreviewError(msg.error);
    if (this.nextPreview) {
      const g = this.nextPreview;
      this.nextPreview = null;
      this.preview(g);
    }
  }
}
