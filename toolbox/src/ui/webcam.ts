// The window's side of Webcam nodes: cameras only exist here, so frames are
// captured in the window and posted to the graph worker.
import type { Graph } from "../runtime/types";
import type { RuntimeClient } from "../runtime/client";

export interface CamSpec {
  id: string;
  width: number;
  height: number;
  mirror: boolean;
  /** Record the microphone too. */
  sound: boolean;
}

interface Cam {
  spec: CamSpec;
  stream?: MediaStream;
  video: HTMLVideoElement;
  last: number;
  stopped: boolean;
  recorder?: MediaRecorder;
}

/** Live preview runs at most this often per camera. */
const PREVIEW_INTERVAL = 66;

export class Webcams {
  private cams = new Map<string, Cam>();
  /** While recording, every frame goes to the worker at full size. */
  private recording = false;

  constructor(
    private client: RuntimeClient,
    private graph: () => Graph,
    private onError: (id: string, message: string) => void,
  ) {}

  /** Opens cameras for new Webcam nodes and closes the ones whose nodes are gone. */
  sync(specs: CamSpec[]) {
    const want = new Map(specs.map((s) => [s.id, s]));
    for (const [id, cam] of this.cams) {
      const s = want.get(id);
      if (!s || s.width !== cam.spec.width || s.height !== cam.spec.height || s.sound !== cam.spec.sound) this.close(id);
      else cam.spec = s;
    }
    for (const s of specs) if (!this.cams.has(s.id)) this.open(s);
  }

  private open(spec: CamSpec) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const cam: Cam = { spec, video, last: 0, stopped: false };
    this.cams.set(spec.id, cam);
    const videoSize = { width: { ideal: spec.width }, height: { ideal: spec.height } };
    // No microphone (or it was refused) still leaves the camera working, just silent.
    const media = navigator.mediaDevices;
    (spec.sound ? media.getUserMedia({ video: videoSize, audio: true }).catch(() => media.getUserMedia({ video: videoSize })) : media.getUserMedia({ video: videoSize }))
      .then(async (stream) => {
        if (cam.stopped) return stream.getTracks().forEach((t) => t.stop());
        cam.stream = stream;
        video.srcObject = stream;
        await video.play();
        this.loop(cam);
      })
      .catch((e: Error) => this.onError(spec.id, e.name === "NotAllowedError" ? "Camera access was refused" : `No camera: ${e.message}`));
  }

  private loop(cam: Cam) {
    const tick = () => {
      if (cam.stopped) return;
      const now = performance.now();
      const due = this.recording || (this.client.previewIdle && now - cam.last >= PREVIEW_INTERVAL);
      if (due && cam.video.videoWidth) {
        cam.last = now;
        const { videoWidth: w, videoHeight: h } = cam.video;
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext("2d")!;
        if (cam.spec.mirror) {
          g.translate(w, 0);
          g.scale(-1, 1);
        }
        g.drawImage(cam.video, 0, 0, w, h);
        this.client.camFrame(cam.spec.id, c.transferToImageBitmap(), now / 1000);
        if (!this.recording) this.client.preview(this.graph());
      }
      cam.video.requestVideoFrameCallback(tick);
    };
    cam.video.requestVideoFrameCallback(tick);
  }

  /** Render pressed: every frame goes to the worker, and cameras with a microphone record it. */
  startRecording() {
    this.recording = true;
    for (const cam of this.cams.values()) {
      const tracks = cam.stream?.getAudioTracks() ?? [];
      const id = cam.spec.id;
      let rec: MediaRecorder | undefined;
      try {
        if (tracks.length && typeof MediaRecorder !== "undefined") rec = new MediaRecorder(new MediaStream(tracks));
      } catch {
        /* this system can't record sound: the video is still recorded */
      }
      this.client.camRecording(id, !!rec);
      if (!rec) continue;
      const chunks: Blob[] = [];
      const r = rec;
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => this.client.camAudio(id, chunks.length ? new Blob(chunks, { type: r.mimeType || "audio/webm" }) : undefined);
      r.start(1000);
      cam.recorder = r;
    }
  }

  /** Stop pressed (or the render ended): the sound files follow the last frames. */
  stopRecording() {
    this.recording = false;
    for (const cam of this.cams.values()) {
      if (cam.recorder?.state === "recording") cam.recorder.stop();
      cam.recorder = undefined;
    }
  }

  private close(id: string) {
    const cam = this.cams.get(id);
    if (!cam) return;
    cam.stopped = true;
    if (cam.recorder?.state === "recording") cam.recorder.stop();
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.video.srcObject = null;
    this.cams.delete(id);
  }

  closeAll() {
    for (const id of [...this.cams.keys()]) this.close(id);
  }
}
