import "./style.css";
import { convert, type Grid } from "./engine/convert";
import { toAnsi, toHtml, toSvg, toText } from "./engine/export";
import { decodeSettings, defaultSettings, encodeSettings, FONTS, parseSettings, type Settings } from "./engine/settings";
import { builtInPresets } from "./presets";
import { inkIsDark, Renderer, type Layout } from "./render";
import { mountControls } from "./ui/controls";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const outCanvas = $<HTMLCanvasElement>("out");
const origCanvas = $<HTMLCanvasElement>("orig");
const sampleCanvas = document.createElement("canvas");
const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true })!;
const viewer = $<HTMLElement>("viewer");
const wrap = $<HTMLElement>("canvas-wrap");
const stats = $<HTMLElement>("stats");
const renderer = new Renderer();

const STORE_CURRENT = "ascii-lab:current";
const STORE_SAVED = "ascii-lab:presets";
const MAX_IMAGE = 4096;
const MAX_ROWS = 600;

// ---------------------------------------------------------------- state

type Source =
  | { kind: "image"; el: CanvasImageSource; w: number; h: number; name: string }
  | { kind: "video"; el: HTMLVideoElement; w: number; h: number; name: string; stream?: MediaStream };

let source: Source | null = null;
let settings: Settings = loadInitialSettings();
let zoom = 1;
let fit = true;
let comparing = false;
let paused = false;
let last: { grid: Grid; layout: Layout } | null = null;

// ---------------------------------------------------------------- render

/** Samples the source into a small grid, converts it to characters and draws them. */
function render() {
  if (!source || source.w < 1 || source.h < 1) return;
  const t0 = performance.now();
  const L = renderer.layout(settings);
  const grid = convertSource(settings, L);
  renderer.draw(outCanvas, grid, settings, L);
  last = { grid, layout: L };
  if (fit) applyZoom();
  if (comparing) drawOriginal();
  stats.textContent = `${grid.cols}×${grid.rows} chars · ${(performance.now() - t0).toFixed(0)} ms`;
  if (recorder) drawRecordFrame();
}

function convertSource(s: Settings, L: Layout): Grid {
  const src = source!;
  const cols = s.columns;
  // Characters are taller than they are wide, so fewer rows keep the picture's proportions.
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.round((cols * src.h * L.cellW) / (src.w * L.cellH))));
  const sx = s.mode === "braille" ? 2 : 1;
  const sy = s.mode === "braille" ? 4 : 1;
  const w = cols * sx;
  const h = rows * sy;
  if (sampleCanvas.width !== w || sampleCanvas.height !== h) {
    sampleCanvas.width = w;
    sampleCanvas.height = h;
  }
  sampleCtx.imageSmoothingEnabled = true;
  sampleCtx.imageSmoothingQuality = "high";
  sampleCtx.clearRect(0, 0, w, h);
  sampleCtx.drawImage(src.el, 0, 0, w, h);
  const img = sampleCtx.getImageData(0, 0, w, h);
  return convert(img.data, cols, rows, s, L.levels, inkIsDark(s));
}

let queued = false;
function requestRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    if (source?.kind === "image" || paused) render();
  });
}

function videoLoop() {
  if (source?.kind === "video" && !paused && source.el.readyState >= 2) render();
  requestAnimationFrame(videoLoop);
}
requestAnimationFrame(videoLoop);

// ---------------------------------------------------------------- settings + presets

function loadInitialSettings(): Settings {
  const hash = new URLSearchParams(location.hash.slice(1)).get("s");
  if (hash) {
    try {
      return decodeSettings(hash);
    } catch {
      /* fall through */
    }
  }
  try {
    const saved = localStorage.getItem(STORE_CURRENT);
    if (saved) return parseSettings(JSON.parse(saved));
  } catch {
    /* ignore */
  }
  return builtInPresets()[0];
}

let saveTimer = 0;
function onSettingsChange() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_CURRENT, JSON.stringify(settings));
    } catch {
      /* storage may be unavailable */
    }
  }, 300);
  requestRender();
}

const syncControls = mountControls($("controls"), () => settings, onSettingsChange);

function setSettings(s: Settings) {
  settings = s;
  syncControls();
  onSettingsChange();
}

function savedPresets(): Settings[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE_SAVED) ?? "[]") as unknown[]).map(parseSettings);
  } catch {
    return [];
  }
}

const menu = $<HTMLSelectElement>("preset-menu");
function buildMenu() {
  menu.replaceChildren();
  menu.append(new Option("Presets…", ""));
  const add = (label: string, items: Settings[], prefix: string) => {
    if (!items.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    items.forEach((p, i) => g.append(new Option(p.name, `${prefix}:${i}`)));
    menu.append(g);
  };
  add("Starters", builtInPresets(), "b");
  add("Saved", savedPresets(), "s");
  menu.append(new Option("Reset to defaults", "new"));
}
menu.addEventListener("change", () => {
  const v = menu.value;
  menu.value = "";
  if (!v) return;
  if (v === "new") return setSettings(defaultSettings());
  const [kind, i] = v.split(":");
  const p = (kind === "b" ? builtInPresets() : savedPresets())[Number(i)];
  if (p) setSettings(parseSettings(structuredClone(p)));
});

$("preset-save").addEventListener("click", () => {
  const name = prompt("Preset name", settings.name === "Untitled" ? "" : settings.name);
  if (!name) return;
  settings.name = name;
  const all = savedPresets().filter((p) => p.name !== name);
  all.push(structuredClone(settings));
  localStorage.setItem(STORE_SAVED, JSON.stringify(all));
  buildMenu();
  toast(`Saved “${name}”`);
});

$("preset-share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#s=${encodeSettings(settings)}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Link is in the address bar");
  }
});

$("preset-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  download(blob, `${slug(settings.name)}.ascii.json`);
});

const presetInput = $<HTMLInputElement>("file-preset");
$("preset-import").addEventListener("click", () => presetInput.click());
presetInput.addEventListener("change", () => {
  const f = presetInput.files?.[0];
  if (f) importPresetFile(f);
  presetInput.value = "";
});

async function importPresetFile(f: File) {
  try {
    setSettings(parseSettings(JSON.parse(await f.text())));
    toast(`Loaded “${settings.name}”`);
  } catch (err) {
    toast(String(err));
  }
}

// ---------------------------------------------------------------- sources

function stopVideo() {
  if (source?.kind === "video") {
    source.el.pause();
    source.stream?.getTracks().forEach((t) => t.stop());
    if (source.el.src.startsWith("blob:")) URL.revokeObjectURL(source.el.src);
  }
}

function setSource(s: Source) {
  stopVideo();
  source = s;
  paused = false;
  $("pause").hidden = s.kind !== "video";
  $("pause").textContent = "Pause";
  $("source-info").textContent = `${s.name} · ${s.w}×${s.h}`;
  fit = true;
  if (s.kind === "image") render();
}

async function loadImageFile(f: Blob, name: string) {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, MAX_IMAGE / Math.max(bmp.width, bmp.height));
    setSource({ kind: "image", el: bmp, w: Math.round(bmp.width * k), h: Math.round(bmp.height * k), name });
  } catch {
    toast("Couldn't read that image");
  }
}

function loadVideoFile(f: File) {
  const v = document.createElement("video");
  v.src = URL.createObjectURL(f);
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.addEventListener("loadedmetadata", () => {
    setSource({ kind: "video", el: v, w: v.videoWidth, h: v.videoHeight, name: f.name });
    v.play();
  }, { once: true });
  v.addEventListener("error", () => toast("Couldn't play that video"), { once: true });
}

async function startWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const v = document.createElement("video");
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play();
    setSource({ kind: "video", el: v, w: v.videoWidth, h: v.videoHeight, name: "Webcam", stream });
  } catch (err) {
    toast(`Webcam unavailable: ${(err as Error).message}`);
  }
}

/** A procedurally drawn test card, so the app is useful before you load anything. */
function sampleImage() {
  const w = 960, h = 640;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#1c2a6b");
  sky.addColorStop(0.55, "#f2795a");
  sky.addColorStop(1, "#ffd59a");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const sun = g.createRadialGradient(620, 300, 10, 620, 300, 170);
  sun.addColorStop(0, "#fff7d6");
  sun.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#ffe9b0";
  g.beginPath();
  g.arc(620, 300, 80, 0, Math.PI * 2);
  g.fill();
  ["#5b3a6e", "#3b2752", "#21163a"].forEach((col, i) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) {
      const y = 380 + i * 70 + Math.sin(x / (90 - i * 15) + i * 2) * (40 - i * 8) + Math.sin(x / 23 + i) * 6;
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.fill();
  });
  const ramp = g.createLinearGradient(40, 0, w - 40, 0);
  ramp.addColorStop(0, "#000");
  ramp.addColorStop(1, "#fff");
  g.fillStyle = ramp;
  g.fillRect(40, 40, w - 80, 40);
  g.fillStyle = "#fff";
  g.font = "bold 110px ui-monospace, Menlo, monospace";
  g.fillText("ASCII", 60, 230);
  setSource({ kind: "image", el: c, w, h, name: "Sample" });
}

const imageInput = $<HTMLInputElement>("file-image");
const videoInput = $<HTMLInputElement>("file-video");
$("open-image").addEventListener("click", () => imageInput.click());
$("open-video").addEventListener("click", () => videoInput.click());
$("open-webcam").addEventListener("click", startWebcam);
$("open-sample").addEventListener("click", sampleImage);
imageInput.addEventListener("change", () => {
  const f = imageInput.files?.[0];
  if (f) loadImageFile(f, f.name);
  imageInput.value = "";
});
videoInput.addEventListener("change", () => {
  const f = videoInput.files?.[0];
  if (f) loadVideoFile(f);
  videoInput.value = "";
});

function openFile(f: File) {
  if (f.type.startsWith("image/")) loadImageFile(f, f.name);
  else if (f.type.startsWith("video/")) loadVideoFile(f);
  else if (f.name.endsWith(".json")) importPresetFile(f);
  else toast("Unsupported file");
}

const drop = $<HTMLElement>("drop");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  drop.classList.add("show");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove("show"); }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove("show");
  openFile(e.dataTransfer.files[0]);
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) loadImageFile(f, "Pasted image");
});

$("pause").addEventListener("click", () => {
  if (source?.kind !== "video") return;
  paused = !paused;
  if (paused) source.el.pause();
  else source.el.play();
  $("pause").textContent = paused ? "Play" : "Pause";
});

// ---------------------------------------------------------------- viewer

function applyZoom() {
  if (fit && outCanvas.width > 1) {
    const r = viewer.getBoundingClientRect();
    zoom = Math.min(1, (r.width - 48) / outCanvas.width, (r.height - 96) / outCanvas.height);
  }
  for (const c of [outCanvas, origCanvas]) {
    c.style.width = `${outCanvas.width * zoom}px`;
    c.style.height = `${outCanvas.height * zoom}px`;
  }
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
}
new ResizeObserver(() => fit && applyZoom()).observe(viewer);

function zoomBy(f: number) {
  fit = false;
  const steps = [0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
  zoom = f > 1 ? steps.find((s) => s > zoom + 1e-6) ?? zoom : [...steps].reverse().find((s) => s < zoom - 1e-6) ?? zoom;
  applyZoom();
}
$("zoom-in").addEventListener("click", () => zoomBy(2));
$("zoom-out").addEventListener("click", () => zoomBy(0.5));
$("zoom-fit").addEventListener("click", () => { fit = true; applyZoom(); });
wrap.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 2 : 0.5);
}, { passive: false });

function drawOriginal() {
  if (!source) return;
  origCanvas.width = outCanvas.width;
  origCanvas.height = outCanvas.height;
  origCanvas.getContext("2d")!.drawImage(source.el, 0, 0, origCanvas.width, origCanvas.height);
}

function setCompare(on: boolean) {
  comparing = on;
  if (on) drawOriginal();
  outCanvas.hidden = on;
  origCanvas.hidden = !on;
  $("compare").classList.toggle("active", on);
}
$("compare").addEventListener("pointerdown", () => setCompare(true));
window.addEventListener("pointerup", () => comparing && setCompare(false));
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !isTyping(e)) {
    e.preventDefault();
    if (!comparing) setCompare(true);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && comparing) setCompare(false);
});

function isTyping(e: Event) {
  const t = e.target as HTMLElement;
  return t.tagName === "INPUT" && (t as HTMLInputElement).type === "text";
}

// ---------------------------------------------------------------- export

const fontFamily = () => FONTS.find((f) => f.id === settings.font)?.css ?? FONTS[0].css;
const fileBase = () => `${slug(baseName())}-${slug(settings.name)}`;

$("copy-text").addEventListener("click", async () => {
  if (!last) return toast("Nothing to copy yet");
  try {
    await navigator.clipboard.writeText(toText(last.grid, last.layout.glyphs));
    toast(`Copied ${last.grid.cols}×${last.grid.rows} characters`);
  } catch {
    toast("Clipboard unavailable; use Download → Text");
  }
});

const exportMenu = $<HTMLSelectElement>("export-menu");
exportMenu.addEventListener("change", () => {
  const v = exportMenu.value;
  exportMenu.value = "";
  if (!v) return;
  if (!last) return toast("Nothing to export yet");
  const { grid, layout } = last;
  const g = layout.glyphs;
  if (v === "txt") download(new Blob([toText(grid, g)], { type: "text/plain;charset=utf-8" }), `${fileBase()}.txt`);
  else if (v === "html") download(new Blob([toHtml(grid, g, settings, fontFamily())], { type: "text/html" }), `${fileBase()}.html`);
  else if (v === "ansi") download(new Blob([toAnsi(grid, g, settings)], { type: "text/plain;charset=utf-8" }), `${fileBase()}.ans`);
  else if (v === "svg") {
    const svg = toSvg(grid, g, settings, fontFamily(), layout.cellW, layout.cellH);
    download(new Blob([svg], { type: "image/svg+xml" }), `${fileBase()}.svg`);
  } else if (v.startsWith("png")) {
    // Re-render at the larger font size so text stays sharp instead of being upscaled.
    const scale = Number(v.slice(3));
    const c = document.createElement("canvas");
    const big = new Renderer();
    const L = big.layout(settings, scale);
    big.draw(c, { ...grid, codes: grid.codes }, settings, L);
    c.toBlob((b) => b && download(b, `${fileBase()}${scale > 1 ? `@${scale}x` : ""}.png`), "image/png");
  }
});

let recorder: MediaRecorder | null = null;
let recordCanvas: HTMLCanvasElement | null = null;
function drawRecordFrame() {
  if (!recordCanvas) return;
  const g = recordCanvas.getContext("2d")!;
  g.fillStyle = settings.bg === "transparent" ? "#000" : settings.bg;
  g.fillRect(0, 0, recordCanvas.width, recordCanvas.height);
  g.drawImage(outCanvas, 0, 0, recordCanvas.width, recordCanvas.height);
}

$("record").addEventListener("click", () => {
  const btn = $("record");
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!last) return toast("Nothing to record yet");
  recordCanvas = document.createElement("canvas");
  // Encoders want even dimensions.
  recordCanvas.width = outCanvas.width & ~1;
  recordCanvas.height = outCanvas.height & ~1;
  drawRecordFrame();
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(recordCanvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const mime = recorder?.mimeType ?? "video/webm";
    download(new Blob(chunks, { type: mime }), `${fileBase()}.${mime.includes("mp4") ? "mp4" : "webm"}`);
    recorder = null;
    recordCanvas = null;
    btn.classList.remove("recording");
    btn.textContent = "● Rec";
  };
  recorder.start();
  btn.classList.add("recording");
  btn.textContent = "■ Stop";
  if (source?.kind === "image") toast("Recording a still image; change settings to animate it");
});

// ---------------------------------------------------------------- helpers

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function baseName() {
  return (source?.name ?? "ascii").replace(/\.[^.]+$/, "");
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ascii";
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- boot

buildMenu();
// Web fonts and fallback glyphs may land after the first paint; redraw once they do.
document.fonts?.ready.then(() => requestRender());
sampleImage();
