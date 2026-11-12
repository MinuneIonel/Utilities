import { bridge } from "../platform";
import type { Bytes, Graph } from "./types";
import type { FromWorker, NodeUpdate, PlayMessage, ProgressUpdate, SavedFile, ToWorker } from "./worker";
import RuntimeWorker from "./worker?worker";

export interface RenderOutcome {
  /**
   * `key` identifies what the file was made from: the same key means the same file. `data` is in
   * memory or, in the desktop app, a path in the scratch folder; `size` is its length in bytes.
   */
  files: { nodeId: string; name: string; mime: string; data: Bytes; size: number; key?: string }[];
  error?: string;
}

const outcomeFile = (nodeId: string, f: SavedFile): RenderOutcome["files"][number] => ({
  nodeId,
  ...f,
  size: f.data.in === "memory" ? f.data.bytes.byteLength : f.data.size,
});

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
  /** Gets what playback sends (see play). */
  onPlay?: (msg: PlayMessage) => void;

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

  /** A camera's recording starts; with sound, its file follows through camAudio after Stop. */
  camRecording(id: string, sound: boolean) {
    this.send({ type: "cam-rec", id, sound });
  }

  camAudio(id: string, blob: Blob | undefined) {
    this.send({ type: "cam-audio", id, blob });
  }

  addAsset(id: string, blob: Blob, path?: string) {
    this.send({ type: "asset", id, blob, path });
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

  /**
   * Plays a node's output from `at` (0–1 of the way through) and returns the playback's id, which
   * every message about it carries. Render stops it.
   */
  play(graph: Graph, nodeId: string, port: string, at: number): number {
    const reqId = ++this.reqId;
    this.send({ type: "play", reqId, graph, nodeId, port, at });
    return reqId;
  }

  stopPlay() {
    this.send({ type: "play-stop" });
  }

  /** The window drew a played frame: the worker may send another. */
  playDrawn(reqId: number) {
    this.send({ type: "play-ack", reqId });
  }

  /** The window cleared its pictures: the next updates carry every node's picture again. */
  resendAll() {
    this.send({ type: "resend" });
  }

  /** Stops downloads a pasted link started; they stay stopped until Render or a new link. */
  stopDownloads() {
    this.send({ type: "stop-downloads" });
  }

  cancelRender() {
    this.send({ type: "cancel" });
  }

  private send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  private handle(msg: FromWorker) {
    if (msg.type === "play-info" || msg.type === "play-frame" || msg.type === "play-end") {
      if (this.onPlay) this.onPlay(msg);
      else if (msg.type === "play-frame") msg.bitmap.close();
      return;
    }
    if (msg.type === "progress") {
      this.onProgress(msg);
      return;
    }
    if (msg.type === "tool-run") {
      const { callId } = msg;
      bridge
        ?.runTool(callId, msg.tool, msg.args, msg.files, { keep: msg.keep })
        .then((result) => this.send({ type: "tool-result", callId, result }))
        .catch((e: Error) => this.send({ type: "tool-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "tool-open") {
      const { callId } = msg;
      bridge
        ?.openTool(callId, msg.tool, msg.args, msg.files, { keep: msg.keep })
        .then((result) => this.send({ type: "tool-result", callId, result }))
        .catch((e: Error) => this.send({ type: "tool-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "model-get") {
      const { callId, file } = msg;
      bridge
        ?.getModel(callId, file)
        .then((bytes) => this.worker.postMessage({ type: "tool-result", callId, result: { code: 0, files: { [file]: bytes }, log: "" } } satisfies ToWorker, [bytes.buffer]))
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
    if (msg.type === "scratch-free") {
      void bridge?.scratchDelete(msg.paths).catch(() => undefined);
      return;
    }
    if (msg.type === "scratch-call") {
      const { callId } = msg;
      const call =
        !bridge ? Promise.reject(new Error("Only the desktop app keeps files on disk"))
        : msg.op === "open" ? bridge.scratchOpen(msg.id, msg.name)
        : msg.op === "write" ? bridge.scratchWrite(msg.id, msg.chunk, msg.position)
        : bridge.scratchClose(msg.id);
      call
        .then((result: unknown) => this.send({ type: "scratch-result", callId, result }))
        .catch((e: Error) => this.send({ type: "scratch-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
      return;
    }
    if (msg.type === "node") {
      const r = this.renders.get(msg.reqId);
      if (r && msg.file) r.files.push(outcomeFile(msg.id, msg.file));
      if (r && msg.files) for (const f of msg.files) r.files.push(outcomeFile(msg.id, f));
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
