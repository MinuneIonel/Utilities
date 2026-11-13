import { doneKey, type DoneFiles } from "../folder-input";
import { bridge } from "../platform";
import type { Bytes, Graph } from "./types";
import type { FromWorker, NodeUpdate, PlayMessage, ProgressUpdate, SavedFile, StripMessage, ToWorker } from "./worker";
import RuntimeWorker from "./worker?worker";

export interface RenderOutcome {
  /**
   * `key` identifies what the file was made from: the same key means the same file. `data` is in
   * memory or, in the desktop app, a path in the scratch folder; `size` is its length in bytes.
   */
  files: { nodeId: string; name: string; mime: string; data: Bytes; size: number; key?: string }[];
  error?: string;
  /** The files each folder node with "Only new files" worked on (see useRender). */
  folders?: { nodeId: string; done: DoneFiles }[];
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
  private nextPreview: { graph: Graph; scope: string } | null = null;
  private renders = new Map<number, { files: RenderOutcome["files"]; resolve: (r: RenderOutcome) => void }>();
  /**
   * Where a folder node's "Only new files" record is kept: by default its tab and node. The canvas
   * uses the graph's file once it has one, so the record follows the file.
   */
  doneKeyOf: (scope: string, nodeId: string) => string = doneKey;
  /** Gets what playback sends (see play). */
  onPlay?: (msg: PlayMessage) => void;
  /** Gets the timeline's pictures (see strip). */
  onStrip?: (msg: StripMessage) => void;

  constructor(
    private onUpdate: (u: NodeUpdate) => void,
    private onProgress: (p: ProgressUpdate) => void = () => {},
    /** A preview that failed as a whole (e.g. a graph file with a loop), not one node. */
    private onPreviewError: (error: string) => void = () => {},
  ) {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    // Native ffmpeg and yt-dlp, when running in the desktop app.
    if (bridge) {
      this.send({ type: "desktop" });
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

  /** The graph (tab) on screen. Previews are for it; node ids are only unique within one graph. */
  scope = "";

  preview(graph: Graph) {
    const scope = this.scope;
    if (this.previewBusy) {
      this.nextPreview = { graph, scope };
      return;
    }
    this.previewBusy = true;
    this.send({ type: "run", reqId: ++this.reqId, mode: "preview", graph, scope });
  }

  render(graph: Graph, scope = this.scope): Promise<RenderOutcome> {
    const reqId = ++this.reqId;
    return new Promise((resolve) => {
      this.renders.set(reqId, { files: [], resolve });
      this.send({ type: "run", reqId, mode: "render", graph, scope });
    });
  }

  /**
   * Plays a node's output from `at` (0–1 of the way through) and returns the playback's id, which
   * every message about it carries. Render stops it.
   */
  play(graph: Graph, nodeId: string, port: string, at: number, scope = this.scope): number {
    const reqId = ++this.reqId;
    this.send({ type: "play", reqId, graph, nodeId, port, at, scope });
    return reqId;
  }

  /**
   * Asks for what the timeline draws (see the strip message) and returns the request's id. A newer
   * request stops the one before.
   */
  strip(graph: Graph, source: { id: string; port: string }, base: { id: string; port: string }, whole: boolean, scope = this.scope): number {
    const reqId = ++this.reqId;
    this.send({ type: "strip", reqId, graph, scope, source, base, whole });
    return reqId;
  }

  stopPlay() {
    this.send({ type: "play-stop" });
  }

  /** The window drew a played frame: the worker may send another. */
  playDrawn(reqId: number) {
    this.send({ type: "play-ack", reqId });
  }

  /** The window cleared its pictures for a graph (or all): the next updates carry every node's picture again. */
  resendAll(scope?: string) {
    this.send({ type: "resend", scope });
  }

  /** A graph was closed: the worker drops its last renders. */
  forget(scope: string) {
    this.send({ type: "forget", scope });
  }

  /** Stops downloads a pasted link started; they stay stopped until Render or a new link. */
  stopDownloads() {
    this.send({ type: "stop-downloads" });
  }

  cancelRender() {
    this.send({ type: "cancel" });
  }

  /** Folder nodes look in their folders again on the next run (the window got focus back). */
  relist() {
    this.send({ type: "relist" });
  }

  /** Remembers files a folder node with "Only new files" did, so the next Render leaves them out. */
  async markDone(scope: string, nodeId: string, done: DoneFiles) {
    await bridge?.folderRunsAdd(this.doneKeyOf(scope, nodeId), done);
    this.relist();
  }

  /** "Forget what was done": every file in the folder counts as new again. */
  async forgetDone(scope: string, nodeId: string) {
    await bridge?.folderRunsClear(this.doneKeyOf(scope, nodeId));
    this.relist();
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
    if (msg.type === "strip-info" || msg.type === "strip-thumb" || msg.type === "strip-wave" || msg.type === "strip-end") {
      if (this.onStrip) this.onStrip(msg);
      else if (msg.type === "strip-thumb" || msg.type === "strip-wave") msg.bitmap.close();
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
    if (msg.type === "folder-list") {
      const { callId, query } = msg;
      const listing = !bridge
        ? Promise.reject(new Error("Folders work in the desktop app"))
        : Promise.all([
            bridge.listFolder({ folder: query.folder, kind: query.kind, pattern: query.pattern, recursive: query.recursive }),
            query.onlyNew ? bridge.folderRunsGet(this.doneKeyOf(msg.scope, msg.nodeId)) : undefined,
          ]).then(([r, done]) => ({ ...r, done }));
      listing
        .then((result) => this.send({ type: "folder-result", callId, result }))
        .catch((e: Error) => this.send({ type: "folder-result", callId, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
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
      r?.resolve({ files: r.files, error: msg.error, folders: msg.folders });
      return;
    }
    this.previewBusy = false;
    if (msg.error) this.onPreviewError(msg.error);
    if (this.nextPreview) {
      const { graph, scope } = this.nextPreview;
      this.nextPreview = null;
      this.previewBusy = true;
      this.send({ type: "run", reqId: ++this.reqId, mode: "preview", graph, scope });
    }
  }
}
