import { blueNoise, BLUE_NOISE_SIZE } from "./bluenoise";
import { PaletteMatcher } from "./color";

/** [dx, dy, weight] triples; weights are divided by the kernel's divisor. */
type Kernel = { divisor: number; taps: [number, number, number][] };

export const DIFFUSION_KERNELS: Record<string, Kernel> = {
  "floyd-steinberg": { divisor: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
  "false-floyd-steinberg": { divisor: 8, taps: [[1, 0, 3], [0, 1, 3], [1, 1, 2]] },
  atkinson: { divisor: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  "jarvis-judice-ninke": {
    divisor: 48,
    taps: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
  },
  stucki: {
    divisor: 42,
    taps: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
    ],
  },
  burkes: {
    divisor: 32,
    taps: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
  },
  sierra: {
    divisor: 32,
    taps: [
      [1, 0, 5], [2, 0, 3],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
      [-1, 2, 2], [0, 2, 3], [1, 2, 2],
    ],
  },
  "sierra-two-row": {
    divisor: 16,
    taps: [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]],
  },
  "sierra-lite": { divisor: 4, taps: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]] },
};

export type OrderedKind =
  | "bayer2" | "bayer4" | "bayer8" | "bayer16" | "blue-noise" | "white-noise"
  | "halftone-dot" | "halftone-line" | "halftone-square" | "halftone-diamond" | "threshold";

export const ALGORITHMS: { id: string; name: string; group: string }[] = [
  { id: "floyd-steinberg", name: "Floyd–Steinberg", group: "Error diffusion" },
  { id: "false-floyd-steinberg", name: "False Floyd–Steinberg", group: "Error diffusion" },
  { id: "atkinson", name: "Atkinson", group: "Error diffusion" },
  { id: "jarvis-judice-ninke", name: "Jarvis–Judice–Ninke", group: "Error diffusion" },
  { id: "stucki", name: "Stucki", group: "Error diffusion" },
  { id: "burkes", name: "Burkes", group: "Error diffusion" },
  { id: "sierra", name: "Sierra", group: "Error diffusion" },
  { id: "sierra-two-row", name: "Sierra two-row", group: "Error diffusion" },
  { id: "sierra-lite", name: "Sierra Lite", group: "Error diffusion" },
  { id: "bayer2", name: "Bayer 2×2", group: "Ordered" },
  { id: "bayer4", name: "Bayer 4×4", group: "Ordered" },
  { id: "bayer8", name: "Bayer 8×8", group: "Ordered" },
  { id: "bayer16", name: "Bayer 16×16", group: "Ordered" },
  { id: "blue-noise", name: "Blue noise", group: "Ordered" },
  { id: "white-noise", name: "White noise", group: "Ordered" },
  { id: "halftone-dot", name: "Halftone dots", group: "Halftone" },
  { id: "halftone-line", name: "Halftone lines", group: "Halftone" },
  { id: "halftone-square", name: "Halftone squares", group: "Halftone" },
  { id: "halftone-diamond", name: "Halftone diamonds", group: "Halftone" },
  { id: "threshold", name: "Threshold (no dither)", group: "Other" },
];

export interface DitherOptions {
  algorithm: string;
  strength: number; // 0..1.5, error / spread multiplier
  serpentine: boolean;
  cellSize: number; // halftone cell in pixels
  angle: number; // halftone angle in degrees
  frame: number; // varies white noise between video frames
}

/**
 * Dithers a float RGB buffer in place to the matcher's palette.
 * Also returns the palette index of every pixel (for vector export).
 */
export function dither(
  rgb: Float32Array,
  w: number,
  h: number,
  matcher: PaletteMatcher,
  opt: DitherOptions,
): Uint8Array {
  const kernel = DIFFUSION_KERNELS[opt.algorithm];
  return kernel
    ? diffuse(rgb, w, h, matcher, kernel, opt)
    : ordered(rgb, w, h, matcher, opt.algorithm as OrderedKind, opt);
}

function diffuse(
  rgb: Float32Array,
  w: number,
  h: number,
  matcher: PaletteMatcher,
  kernel: Kernel,
  opt: DitherOptions,
): Uint8Array {
  const out = new Uint8Array(w * h);
  const pal = matcher.colors;
  const taps = kernel.taps.map(([dx, dy, wt]) => [dx, dy, (wt / kernel.divisor) * opt.strength]);
  for (let y = 0; y < h; y++) {
    const rev = opt.serpentine && (y & 1) === 1;
    for (let i = 0; i < w; i++) {
      const x = rev ? w - 1 - i : i;
      const p = y * w + x;
      const o = p * 3;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      const idx = matcher.nearest(r, g, b);
      out[p] = idx;
      const c = pal[idx];
      const er = r - c[0], eg = g - c[1], eb = b - c[2];
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
      for (const [dx0, dy, f] of taps) {
        const dx = rev ? -dx0 : dx0;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const no = (ny * w + nx) * 3;
        rgb[no] += er * f;
        rgb[no + 1] += eg * f;
        rgb[no + 2] += eb * f;
      }
    }
  }
  return out;
}

function bayer(n: number): Float32Array {
  let m = [[0]];
  for (let size = 1; size < n; size *= 2) {
    const next: number[][] = [];
    for (let y = 0; y < size * 2; y++) {
      next.push([]);
      for (let x = 0; x < size * 2; x++) {
        const q = (y < size ? 0 : 2) + (x < size ? 0 : 1);
        const base = 4 * m[y % size][x % size];
        next[y].push(base + [0, 2, 3, 1][q]);
      }
    }
    m = next;
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = (m[y][x] + 0.5) / (n * n);
  return out;
}

const bayerCache = new Map<number, Float32Array>();
function bayerMap(n: number): Float32Array {
  let m = bayerCache.get(n);
  if (!m) { m = bayer(n); bayerCache.set(n, m); }
  return m;
}

/** Threshold in [0, 1) for a pixel; GLSL ports mirror this function. */
function thresholdFn(kind: OrderedKind, opt: DitherOptions): (x: number, y: number) => number {
  switch (kind) {
    case "bayer2": case "bayer4": case "bayer8": case "bayer16": {
      const n = parseInt(kind.slice(5), 10);
      const m = bayerMap(n);
      return (x, y) => m[(y % n) * n + (x % n)];
    }
    case "blue-noise": {
      const m = blueNoise();
      const n = BLUE_NOISE_SIZE;
      return (x, y) => m[(y % n) * n + (x % n)];
    }
    case "white-noise": {
      const f = opt.frame;
      return (x, y) => {
        let s = (x * 374761393 + y * 668265263 + f * 2246822519) >>> 0;
        s = Math.imul(s ^ (s >>> 13), 1274126177) >>> 0;
        return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
      };
    }
    case "threshold":
      return () => 0.5;
    default: {
      const cell = Math.max(2, opt.cellSize);
      const a = (opt.angle * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const spot = SPOTS[kind] ?? SPOTS["halftone-dot"];
      const cdf = spotCdf(kind, spot);
      return (x, y) => {
        // Sample at the pixel centre so the screen is symmetric.
        const u = ((x + 0.5) * ca + (y + 0.5) * sa) / cell;
        const v = (-(x + 0.5) * sa + (y + 0.5) * ca) / cell;
        const s = spot(Math.abs(u - Math.floor(u) - 0.5), Math.abs(v - Math.floor(v) - 0.5));
        return cdf[Math.min(CDF_BINS - 1, Math.floor(s * CDF_BINS))];
      };
    }
  }
}

/**
 * Spot functions over a cell, with a and b the distances from the cell centre (0..0.5).
 * Lower values go dark first. They return 0..1 and are equalised by `spotCdf`.
 */
const SPOTS: Record<string, (a: number, b: number) => number> = {
  // Euclidean dot: round dots in highlights that invert to round holes in shadows.
  "halftone-dot": (a, b) => (a + b <= 0.5 ? (a * a + b * b) * 2 : 1 - ((0.5 - a) ** 2 + (0.5 - b) ** 2) * 2) * 0.999,
  "halftone-line": (_a, b) => b * 2 * 0.999,
  "halftone-square": (a, b) => Math.max(a, b) * 2 * 0.999,
  "halftone-diamond": (a, b) => (a + b) * 0.999,
};

const CDF_BINS = 1024;
const cdfCache = new Map<string, Float32Array>();

/** Maps raw spot values to their rank so every grey level covers the right area. */
function spotCdf(kind: string, spot: (a: number, b: number) => number): Float32Array {
  let cdf = cdfCache.get(kind);
  if (cdf) return cdf;
  const hist = new Float64Array(CDF_BINS);
  const n = 256;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const s = spot(Math.abs((i + 0.5) / n - 0.5), Math.abs((j + 0.5) / n - 0.5));
      hist[Math.min(CDF_BINS - 1, Math.floor(s * CDF_BINS))]++;
    }
  }
  cdf = new Float32Array(CDF_BINS);
  let acc = 0;
  for (let k = 0; k < CDF_BINS; k++) {
    // Midpoint of the bin's mass keeps values strictly inside (0, 1).
    cdf[k] = (acc + hist[k] / 2) / (n * n);
    acc += hist[k];
  }
  cdfCache.set(kind, cdf);
  return cdf;
}

/** Spread to apply around each pixel; roughly the gap between neighbouring palette levels. */
function autoSpread(matcher: PaletteMatcher): number {
  const ls = matcher.colors.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const range = Math.max(32, Math.max(...ls) - Math.min(...ls));
  return range / Math.max(1, Math.min(matcher.colors.length - 1, 4));
}

function ordered(
  rgb: Float32Array,
  w: number,
  h: number,
  matcher: PaletteMatcher,
  kind: OrderedKind,
  opt: DitherOptions,
): Uint8Array {
  const out = new Uint8Array(w * h);
  const pal = matcher.colors;
  const t = thresholdFn(kind, opt);
  const spread = kind === "threshold" ? 0 : autoSpread(matcher) * opt.strength;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = p * 3;
      const d = (t(x, y) - 0.5) * spread;
      const idx = matcher.nearest(rgb[o] + d, rgb[o + 1] + d, rgb[o + 2] + d);
      out[p] = idx;
      const c = pal[idx];
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  return out;
}
