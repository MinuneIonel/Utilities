import "./style.css";
import { decodeRecipe, defaultRecipe, encodeRecipe, parseRecipe, type Recipe } from "./engine/recipe";
import { toSvg } from "./engine/export";
import { builtInRecipes } from "./recipes";
import { mountStack } from "./ui/stack";
import type { RenderRequest, RenderResponse } from "./worker";
import RenderWorker from "./worker?worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const outCanvas = $<HTMLCanvasElement>("out");
const workCanvas = $<HTMLCanvasElement>("work");
const outCtx = outCanvas.getContext("2d")!;
const workCtx = workCanvas.getContext("2d", { willReadFrequently: true })!;
const viewer = $<HTMLElement>("viewer");
const wrap = $<HTMLElement>("canvas-wrap");
const stats = $<HTMLElement>("stats");

const STORE_CURRENT = "dither-lab:current";
const STORE_SAVED = "dither-lab:recipes";
const MAX_IMAGE = 4096;
const MAX_VIDEO_WORK = 1280;

// ---------------------------------------------------------------- state

type Source =
  | { kind: "image"; el: CanvasImageSource; w: number; h: number; name: string }
  | { kind: "video"; el: HTMLVideoElement; w: number; h: number; name: string; stream?: MediaStream };

let source: Source | null = null;
let recipe: Recipe = loadInitialRecipe();
let zoom = 1;
let fit = true;
let comparing = false;
let paused = false;
let frame = 0;
let last: RenderResponse | null = null;

// ---------------------------------------------------------------- worker

const worker = new RenderWorker();
let busy = false;
let pending = false;
let reqId = 0;

worker.onmessage = (e: MessageEvent<RenderResponse>) => {
  busy = false;
  const res = e.data;
  if (res.error) {
    toast(res.error);
  } else {
    last = res;
    if (outCanvas.width !== res.w || outCanvas.height !== res.h) {
      outCanvas.width = res.w;
      outCanvas.height = res.h;
      applyZoom();
    }
    outCtx.putImageData(new ImageData(res.rgba as Uint8ClampedArray<ArrayBuffer>, res.w, res.h), 0, 0);
    stack.showPalette(res.palette);
    stats.textContent = `${res.w}×${res.h} · ${res.ms.toFixed(0)} ms`;
    if (recorder) drawRecordFrame();
  }
  if (pending && source?.kind === "image") {
    pending = false;
    requestRender();
  }
};

/** Renders the current source through the stack. Coalesces calls while the worker is busy. */
function requestRender() {
  if (!source) return;
  if (busy) {
    pending = true;
    return;
  }
  const { w, h } = workSize();
  if (workCanvas.width !== w || workCanvas.height !== h) {
    workCanvas.width = w;
    workCanvas.height = h;
  }
  workCtx.imageSmoothingEnabled = true;
  workCtx.imageSmoothingQuality = "high";
  workCtx.clearRect(0, 0, w, h);
  workCtx.drawImage(source.el, 0, 0, w, h);
  const img = workCtx.getImageData(0, 0, w, h);
  busy = true;
  const msg: RenderRequest = { id: ++reqId, rgba: img.data, w, h, recipe, frame: frame++ };
  worker.postMessage(msg, [img.data.buffer]);
}

function workSize() {
  if (!source) return { w: 1, h: 1 };
  const ps = recipe.pixelSize;
  const w = Math.max(1, Math.round(source.w / ps));
  const h = Math.max(1, Math.round(source.h / ps));
  const cap = source.kind === "video" ? MAX_VIDEO_WORK : MAX_IMAGE;
  const s = Math.min(1, cap / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// Video sources render continuously; the worker being busy naturally drops frames.
function videoLoop() {
  if (source?.kind === "video" && !paused && !busy && source.el.readyState >= 2) requestRender();
  requestAnimationFrame(videoLoop);
}
requestAnimationFrame(videoLoop);

// ---------------------------------------------------------------- recipe + stack

function loadInitialRecipe(): Recipe {
  const hash = new URLSearchParams(location.hash.slice(1)).get("r");
  if (hash) {
    try {
      return decodeRecipe(hash);
    } catch {
      /* fall through */
    }
  }
  try {
    const saved = localStorage.getItem(STORE_CURRENT);
    if (saved) return parseRecipe(JSON.parse(saved));
  } catch {
    /* ignore */
  }
  return builtInRecipes()[0];
}

let saveTimer = 0;
function onRecipeChange() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_CURRENT, JSON.stringify(recipe));
    } catch {
      /* storage may be unavailable */
    }
  }, 300);
  if (source?.kind === "image" || paused) requestRender();
}

const stack = mountStack($("stack"), $("add-step"), () => recipe, onRecipeChange);

const pixelSize = $<HTMLInputElement>("pixel-size");
const pixelOut = $<HTMLOutputElement>("pixel-size-out");
function syncGlobal() {
  pixelSize.value = String(recipe.pixelSize);
  pixelOut.textContent = `${recipe.pixelSize}px`;
}
pixelSize.addEventListener("input", () => {
  recipe.pixelSize = pixelSize.valueAsNumber;
  syncGlobal();
  onRecipeChange();
});

function setRecipe(r: Recipe) {
  recipe = r;
  syncGlobal();
  stack.refresh();
  onRecipeChange();
}

function savedRecipes(): Recipe[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE_SAVED) ?? "[]") as unknown[]).map(parseRecipe);
  } catch {
    return [];
  }
}

const menu = $<HTMLSelectElement>("recipe-menu");
function buildMenu() {
  menu.replaceChildren();
  const head = new Option("Recipes…", "");
  menu.append(head);
  const add = (label: string, items: Recipe[], prefix: string) => {
    if (!items.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    items.forEach((r, i) => g.append(new Option(r.name, `${prefix}:${i}`)));
    menu.append(g);
  };
  add("Starters", builtInRecipes(), "b");
  add("Saved", savedRecipes(), "s");
  menu.append(new Option("New empty stack", "new"));
}
menu.addEventListener("change", () => {
  const v = menu.value;
  menu.value = "";
  if (!v) return;
  if (v === "new") return setRecipe(defaultRecipe());
  const [kind, i] = v.split(":");
  const list = kind === "b" ? builtInRecipes() : savedRecipes();
  const r = list[Number(i)];
  if (r) setRecipe(parseRecipe(structuredClone(r)));
});

$("recipe-save").addEventListener("click", () => {
  const name = prompt("Recipe name", recipe.name === "Untitled" ? "" : recipe.name);
  if (!name) return;
  recipe.name = name;
  const all = savedRecipes().filter((r) => r.name !== name);
  all.push(structuredClone(recipe));
  localStorage.setItem(STORE_SAVED, JSON.stringify(all));
  buildMenu();
  toast(`Saved “${name}”`);
});

$("recipe-share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#r=${encodeRecipe(recipe)}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Link is in the address bar");
  }
});

$("recipe-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: "application/json" });
  download(blob, `${slug(recipe.name)}.dither.json`);
});

const recipeInput = $<HTMLInputElement>("file-recipe");
$("recipe-import").addEventListener("click", () => recipeInput.click());
recipeInput.addEventListener("change", () => {
  const f = recipeInput.files?.[0];
  if (f) importRecipeFile(f);
  recipeInput.value = "";
});

async function importRecipeFile(f: File) {
  try {
    setRecipe(parseRecipe(JSON.parse(await f.text())));
    toast(`Loaded “${recipe.name}”`);
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
  if (s.kind === "image") requestRender();
}

async function loadImageFile(f: Blob, name: string) {
  try {
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, MAX_IMAGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s);
    const h = Math.round(bmp.height * s);
    setSource({ kind: "image", el: bmp, w, h, name });
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
  const sun = g.createRadialGradient(620, 330, 10, 620, 330, 150);
  sun.addColorStop(0, "#fff7d6");
  sun.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#ffe9b0";
  g.beginPath();
  g.arc(620, 330, 70, 0, Math.PI * 2);
  g.fill();
  const layers = ["#5b3a6e", "#3b2752", "#21163a"];
  layers.forEach((col, i) => {
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
  g.fillRect(40, 40, w - 80, 36);
  const hues = g.createLinearGradient(40, 0, w - 40, 0);
  for (let i = 0; i <= 6; i++) hues.addColorStop(i / 6, `hsl(${i * 60},90%,55%)`);
  g.fillStyle = hues;
  g.fillRect(40, 84, w - 80, 24);
  g.fillStyle = "#fff";
  g.font = "bold 64px ui-monospace, Menlo, monospace";
  g.fillText("DITHER LAB", 48, 200);
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
  else if (f.name.endsWith(".json")) importRecipeFile(f);
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
    const avail = { w: r.width - 48, h: r.height - 96 };
    // Integer zoom keeps dither pixels crisp; go fractional only when shrinking.
    const z = Math.min(avail.w / outCanvas.width, avail.h / outCanvas.height);
    zoom = z >= 1 ? Math.floor(z) : z;
  }
  outCanvas.style.width = `${outCanvas.width * zoom}px`;
  outCanvas.style.height = `${outCanvas.height * zoom}px`;
  workCanvas.style.width = outCanvas.style.width;
  workCanvas.style.height = outCanvas.style.height;
  $("zoom-label").textContent = `${Math.round(zoom * 100)}%`;
}
new ResizeObserver(() => fit && applyZoom()).observe(viewer);

function zoomBy(f: number) {
  fit = false;
  const steps = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
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

function setCompare(on: boolean) {
  comparing = on;
  outCanvas.hidden = on;
  workCanvas.hidden = !on;
  $("compare").classList.toggle("active", on);
}
const compareBtn = $("compare");
compareBtn.addEventListener("pointerdown", () => setCompare(true));
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

function exportScale(): number {
  const v = ($("export-scale") as HTMLSelectElement).value;
  if (v === "src" && source) return Math.max(1, Math.round(source.w / outCanvas.width));
  return Math.max(1, Number(v) || 1);
}

function scaledCanvas(scale: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = outCanvas.width * scale;
  c.height = outCanvas.height * scale;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(outCanvas, 0, 0, c.width, c.height);
  return c;
}

$("export-png").addEventListener("click", () => {
  if (!last) return toast("Nothing to export yet");
  scaledCanvas(exportScale()).toBlob((b) => b && download(b, `${slug(baseName())}-${slug(recipe.name)}.png`), "image/png");
});

$("export-svg").addEventListener("click", () => {
  if (!last?.indices || !last.palette) return toast("SVG needs Dither as the last enabled step");
  const svg = toSvg(last.indices, last.w, last.h, last.palette, exportScale());
  download(new Blob([svg], { type: "image/svg+xml" }), `${slug(baseName())}-${slug(recipe.name)}.svg`);
});

let recorder: MediaRecorder | null = null;
let recordCanvas: HTMLCanvasElement | null = null;
function drawRecordFrame() {
  if (!recordCanvas) return;
  const g = recordCanvas.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(outCanvas, 0, 0, recordCanvas.width, recordCanvas.height);
}

$("record").addEventListener("click", () => {
  const btn = $("record");
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!last) return toast("Nothing to record yet");
  const scale = exportScale();
  recordCanvas = document.createElement("canvas");
  // Encoders want even dimensions.
  recordCanvas.width = (outCanvas.width * scale) & ~1;
  recordCanvas.height = (outCanvas.height * scale) & ~1;
  drawRecordFrame();
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks: Blob[] = [];
  recorder = new MediaRecorder(recordCanvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const mime = recorder?.mimeType ?? "video/webm";
    download(new Blob(chunks, { type: mime }), `${slug(baseName())}-${slug(recipe.name)}.${mime.includes("mp4") ? "mp4" : "webm"}`);
    recorder = null;
    recordCanvas = null;
    btn.classList.remove("recording");
    btn.textContent = "● Rec";
  };
  recorder.start();
  btn.classList.add("recording");
  btn.textContent = "■ Stop";
  if (source?.kind === "image") toast("Recording a still image; tweak the stack to animate it");
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
  return (source?.name ?? "dither").replace(/\.[^.]+$/, "");
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dither";
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

syncGlobal();
buildMenu();
sampleImage();
