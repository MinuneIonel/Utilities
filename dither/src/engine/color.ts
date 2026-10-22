import type { RGB } from "./palettes";

export type DistanceMode = "rgb" | "weighted" | "luma";

/**
 * Finds the nearest palette entry for a color. Lookups are cached on a 6-bit
 * per channel grid, which is plenty for dithering since the error carries the rest.
 */
export class PaletteMatcher {
  readonly colors: RGB[];
  private cache: Int16Array;
  private mode: DistanceMode;
  private lumas: number[];

  constructor(colors: RGB[], mode: DistanceMode) {
    this.colors = colors.length ? colors : [[0, 0, 0], [255, 255, 255]];
    this.mode = mode;
    this.cache = new Int16Array(1 << 18).fill(-1);
    this.lumas = this.colors.map(([r, g, b]) => luma(r, g, b));
  }

  nearest(r: number, g: number, b: number): number {
    const ri = clamp255(r) >> 2;
    const gi = clamp255(g) >> 2;
    const bi = clamp255(b) >> 2;
    const key = (ri << 12) | (gi << 6) | bi;
    const hit = this.cache[key];
    if (hit >= 0) return hit;
    const idx = this.search((ri << 2) + 2, (gi << 2) + 2, (bi << 2) + 2);
    this.cache[key] = idx;
    return idx;
  }

  private search(r: number, g: number, b: number): number {
    const cs = this.colors;
    let best = 0;
    let bestD = Infinity;
    if (this.mode === "luma") {
      const l = luma(r, g, b);
      for (let i = 0; i < cs.length; i++) {
        const d = Math.abs(this.lumas[i] - l);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const dr = r - c[0];
      const dg = g - c[1];
      const db = b - c[2];
      let d: number;
      if (this.mode === "weighted") {
        // "redmean" approximation of perceptual distance
        const rm = (r + c[0]) / 2;
        d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      } else {
        d = dr * dr + dg * dg + db * db;
      }
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}

export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Median-cut palette extraction. */
export function extractPalette(data: Uint8ClampedArray, count: number): RGB[] {
  const pixels: RGB[] = [];
  const total = data.length / 4;
  const step = Math.max(1, Math.floor(total / 40000));
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }
  if (!pixels.length) return [[0, 0, 0], [255, 255, 255]];

  let boxes: RGB[][] = [pixels];
  while (boxes.length < count) {
    let bi = -1;
    let bestRange = -1;
    let bestCh = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestCh = ch; }
      }
    });
    if (bi < 0 || bestRange <= 0) break;
    const box = boxes[bi].sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes = [...boxes.slice(0, bi), box.slice(0, mid), box.slice(mid), ...boxes.slice(bi + 1)];
  }
  return boxes
    .map((box) => {
      const s = [0, 0, 0];
      for (const p of box) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
      return s.map((v) => Math.round(v / box.length)) as RGB;
    })
    .sort((a, b) => luma(...a) - luma(...b));
}
