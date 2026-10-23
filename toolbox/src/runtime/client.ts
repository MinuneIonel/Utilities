import type { Graph } from "./types";
import type { FromWorker, NodeUpdate, ToWorker } from "./worker";
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

  constructor(private onUpdate: (u: NodeUpdate) => void) {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
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
    if (this.nextPreview) {
      const g = this.nextPreview;
      this.nextPreview = null;
      this.preview(g);
    }
  }
}
