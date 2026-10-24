import { ALGORITHMS, dither } from "./dither";
import { PaletteMatcher, extractPalette, type DistanceMode } from "./color";
import { adjust, boxBlur, edges, gradientMap, grain, posterize, unsharp } from "./filters";
import { PRESETS, hexToRgb } from "./palettes";

export type ParamValue = number | boolean | string | string[];

export type ParamDef =
  | { key: string; label: string; kind: "range"; min: number; max: number; step: number; default: number }
  | { key: string; label: string; kind: "toggle"; default: boolean }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string; group?: string }[]; default: string }
  | { key: string; label: string; kind: "colors"; default: string[] };

export interface StepContext {
  w: number;
  h: number;
  frame: number;
  /** Source pixels at working resolution, before any step ran (for palette extraction). */
  source: Uint8ClampedArray;
  /** Palette indices from the last dither step, if any (for vector export). */
  indices?: Uint8Array;
  palette?: string[];
}

export interface StepDef {
  type: string;
  label: string;
  description: string;
  params: ParamDef[];
  /** Whether a param is relevant given the current values (hides irrelevant controls). */
  visible?: (key: string, p: Record<string, ParamValue>) => boolean;
  run: (rgb: Float32Array, ctx: StepContext, p: Record<string, ParamValue>) => void;
}

const num = (v: ParamValue) => v as number;
const bool = (v: ParamValue) => v as boolean;
const str = (v: ParamValue) => v as string;
const list = (v: ParamValue) => v as string[];

const extractCache = new Map<string, string[]>();

/** Resolves a palette source ("preset", "custom" or "extract") to hex colors. */
export function resolvePalette(p: Record<string, ParamValue>, source?: Uint8ClampedArray): string[] {
  const kind = str(p.palette);
  if (kind === "custom") return list(p.colors);
  if (kind === "extract") {
    if (!source) return list(p.colors);
    const count = num(p.extractCount);
    // Cheap fingerprint so a still image doesn't re-run median cut on every tweak.
    let fp = `${count}:${source.length}`;
    for (let i = 0; i < source.length; i += Math.max(4, (source.length / 64) & ~3)) fp += "," + source[i];
    let hit = extractCache.get(fp);
    if (!hit) {
      hit = extractPalette(source, count).map(([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""));
      if (extractCache.size > 32) extractCache.clear();
      extractCache.set(fp, hit);
    }
    return hit;
  }
  return PRESETS.find((x) => x.id === kind)?.colors ?? PRESETS[0].colors;
}

const paletteOptions = [
  ...PRESETS.map((p) => ({ value: p.id, label: p.name, group: "Presets" })),
  { value: "custom", label: "Custom", group: "Other" },
  { value: "extract", label: "From image", group: "Other" },
];

export const STEP_DEFS: StepDef[] = [
  {
    type: "adjust",
    label: "Adjust",
    description: "Brightness, contrast, gamma and saturation.",
    params: [
      { key: "brightness", label: "Brightness", kind: "range", min: -100, max: 100, step: 1, default: 0 },
      { key: "contrast", label: "Contrast", kind: "range", min: -100, max: 100, step: 1, default: 0 },
      { key: "gamma", label: "Gamma", kind: "range", min: 0.2, max: 3, step: 0.01, default: 1 },
      { key: "saturation", label: "Saturation", kind: "range", min: 0, max: 2, step: 0.01, default: 1 },
      { key: "invert", label: "Invert", kind: "toggle", default: false },
    ],
    run: (rgb, _ctx, p) =>
      adjust(rgb, {
        brightness: num(p.brightness),
        contrast: num(p.contrast),
        gamma: num(p.gamma),
        saturation: num(p.saturation),
        invert: bool(p.invert),
      }),
  },
  {
    type: "blur",
    label: "Blur",
    description: "Soften detail before dithering.",
    params: [{ key: "radius", label: "Radius", kind: "range", min: 0, max: 12, step: 1, default: 1 }],
    run: (rgb, ctx, p) => { if (num(p.radius) > 0) boxBlur(rgb, ctx.w, ctx.h, num(p.radius)); },
  },
  {
    type: "sharpen",
    label: "Sharpen",
    description: "Unsharp mask to crisp up edges.",
    params: [{ key: "amount", label: "Amount", kind: "range", min: 0, max: 3, step: 0.05, default: 0.8 }],
    run: (rgb, ctx, p) => unsharp(rgb, ctx.w, ctx.h, num(p.amount)),
  },
  {
    type: "posterize",
    label: "Posterize",
    description: "Reduce each channel to a few levels.",
    params: [{ key: "levels", label: "Levels", kind: "range", min: 2, max: 16, step: 1, default: 4 }],
    run: (rgb, _ctx, p) => posterize(rgb, num(p.levels)),
  },
  {
    type: "grain",
    label: "Grain",
    description: "Add noise; animates on video.",
    params: [
      { key: "amount", label: "Amount", kind: "range", min: 0, max: 1, step: 0.01, default: 0.15 },
      { key: "mono", label: "Monochrome", kind: "toggle", default: true },
      { key: "animate", label: "Animate", kind: "toggle", default: true },
    ],
    run: (rgb, ctx, p) => grain(rgb, num(p.amount), bool(p.mono), bool(p.animate) ? ctx.frame + 1 : 1),
  },
  {
    type: "edges",
    label: "Edges",
    description: "Sobel outlines mixed over the image.",
    params: [
      { key: "strength", label: "Strength", kind: "range", min: 0.1, max: 4, step: 0.05, default: 1 },
      { key: "mix", label: "Mix", kind: "range", min: 0, max: 1, step: 0.01, default: 1 },
      { key: "invert", label: "Dark lines", kind: "toggle", default: true },
    ],
    run: (rgb, ctx, p) => edges(rgb, ctx.w, ctx.h, num(p.strength), num(p.mix), bool(p.invert)),
  },
  {
    type: "gradient",
    label: "Gradient map",
    description: "Map brightness onto a color ramp.",
    params: [
      { key: "colors", label: "Ramp", kind: "colors", default: ["#1b1035", "#e2466d", "#ffe9a8"] },
      { key: "mix", label: "Mix", kind: "range", min: 0, max: 1, step: 0.01, default: 1 },
    ],
    run: (rgb, _ctx, p) => gradientMap(rgb, list(p.colors).map(hexToRgb), num(p.mix)),
  },
  {
    type: "dither",
    label: "Dither",
    description: "Reduce to a palette with a dithering algorithm.",
    params: [
      {
        key: "algorithm",
        label: "Algorithm",
        kind: "select",
        options: ALGORITHMS.map((a) => ({ value: a.id, label: a.name, group: a.group })),
        default: "floyd-steinberg",
      },
      { key: "strength", label: "Strength", kind: "range", min: 0, max: 1.5, step: 0.01, default: 1 },
      { key: "serpentine", label: "Serpentine scan", kind: "toggle", default: true },
      { key: "cellSize", label: "Cell size", kind: "range", min: 2, max: 32, step: 1, default: 6 },
      { key: "angle", label: "Angle", kind: "range", min: 0, max: 90, step: 1, default: 45 },
      { key: "palette", label: "Palette", kind: "select", options: paletteOptions, default: "bw" },
      { key: "extractCount", label: "Colors", kind: "range", min: 2, max: 32, step: 1, default: 8 },
      { key: "colors", label: "Custom colors", kind: "colors", default: ["#000000", "#ffffff"] },
      {
        key: "distance",
        label: "Color match",
        kind: "select",
        options: [
          { value: "weighted", label: "Perceptual" },
          { value: "rgb", label: "RGB" },
          { value: "luma", label: "Brightness only" },
        ],
        default: "weighted",
      },
    ],
    visible: (key, p) => {
      const alg = str(p.algorithm);
      const isDiffusion = !ALGORITHMS.find((a) => a.id === alg && a.group !== "Error diffusion");
      if (key === "serpentine") return isDiffusion;
      if (key === "cellSize" || key === "angle") return alg.startsWith("halftone");
      if (key === "strength") return alg !== "threshold";
      if (key === "extractCount") return p.palette === "extract";
      if (key === "colors") return p.palette === "custom";
      return true;
    },
    run: (rgb, ctx, p) => {
      const palette = resolvePalette(p, ctx.source);
      const matcher = matcherFor(palette, str(p.distance) as DistanceMode);
      ctx.indices = dither(rgb, ctx.w, ctx.h, matcher, {
        algorithm: str(p.algorithm),
        strength: num(p.strength),
        serpentine: bool(p.serpentine),
        cellSize: num(p.cellSize),
        angle: num(p.angle),
        frame: ctx.frame,
      });
      ctx.palette = palette;
    },
  },
];

// Matchers hold a lookup cache, so reuse them between frames.
const matcherCache = new Map<string, PaletteMatcher>();
export function matcherFor(palette: string[], mode: DistanceMode): PaletteMatcher {
  const key = mode + ":" + palette.join(",");
  let m = matcherCache.get(key);
  if (!m) {
    if (matcherCache.size > 16) matcherCache.clear();
    m = new PaletteMatcher(palette.map(hexToRgb), mode);
    matcherCache.set(key, m);
  }
  return m;
}

export function stepDef(type: string): StepDef | undefined {
  return STEP_DEFS.find((d) => d.type === type);
}

export function defaultParams(type: string): Record<string, ParamValue> {
  const def = stepDef(type);
  const out: Record<string, ParamValue> = {};
  for (const p of def?.params ?? []) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
  return out;
}
