import "./style.css";
import { zipSync } from "fflate";
import {
  IMAGE_FORMATS,
  kindOf,
  planGeometry,
  probeVideo,
  processVideo,
  swapExt,
  VIDEO_CONTAINERS,
  type EncodedFile,
  type ImageFormat,
  type ImageJob,
  type ImageResult,
  type Kind,
  type Rect,
  type Resize,
  type Rotation,
  type VideoInfo,
  type VideoJob,
} from "./engine";
import type { ImageRequest } from "./image-worker";
import { CropBox } from "./ui/crop";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- settings

interface ResizeState {
  mode: Resize["mode"];
  percent: number;
  width: number;
  height: number;
  fit: "contain" | "cover" | "fill";
  long: number;
  upscale: boolean;
}

interface ImageSettings {
  resize: ResizeState;
  format: ImageFormat | "same";
  quality: number;
  lossless: boolean;
  maxKB: number;
  background: string;
  pngLevel: number;
}

interface VideoSettings {
  resize: ResizeState;
  container: VideoJob["container"];
  codec: VideoJob["codec"];
  rate: VideoJob["rate"]["mode"];
  level: "very-low" | "low" | "medium" | "high" | "very-high";
  mb: number;
  kbps: number;
  fps: number;
  audio: VideoJob["audio"];
  akbps: number;
}

interface Settings {
  image: ImageSettings;
  video: VideoSettings;
}

const defaultResize = (): ResizeState => ({ mode: "none", percent: 50, width: 0, height: 0, fit: "contain", long: 1920, upscale: false });

const DEFAULTS: Settings = {
  image: { resize: defaultResize(), format: "webp", quality: 80, lossless: false, maxKB: 0, background: "#ffffff", pngLevel: 2 },
  video: { resize: defaultResize(), container: "mp4", codec: "auto", rate: "quality", level: "medium", mb: 10, kbps: 2500, fps: 0, audio: "keep", akbps: 128 },
};

const STORE = "media-lab:settings";

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (s) {
      return {
        image: { ...DEFAULTS.image, ...s.image, resize: { ...defaultResize(), ...s.image?.resize } },
        video: { ...DEFAULTS.video, ...s.video, resize: { ...defaultResize(), ...s.video?.resize } },
      };
    }
  } catch {}
  return structuredClone(DEFAULTS);
}

let settings = loadSettings();
const saveSettings = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
};

// ---------------------------------------------------------------- items

type Status = "loading" | "ready" | "queued" | "working" | "done" | "error";

interface Result {
  blob: Blob;
  url: string;
  name: string;
  width: number;
  height: number;
  via: string;
  note?: string;
}

interface Item {
  id: number;
  file: File;
  kind: Kind;
  url: string;
  width: number;
  height: number;
  info?: VideoInfo;
  /** False when the browser can't show it (AVI, WMV…); a placeholder is shown instead. */
  previewable: boolean;
  isGif: boolean;
  crop?: Rect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  trim?: { start: number; end: number };
  status: Status;
  progress: number;
  label?: string;
  error?: string;
  result?: Result;
  abort?: AbortController;
}

const items: Item[] = [];
let selected: Item | null = null;
let nextId = 1;
let tab: Kind = "image";
let showing: "orig" | "result" = "orig";

// ---------------------------------------------------------------- formatting

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(t: number): string {
  if (!isFinite(t)) return "–";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function change(before: number, after: number): string {
  const pct = Math.round((after / before - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
}

/** Accepts "83.5", "1:23.5" or "0:01:23". */
function parseTime(s: string): number | null {
  s = s.trim();
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ---------------------------------------------------------------- jobs

function resizeOf(r: ResizeState): Resize {
  switch (r.mode) {
    case "percent":
      return { mode: "percent", percent: r.percent };
    case "box":
      return { mode: "box", width: r.width || undefined, height: r.height || undefined, fit: r.fit, upscale: r.upscale };
    case "long-edge":
      return { mode: "long-edge", size: r.long || 1, upscale: r.upscale };
    default:
      return { mode: "none" };
  }
}

function sameFormat(file: File): ImageFormat {
  const t = file.type;
  if (t === "image/jpeg") return "jpeg";
  if (t === "image/webp") return "webp";
  if (t === "image/avif") return "avif";
  if (t === "image/png" || t === "image/bmp" || t === "image/tiff" || t.includes("icon")) return "png";
  return "jpeg";
}

function imageJob(it: Item): ImageJob {
  const s = settings.image;
  return {
    crop: it.crop,
    rotate: it.rotate,
    flipH: it.flipH,
    flipV: it.flipV,
    resize: resizeOf(s.resize),
    format: s.format === "same" ? sameFormat(it.file) : s.format,
    quality: s.quality,
    lossless: s.lossless,
    maxBytes: s.maxKB > 0 ? s.maxKB * 1024 : undefined,
    background: s.background,
    pngLevel: s.pngLevel,
  };
}

function videoJob(it: Item): VideoJob {
  const s = settings.video;
  const rate: VideoJob["rate"] =
    s.rate === "size" ? { mode: "size", megabytes: s.mb }
    : s.rate === "bitrate" ? { mode: "bitrate", kbps: s.kbps }
    : s.rate === "copy" ? { mode: "copy" }
    : { mode: "quality", level: s.level };
  return {
    crop: it.crop,
    rotate: it.rotate,
    flipH: it.flipH,
    flipV: it.flipV,
    resize: resizeOf(s.resize),
    container: s.container,
    codec: s.codec,
    rate,
    fps: s.fps,
    trim: it.trim,
    audio: s.audio,
    audioKbps: s.akbps,
  };
}

function plannedSize(it: Item): { width: number; height: number } {
  if (it.kind === "image") return planGeometry(it.width, it.height, imageJob(it));
  return planGeometry(it.width, it.height, videoJob(it), settings.video.container !== "gif");
}

// ---------------------------------------------------------------- image workers

const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
const workers: { w: Worker; busy: boolean }[] = [];
const pending = new Map<number, { resolve: (r: ImageResult) => void; reject: (e: Error) => void }>();
const waiting: (() => void)[] = [];
let reqId = 1;

function getWorker(): Promise<{ w: Worker; busy: boolean }> {
  const free = workers.find((w) => !w.busy);
  if (free) return Promise.resolve(free);
  if (workers.length < POOL) {
    const w = new Worker(new URL("./image-worker.ts", import.meta.url), { type: "module" });
    const slot = { w, busy: false };
    w.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      pending.delete(id);
      slot.busy = false;
      waiting.shift()?.();
      if (!p) return;
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    workers.push(slot);
    return Promise.resolve(slot);
  }
  return new Promise((r) => waiting.push(() => getWorker().then(r)));
}

async function runImage(file: File, job: ImageJob): Promise<ImageResult> {
  const slot = await getWorker();
  slot.busy = true;
  const id = reqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.w.postMessage({ id, file, job } satisfies ImageRequest);
  });
}

// ---------------------------------------------------------------- conversion

let videoChain: Promise<unknown> = Promise.resolve();

function outName(it: Item, ext: string): string {
  const name = swapExt(it.file.name, ext);
  return name === it.file.name ? swapExt(it.file.name.replace(/(\.[^.]+)$/, "-edited$1"), ext) : name;
}

async function convert(it: Item) {
  if (it.status === "loading" || it.status === "working" || it.status === "queued") return;
  if (it.result) URL.revokeObjectURL(it.result.url);
  it.result = undefined;
  it.error = undefined;
  it.status = "queued";
  it.progress = 0;
  it.label = "Waiting";
  refresh(it);
  const start = performance.now();
  try {
    let out: EncodedFile;
    let note: string | undefined;
    if (it.kind === "image") {
      it.status = "working";
      it.label = "Encoding";
      it.progress = -1;
      refresh(it);
      const r = await runImage(it.file, imageJob(it));
      out = r;
      if (settings.image.maxKB > 0) note = r.fits ? `quality ${r.quality}` : `still over ${settings.image.maxKB} KB at the lowest quality`;
    } else {
      const job = videoJob(it);
      const ac = new AbortController();
      it.abort = ac;
      const run = videoChain.then(async () => {
        if (ac.signal.aborted) throw new DOMException("Canceled", "AbortError");
        it.status = "working";
        it.label = "Starting";
        refresh(it);
        return processVideo(it.file, it.info!, job, {
          signal: ac.signal,
          onProgress: (p) => {
            it.progress = p.fraction;
            if (p.label) it.label = p.label;
            refreshProgress(it);
          },
        });
      });
      videoChain = run.catch(() => undefined);
      out = await run;
    }
    const blob = new Blob([out.bytes as BlobPart], { type: out.mime });
    it.result = { blob, url: URL.createObjectURL(blob), name: outName(it, out.ext), width: out.width, height: out.height, via: out.via, note };
    it.status = "done";
    it.label = `${((performance.now() - start) / 1000).toFixed(1)} s`;
  } catch (e) {
    const canceled = e instanceof Error && (e.name === "AbortError" || e.name === "ConversionCanceledError");
    it.status = canceled ? "ready" : "error";
    it.error = canceled ? undefined : e instanceof Error ? e.message : String(e);
    if (!canceled) console.error(e);
  } finally {
    it.abort = undefined;
    refresh(it);
  }
}

function cancel(it: Item) {
  it.abort?.abort();
}

// ---------------------------------------------------------------- adding files

async function addFiles(files: Iterable<File>) {
  const added: Item[] = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) {
      toast(`Skipped ${file.name}: not an image or video`);
      continue;
    }
    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    const it: Item = {
      id: nextId++, file, kind, isGif, url: URL.createObjectURL(file), width: 0, height: 0,
      previewable: true, rotate: 0, flipH: false, flipV: false, status: "loading", progress: 0, label: "Reading",
    };
    items.push(it);
    added.push(it);
  }
  renderQueue();
  if (added.length && (!selected || selected.status === "error")) select(added[0]);
  else if (added.length) setTab(added[added.length - 1].kind);
  await Promise.all(added.map(load));
}

function loadImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("This browser can't open this image."));
    img.src = url;
  });
}

function canPlay(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    const done = (ok: boolean) => {
      v.removeAttribute("src");
      v.load();
      resolve(ok);
    };
    v.onloadedmetadata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    setTimeout(() => done(false), 8000);
    v.src = url;
  });
}

async function load(it: Item) {
  try {
    if (it.kind === "image" || it.isGif) {
      const { width, height } = await loadImageSize(it.url);
      it.width = width;
      it.height = height;
      if (it.isGif) it.info = { width, height, duration: 0, hasAudio: false, reader: "ffmpeg" };
    } else {
      const [info, playable] = await Promise.all([probeVideo(it.file), canPlay(it.url)]);
      it.info = info;
      it.width = info.width;
      it.height = info.height;
      it.previewable = playable;
    }
    it.status = "ready";
    it.label = undefined;
  } catch (e) {
    it.status = "error";
    it.error = e instanceof Error ? e.message : String(e);
  }
  refresh(it);
  if (it === selected) showItem();
}

function remove(it: Item) {
  cancel(it);
  URL.revokeObjectURL(it.url);
  if (it.result) URL.revokeObjectURL(it.result.url);
  items.splice(items.indexOf(it), 1);
  if (selected === it) select(items[0] ?? null);
  renderQueue();
}

// ---------------------------------------------------------------- viewer

const empty = $("empty");
const mediaWrap = $("media-wrap");
const media = $("media");
const cropLayer = $("crop-layer");
const crop = new CropBox(cropLayer, $("crop-box"));
const timeline = $("timeline");
const scrub = $<HTMLInputElement>("scrub");
const trimRange = $("trim-range");
const playBtn = $("play");
const timeLabel = $("time");
const info = $("info");
let video: HTMLVideoElement | null = null;

crop.onChange = (r) => {
  if (!selected) return;
  selected.crop = crop.isFull() ? undefined : r;
  syncCropInputs();
  updateInfo();
};

function select(it: Item | null) {
  selected = it;
  showing = "orig";
  if (it) setTab(it.kind);
  renderQueue();
  showItem();
}

function showItem() {
  const it = selected;
  media.replaceChildren();
  video = null;
  empty.hidden = !!it;
  mediaWrap.hidden = !it;
  timeline.hidden = true;
  $<HTMLButtonElement>("view-result").disabled = !it?.result;
  $("view-orig").classList.toggle("active", showing === "orig");
  $("view-result").classList.toggle("active", showing === "result");
  $<HTMLButtonElement>("convert-one").disabled = !it || it.status === "loading";
  if (!it) {
    info.textContent = "";
    return;
  }
  const res = showing === "result" ? it.result : undefined;
  cropLayer.hidden = !!res || it.status === "loading" || it.status === "error";

  const src = res ? res.url : it.url;
  const isImageLike = res ? res.blob.type.startsWith("image/") : it.kind === "image" || it.isGif;
  if (it.status === "loading") {
    media.append(placeholder(640, 360, "Reading…"));
  } else if (it.status === "error" && !res) {
    media.append(placeholder(640, 360, it.error ?? "Error"));
  } else if (isImageLike) {
    const img = document.createElement("img");
    img.src = src;
    img.draggable = false;
    media.append(img);
  } else if (res || it.previewable) {
    const v = document.createElement("video");
    v.src = src;
    v.playsInline = true;
    v.loop = true;
    v.preload = "auto";
    media.append(v);
    video = v;
    timeline.hidden = false;
    bindVideo(v, it, !!res);
  } else {
    media.append(placeholder(it.width, it.height, "No preview in this browser. It will still convert (with ffmpeg.wasm)."));
  }
  if (!cropLayer.hidden) crop.setSource(it.width, it.height, it.crop);
  syncItemControls();
  updateInfo();
}

function placeholder(w: number, h: number, text: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(2, w);
  c.height = Math.max(2, h);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#1f2024";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#8b8d93";
  ctx.font = `${Math.max(14, Math.round(c.width / 40))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2, c.width * 0.9);
  c.className = "placeholder";
  return c;
}

function bindVideo(v: HTMLVideoElement, it: Item, isResult: boolean) {
  const dur = () => (isFinite(v.duration) && v.duration > 0 ? v.duration : it.info?.duration || 0);
  const update = () => {
    const d = dur();
    scrub.value = d ? String(Math.round((v.currentTime / d) * 1000)) : "0";
    timeLabel.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    playBtn.textContent = v.paused ? "▶" : "❚❚";
    const t = !isResult && it.trim;
    trimRange.hidden = !t || !d;
    if (t && d) {
      trimRange.style.left = `${(t.start / d) * 100}%`;
      trimRange.style.width = `${((t.end - t.start) / d) * 100}%`;
    }
  };
  v.addEventListener("timeupdate", () => {
    // Loop inside the trim range while previewing.
    const t = !isResult && it.trim;
    if (t && !v.paused && (v.currentTime >= t.end || v.currentTime < t.start - 0.25)) v.currentTime = t.start;
    update();
  });
  v.addEventListener("loadedmetadata", update);
  v.addEventListener("play", update);
  v.addEventListener("pause", update);
  update();
}

playBtn.onclick = () => togglePlay();
function togglePlay() {
  if (!video) return;
  if (video.paused) {
    const t = showing === "orig" && selected?.trim;
    if (t && (video.currentTime < t.start || video.currentTime >= t.end)) video.currentTime = t.start;
    video.play().catch(() => undefined);
  } else video.pause();
}
scrub.oninput = () => {
  if (!video) return;
  const d = isFinite(video.duration) ? video.duration : selected?.info?.duration || 0;
  video.currentTime = (+scrub.value / 1000) * d;
};

function updateInfo() {
  const it = selected;
  if (!it || it.status === "loading") {
    info.textContent = "";
    return;
  }
  if (it.status === "error") {
    info.textContent = it.error ?? "";
    return;
  }
  let text = `${it.width}×${it.height} · ${fmtBytes(it.file.size)}`;
  if (it.result) {
    const r = it.result;
    text += `  →  ${r.width}×${r.height} · ${fmtBytes(r.blob.size)} (${change(it.file.size, r.blob.size)}) · ${r.via}`;
    if (r.note) text += ` · ${r.note}`;
  } else {
    const p = plannedSize(it);
    if (p.width !== it.width || p.height !== it.height) text += `  →  ${p.width}×${p.height}`;
  }
  info.textContent = text;
}

$("view-orig").onclick = () => {
  showing = "orig";
  showItem();
};
$("view-result").onclick = () => {
  if (!selected?.result) return;
  showing = "result";
  showItem();
};
$("convert-one").onclick = () => selected && convert(selected);

// ---------------------------------------------------------------- queue list

const list = $("queue-list");

function renderQueue() {
  list.replaceChildren(...items.map(row));
  const done = items.filter((i) => i.result);
  $<HTMLButtonElement>("convert-all").disabled = !items.some((i) => i.status === "ready" || i.status === "done" || i.status === "error");
  $<HTMLButtonElement>("download-all").disabled = done.length === 0;
  const before = done.reduce((s, i) => s + i.file.size, 0);
  const after = done.reduce((s, i) => s + i.result!.blob.size, 0);
  $("queue-stats").textContent = done.length
    ? `${done.length}/${items.length} done · ${fmtBytes(before)} → ${fmtBytes(after)}`
    : items.length ? `${items.length} file${items.length > 1 ? "s" : ""}` : "";
}

function row(it: Item): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `item ${it.status}${it === selected ? " selected" : ""}`;
  li.dataset.id = String(it.id);
  li.onclick = () => it !== selected && select(it);

  const top = document.createElement("div");
  top.className = "item-top";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = it.isGif ? "GIF" : it.kind === "image" ? "IMG" : "VID";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = it.file.name;
  name.title = it.file.name;
  top.append(badge, name);

  const actions = document.createElement("span");
  actions.className = "actions";
  const btn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "icon";
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    actions.append(b);
  };
  if (it.result) btn("⬇", "Download", () => download(it.result!.blob, it.result!.name));
  if (it.status === "working" || it.status === "queued") btn("■", "Cancel", () => cancel(it));
  btn("✕", "Remove", () => remove(it));
  top.append(actions);

  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = subline(it);

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("i");
  bar.append(fill);
  bar.hidden = !(it.status === "working" || it.status === "queued");
  setBar(bar, it.progress);

  li.append(top, sub, bar);
  return li;
}

function subline(it: Item): string {
  if (it.status === "error") return it.error ?? "Error";
  if (it.status === "loading") return "Reading…";
  const base = `${it.width}×${it.height} · ${fmtBytes(it.file.size)}`;
  if (it.status === "working" || it.status === "queued")
    return `${it.label ?? ""}${it.progress >= 0 && it.status === "working" ? ` · ${Math.round(it.progress * 100)}%` : ""}`;
  if (it.result) {
    return `${base} → ${fmtBytes(it.result.blob.size)} (${change(it.file.size, it.result.blob.size)}) · ${it.label ?? ""}`;
  }
  const extra = it.kind === "video" && it.info?.duration ? ` · ${fmtTime(it.info.duration)}` : "";
  return base + extra;
}

function setBar(bar: HTMLElement, p: number) {
  bar.classList.toggle("indeterminate", p < 0);
  (bar.firstChild as HTMLElement).style.width = p < 0 ? "30%" : `${Math.round(p * 100)}%`;
}

function refresh(it: Item) {
  const old = list.querySelector(`[data-id="${it.id}"]`);
  if (old) old.replaceWith(row(it));
  renderQueue();
  if (it === selected) {
    if (it.status === "done" && showing === "orig") {
      $<HTMLButtonElement>("view-result").disabled = false;
      updateInfo();
    } else if (it.status !== "working" && it.status !== "queued") showItem();
  }
}

function refreshProgress(it: Item) {
  const li = list.querySelector<HTMLElement>(`[data-id="${it.id}"]`);
  if (!li) return;
  setBar(li.querySelector(".bar")!, it.progress);
  li.querySelector(".item-sub")!.textContent = subline(it);
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$("convert-all").onclick = () => {
  for (const it of items) if (it.status === "ready" || it.status === "done" || it.status === "error") void convert(it);
};

$("download-all").onclick = async () => {
  const done = items.filter((i) => i.result);
  if (done.length === 1) return download(done[0].result!.blob, done[0].result!.name);
  const files: Record<string, Uint8Array> = {};
  for (const it of done) {
    let name = it.result!.name;
    for (let n = 2; files[name]; n++) name = it.result!.name.replace(/(\.[^.]+)$/, `-${n}$1`);
    files[name] = new Uint8Array(await it.result!.blob.arrayBuffer());
  }
  // Already-compressed media gains nothing from deflate, so store only.
  const zip = zipSync(files, { level: 0 });
  download(new Blob([zip as BlobPart], { type: "application/zip" }), "media-lab.zip");
};

$("clear").onclick = () => {
  for (const it of [...items]) remove(it);
};

// ---------------------------------------------------------------- panel

function setTab(k: Kind) {
  tab = k;
  $("tab-image").classList.toggle("active", k === "image");
  $("tab-video").classList.toggle("active", k === "video");
  syncPanel();
}
$("tab-image").onclick = () => setTab("image");
$("tab-video").onclick = () => setTab("video");

const cur = () => (tab === "image" ? settings.image : settings.video);

/** Binds an input to a settings field. */
function bind<T extends HTMLInputElement | HTMLSelectElement>(
  id: string,
  get: () => string | number | boolean,
  set: (v: string, el: T) => void,
) {
  const el = $<T>(id);
  const ev = el instanceof HTMLInputElement && el.type === "range" ? "input" : "change";
  el.addEventListener(ev, () => {
    set(el instanceof HTMLInputElement && el.type === "checkbox" ? String(el.checked) : el.value, el);
    saveSettings();
    syncPanel();
  });
  binders.push(() => {
    const v = get();
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
    else if (document.activeElement !== el) el.value = String(v);
  });
}
const binders: (() => void)[] = [];

const num = (v: string, fallback = 0) => (isFinite(+v) && v.trim() !== "" ? +v : fallback);

bind("resize-mode", () => cur().resize.mode, (v) => (cur().resize.mode = v as ResizeState["mode"]));
bind("resize-percent", () => cur().resize.percent, (v) => (cur().resize.percent = num(v, 50)));
bind("resize-w", () => cur().resize.width || "", (v) => (cur().resize.width = Math.round(num(v))));
bind("resize-h", () => cur().resize.height || "", (v) => (cur().resize.height = Math.round(num(v))));
bind("resize-fit", () => cur().resize.fit, (v) => (cur().resize.fit = v as ResizeState["fit"]));
bind("resize-long", () => cur().resize.long, (v) => (cur().resize.long = Math.round(num(v, 1920))));
bind("resize-long-preset", () => "", (v) => v && (cur().resize.long = +v));
bind("resize-up", () => cur().resize.upscale, (v) => (cur().resize.upscale = v === "true"));

bind("img-format", () => settings.image.format, (v) => (settings.image.format = v as ImageSettings["format"]));
bind("img-quality", () => settings.image.quality, (v) => (settings.image.quality = num(v, 80)));
bind("img-lossless", () => settings.image.lossless, (v) => (settings.image.lossless = v === "true"));
bind("img-max", () => settings.image.maxKB || "", (v) => (settings.image.maxKB = Math.max(0, num(v))));
bind("img-png", () => settings.image.pngLevel, (v) => (settings.image.pngLevel = num(v, 2)));
bind("img-bg", () => settings.image.background, (v) => (settings.image.background = v));

bind("vid-container", () => settings.video.container, (v) => (settings.video.container = v as VideoSettings["container"]));
bind("vid-codec", () => settings.video.codec, (v) => (settings.video.codec = v as VideoSettings["codec"]));
bind("vid-rate", () => settings.video.rate, (v) => (settings.video.rate = v as VideoSettings["rate"]));
bind("vid-level", () => settings.video.level, (v) => (settings.video.level = v as VideoSettings["level"]));
bind("vid-mb", () => settings.video.mb, (v) => (settings.video.mb = Math.max(0.1, num(v, 10))));
bind("vid-kbps", () => settings.video.kbps, (v) => (settings.video.kbps = Math.max(50, num(v, 2500))));
bind("vid-fps", () => settings.video.fps, (v) => (settings.video.fps = num(v)));
bind("vid-audio", () => settings.video.audio, (v) => (settings.video.audio = v as VideoSettings["audio"]));
bind("vid-akbps", () => settings.video.akbps, (v) => (settings.video.akbps = num(v, 128)));

function show(sel: string, on: boolean) {
  document.querySelectorAll<HTMLElement>(sel).forEach((el) => (el.hidden = !on));
}

function syncPanel() {
  binders.forEach((b) => b());
  const r = cur().resize;
  document.querySelectorAll<HTMLElement>("[data-resize]").forEach((el) => (el.hidden = !el.dataset.resize!.split(" ").includes(r.mode)));
  $("resize-percent-out").textContent = `${r.percent}%`;
  show("[data-kind=image]", tab === "image");
  show("[data-kind=video]", tab === "video");

  const im = settings.image;
  const fmt = im.format === "same" ? (selected?.kind === "image" ? sameFormat(selected.file) : "jpeg") : im.format;
  const meta = IMAGE_FORMATS[fmt];
  const losslessable = fmt === "webp" || fmt === "avif";
  show("[data-lossless]", losslessable);
  show("[data-lossy]", meta.lossy && !(losslessable && im.lossless));
  show("[data-png]", fmt === "png");
  show("[data-jpeg]", fmt === "jpeg");
  $("img-quality-out").textContent = String(im.quality);
  $("img-png-out").textContent = String(im.pngLevel);

  const vs = settings.video;
  const gif = vs.container === "gif";
  show("[data-notgif]", !gif);
  document.querySelectorAll<HTMLElement>("[data-rate]").forEach((el) => (el.hidden = gif || el.dataset.rate !== vs.rate));
  show("[data-audio]", !gif && vs.audio === "keep" && vs.rate !== "copy");
  $("vid-hint").textContent = gif
    ? "GIFs are made with ffmpeg.wasm (loads ~32 MB the first time). 15 fps and a width of 480–640 keep them small."
    : vs.rate === "copy"
      ? "Copies the video as it is (very fast) when only trimming or changing the container. Crop, rotate and resize still re-encode."
      : vs.rate === "size"
        ? "Picks the bitrate so the file lands near this size."
        : `Encoded with your browser's ${VIDEO_CONTAINERS[vs.container].label} encoder when it can, ffmpeg.wasm otherwise.`;

  syncItemControls();
  updateInfo();
}

// ---------------------------------------------------------------- per-file controls

const cropInputs = ["crop-x", "crop-y", "crop-w", "crop-h"].map((id) => $<HTMLInputElement>(id));

function syncCropInputs() {
  const it = selected;
  const r = it?.crop ?? (it ? { x: 0, y: 0, width: it.width, height: it.height } : null);
  const vals = r ? [r.x, r.y, r.width, r.height] : ["", "", "", ""];
  cropInputs.forEach((el, i) => {
    el.disabled = !it || it.status === "loading";
    if (document.activeElement !== el) el.value = String(vals[i]);
  });
}

cropInputs.forEach((el) =>
  el.addEventListener("change", () => {
    if (!selected) return;
    const [x, y, w, h] = cropInputs.map((e) => num(e.value));
    crop.set({ x, y, width: w || selected.width, height: h || selected.height }, true);
  }),
);

const aspectSel = $<HTMLSelectElement>("crop-aspect");
aspectSel.onchange = () => {
  const v = aspectSel.value;
  const a = v === "free" ? null : v === "source" ? (selected ? selected.width / selected.height : null) : +v;
  crop.applyAspect(a);
};

$("crop-reset").onclick = () => {
  if (!selected) return;
  aspectSel.value = "free";
  crop.aspect = null;
  crop.set({ x: 0, y: 0, width: selected.width, height: selected.height }, true);
};

$("crop-all").onclick = () => {
  const it = selected;
  if (!it) return;
  for (const o of items) {
    if (o === it || o.kind !== it.kind || !o.width) continue;
    if (!it.crop) o.crop = undefined;
    else {
      const sx = o.width / it.width;
      const sy = o.height / it.height;
      o.crop = { x: it.crop.x * sx, y: it.crop.y * sy, width: it.crop.width * sx, height: it.crop.height * sy };
    }
    o.rotate = it.rotate;
    o.flipH = it.flipH;
    o.flipV = it.flipV;
  }
  toast("Crop, rotation and flips copied to every " + (it.kind === "image" ? "image" : "video"));
};

function orient(fn: (it: Item) => void) {
  if (!selected) return;
  fn(selected);
  syncItemControls();
  updateInfo();
}
$("rot-left").onclick = () => orient((it) => (it.rotate = ((it.rotate + 270) % 360) as Rotation));
$("rot-right").onclick = () => orient((it) => (it.rotate = ((it.rotate + 90) % 360) as Rotation));
$("flip-h").onclick = () => orient((it) => (it.flipH = !it.flipH));
$("flip-v").onclick = () => orient((it) => (it.flipV = !it.flipV));

const trimStart = $<HTMLInputElement>("trim-start");
const trimEnd = $<HTMLInputElement>("trim-end");

function duration(it: Item): number {
  return it.info?.duration || (video && isFinite(video.duration) ? video.duration : 0);
}

function setTrim(it: Item, start: number, end: number) {
  const d = duration(it) || Infinity;
  start = Math.max(0, Math.min(start, d));
  end = Math.min(d, Math.max(end, start + 0.05));
  it.trim = start <= 0.001 && end >= d - 0.001 ? undefined : { start, end: isFinite(end) ? end : 24 * 3600 };
  syncItemControls();
  updateInfo();
  video?.dispatchEvent(new Event("timeupdate"));
}

trimStart.onchange = () => {
  if (!selected) return;
  const s = parseTime(trimStart.value) ?? 0;
  setTrim(selected, s, selected.trim?.end ?? duration(selected));
};
trimEnd.onchange = () => {
  if (!selected) return;
  const e = parseTime(trimEnd.value) ?? duration(selected);
  setTrim(selected, selected.trim?.start ?? 0, e || Infinity);
};
$("trim-in").onclick = () => selected && video && setTrim(selected, video.currentTime, selected.trim?.end ?? duration(selected));
$("trim-out").onclick = () => selected && video && setTrim(selected, selected.trim?.start ?? 0, video.currentTime);
$("trim-reset").onclick = () => {
  if (!selected) return;
  selected.trim = undefined;
  syncItemControls();
  updateInfo();
};

function syncItemControls() {
  const it = selected;
  syncCropInputs();
  const o: string[] = [];
  if (it?.rotate) o.push(`rotated ${it.rotate}° clockwise`);
  if (it?.flipH) o.push("mirrored");
  if (it?.flipV) o.push("flipped upside down");
  $("orient-label").textContent = o.length ? `Output will be ${o.join(", ")}.` : "";
  for (const id of ["rot-left", "rot-right", "flip-h", "flip-v", "crop-reset", "crop-all", "crop-aspect"]) $<HTMLButtonElement>(id).disabled = !it;
  $("flip-h").classList.toggle("active", !!it?.flipH);
  $("flip-v").classList.toggle("active", !!it?.flipV);

  const isVid = it?.kind === "video";
  for (const id of ["trim-start", "trim-end", "trim-in", "trim-out", "trim-reset"]) $<HTMLInputElement>(id).disabled = !isVid;
  $<HTMLButtonElement>("trim-in").disabled = $<HTMLButtonElement>("trim-out").disabled = !isVid || !video || showing !== "orig";
  if (document.activeElement !== trimStart) trimStart.value = isVid && it.trim ? fmtTime(it.trim.start) : "";
  if (document.activeElement !== trimEnd) trimEnd.value = isVid && it.trim ? fmtTime(Math.min(it.trim.end, duration(it) || it.trim.end)) : "";
  const d = isVid ? duration(it) : 0;
  $("trim-label").textContent = !isVid
    ? ""
    : it.trim
      ? `Keeping ${fmtTime(Math.min(it.trim.end, d || it.trim.end) - it.trim.start)} of ${fmtTime(d)}. Keys: I and O set start and end.`
      : d ? `Whole clip, ${fmtTime(d)}. Keys: I and O set start and end at the playhead.` : "";
}

// ---------------------------------------------------------------- input: drop, paste, keys

const fileInput = $<HTMLInputElement>("file-input");
$("add-files").onclick = () => fileInput.click();
$("empty-add").onclick = () => fileInput.click();
fileInput.onchange = () => {
  if (fileInput.files) void addFiles([...fileInput.files]);
  fileInput.value = "";
};

const drop = $("drop");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  drop.classList.add("show");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.classList.remove("show");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove("show");
  if (e.dataTransfer?.files.length) void addFiles([...e.dataTransfer.files]);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) void addFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}-${i}.${f.type.split("/")[1] ?? "png"}`, { type: f.type }))));
});

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("input, select, textarea")) return;
  if (e.key === " " && video) {
    e.preventDefault();
    togglePlay();
  } else if ((e.key === "i" || e.key === "I") && selected?.kind === "video" && video && showing === "orig") $("trim-in").click();
  else if ((e.key === "o" || e.key === "O") && selected?.kind === "video" && video && showing === "orig") $("trim-out").click();
  else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
    e.preventDefault();
    const i = selected ? items.indexOf(selected) : -1;
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (n && n !== selected) select(n);
  }
});

const toastEl = $("toast");
let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
}

setTab("image");
showItem();
renderQueue();

// Exposed for automated tests.
(window as unknown as { mediaLab: unknown }).mediaLab = { addFiles, items, convert, settings: () => settings };
