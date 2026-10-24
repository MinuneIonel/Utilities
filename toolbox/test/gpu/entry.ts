// Compares the WebGPU renderers (Dither, resize, Lanczos) with the CPU ones and times both. Opened by
// run.mjs in Chromium (or Electron), which reads window.gpuCheck when done.
import { newStep, render, type Recipe } from "../../../dither/src/engine/recipe";
import { ALGORITHMS } from "../../../dither/src/engine/dither";
import { builtInRecipes } from "../../../dither/src/recipes";
import { ditherRecipe } from "../../src/nodes/dither";
import { gpu, setGpuEnabled, type Gpu } from "../../src/nodes/gpu";
import { scaleImage } from "../../src/nodes/image";
import { imageTransform } from "../../src/nodes/media";
import type { ImageValue, RunContext } from "../../src/runtime/types";

const log = document.getElementById("log")!;
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  log.textContent = lines.join("\n");
};

/** A test card: gradients, hard edges, a transparent corner and some noise. */
function card(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const o = (y * w + x) * 4;
      const cx = x / w - 0.5, cy = y / h - 0.5;
      const ring = Math.sin(Math.hypot(cx, cy) * 40) * 0.5 + 0.5;
      d[o] = (x / w) * 255;
      d[o + 1] = (y / h) * 255 * ring;
      d[o + 2] = x > w / 2 !== y > h / 2 ? 230 : 25 + ((s >>> 24) & 31);
      d[o + 3] = x < w / 8 && y < h / 8 ? 0 : 255;
    }
  }
  return d;
}

function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let diff = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a[i + c] - b[i + c]));
    if (m > 2) diff++;
    max = Math.max(max, m);
  }
  return { same: 1 - diff / (a.length / 4), max };
}

const recipe = (name: string, steps: Recipe["steps"], pixelSize = 1): Recipe => ({ version: 1, name, pixelSize, steps });

async function correctness(gpuAll: Gpu) {
  const g = gpuAll.dither;
  const w = 320, h = 200;
  const src = card(w, h);
  const cases: Recipe[] = [
    recipe("adjust", [newStep("adjust", { brightness: 10, contrast: 30, gamma: 1.2, saturation: 0.6, invert: true })]),
    recipe("blur", [newStep("blur", { radius: 3 })]),
    recipe("sharpen", [newStep("sharpen", { amount: 1.2 })]),
    recipe("posterize", [newStep("posterize", { levels: 5 })]),
    recipe("grain mono", [newStep("grain", { amount: 0.2, mono: true })]),
    recipe("grain colour", [newStep("grain", { amount: 0.2, mono: false })]),
    recipe("edges", [newStep("edges", { strength: 1.5, mix: 0.7 })]),
    recipe("gradient", [newStep("gradient", {})]),
    ...ALGORITHMS.filter((a) => a.group !== "Error diffusion").map((a) => recipe(a.id, [newStep("dither", { algorithm: a.id, palette: "pico8" })])),
    recipe("extract palette", [newStep("dither", { algorithm: "bayer8", palette: "extract", extractCount: 6 })]),
    recipe("luma match", [newStep("dither", { algorithm: "bayer4", palette: "gb", distance: "luma" })]),
    recipe("two dithers", [newStep("dither", { algorithm: "bayer4", palette: "pico8" }), newStep("adjust", { contrast: 20 }), newStep("dither", { algorithm: "halftone-line", palette: "bw" })]),
    recipe("diffusion hand-off", [newStep("adjust", { contrast: 20 }), newStep("blur", { radius: 1 }), newStep("dither", { algorithm: "floyd-steinberg", palette: "mac" }), newStep("posterize", {})]),
    ...builtInRecipes(),
  ];
  let ok = true;
  for (const r of cases) {
    const cpu = render(src, w, h, r).rgba;
    const out = await g.render(src, w, h, w, h, r);
    const c = compare(cpu, out.rgba);
    // Float maths differ a little between JS and the GPU, which moves the odd pixel across a threshold.
    // Error diffusion carries every such difference on to its neighbours, so after a hand-off more pixels move.
    const pass = c.same >= (out.gpuSteps < r.steps.filter((s) => s.enabled).length ? 0.9 : 0.99);
    ok &&= pass;
    say(`${pass ? "ok  " : "FAIL"} ${r.name.padEnd(22)} ${(c.same * 100).toFixed(2)}% within 2 levels, max diff ${c.max}, ${out.gpuSteps} GPU steps`);
  }
  // Resize: same picture as the canvas, within the slack of two different filters.
  const big = card(1280, 720);
  const canvas = scaleImage({ kind: "image", width: 1280, height: 720, data: big }, 320, 180, true).data;
  const mine = await g.resize(big, 1280, 720, 320, 180);
  let sum = 0;
  for (let i = 0; i < mine.length; i++) sum += Math.abs(mine[i] - canvas[i]);
  const mean = sum / mine.length;
  ok &&= mean < 4;
  say(`${mean < 4 ? "ok  " : "FAIL"} resize 1280→320          mean diff ${mean.toFixed(2)} levels from the canvas`);
  // Lanczos: the GPU filter against Media Lab's wasm one, down and up.
  const { transformImage } = await import("../../../media/src/engine/image");
  for (const [w2, h2] of [[480, 270], [2000, 1125]]) {
    const job = { rotate: 0, flipH: false, flipV: false, resize: { mode: "box", width: w2, height: h2, fit: "fill", upscale: true } } as unknown as Parameters<typeof transformImage>[1];
    const wasm = await transformImage({ width: 1280, height: 720, data: big }, job);
    const gpuOut = await gpuAll.lanczos.resize(big, 1280, 720, w2, h2);
    let s2 = 0;
    for (let i = 0; i < gpuOut.length; i++) s2 += Math.abs(gpuOut[i] - wasm.data[i]);
    const m2 = s2 / gpuOut.length;
    ok &&= m2 < 2 && wasm.width === w2;
    say(`${m2 < 2 ? "ok  " : "FAIL"} Lanczos 1280→${w2}         mean diff ${m2.toFixed(2)} levels from Media Lab's resizer`);
  }
  return ok;
}

const ctx = { mode: "render", assets: new Map() } as unknown as RunContext;

async function time(label: string, runs: number, f: () => Promise<unknown>) {
  await f(); // warm up: shader compile, buffers, palette tables
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await f();
  const ms = (performance.now() - t0) / runs;
  return { label, ms };
}

async function bench() {
  const W = 1920, H = 1080;
  const frame: ImageValue = { kind: "image", width: W, height: H, data: card(W, H) };
  const recipes = builtInRecipes();
  const rows: { label: string; cpu: number; gpu: number }[] = [];
  const both = async (label: string, f: () => Promise<unknown>) => {
    setGpuEnabled(false);
    const c = await time(label, 5, f);
    setGpuEnabled(true);
    const g = await time(label, 5, f);
    rows.push({ label, cpu: c.ms, gpu: g.ms });
    say(`${label.padEnd(34)} CPU ${c.ms.toFixed(1).padStart(7)} ms   GPU ${g.ms.toFixed(1).padStart(7)} ms   ${(c.ms / g.ms).toFixed(1)}×`);
  };
  for (const r of recipes) await both(`Dither "${r.name}" 1080p`, () => ditherRecipe.run({ image: frame }, { recipe: r, size: "source" }, ctx));
  const ordered = recipe("Bayer 8, 1 px", [newStep("adjust", { contrast: 10 }), newStep("dither", { algorithm: "bayer8", palette: "pico8" })], 1);
  await both(`Dither "Bayer 8, 1 px" 1080p`, () => ditherRecipe.run({ image: frame }, { recipe: ordered, size: "source" }, ctx));
  await both("Resize 1080p → 50% (Lanczos)", () => imageTransform.run({ image: frame }, { resize: "percent", percent: 50 }, ctx));
  return rows;
}

declare global {
  interface Window {
    gpuCheck?: { adapter: string; ok: boolean; bench?: { label: string; cpu: number; gpu: number }[]; error?: string };
  }
}

(async () => {
  try {
    const g = await gpu();
    if (!g) throw new Error("No WebGPU adapter");
    const info = (g.device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
    const adapter = info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : "unknown";
    say(`Adapter: ${adapter}\n`);
    const ok = await correctness(g);
    say("");
    const rows = new URLSearchParams(location.search).has("bench") ? await bench() : undefined;
    window.gpuCheck = { adapter, ok, bench: rows };
  } catch (e) {
    say(String((e as Error).stack ?? e));
    window.gpuCheck = { adapter: "", ok: false, error: String(e) };
  }
})();
