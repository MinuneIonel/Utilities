import { BRAILLE_BITS } from "./charsets";
import type { Dither, Settings } from "./settings";

export interface Grid {
  cols: number;
  rows: number;
  /** Index into the glyph table for each cell. In ramp mode, codes at or above `levels` are edge characters. */
  codes: Uint16Array;
  /** RGB per cell. */
  colors: Uint8Array;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * Converts an RGBA image into a character grid.
 * In ramp mode the image must be cols × rows; in braille mode it must be (cols·2) × (rows·4).
 * `levels` is the length of the character ramp. `flip` reverses the ramp, for dark ink on a light background.
 */
export function convert(rgba: Uint8ClampedArray, cols: number, rows: number, s: Settings, levels: number, flip: boolean): Grid {
  const sx = s.mode === "braille" ? 2 : 1;
  const sy = s.mode === "braille" ? 4 : 1;
  const w = cols * sx;
  const h = rows * sy;
  const v = tone(rgba, w * h, s);
  if (flip) for (let i = 0; i < v.length; i++) v[i] = 1 - v[i];

  const codes = new Uint16Array(cols * rows);
  if (s.mode === "braille") {
    const dots = quantize(v, w, h, 2, s.dither);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        for (let k = 0; k < 8; k++) {
          if (dots[(r * 4 + (k >> 1)) * w + c * 2 + (k & 1)]) bits |= BRAILLE_BITS[k];
        }
        codes[r * cols + c] = bits;
      }
    }
  } else {
    // Code 0 is the lightest character, usually a space.
    if (!(s.edges > 0 && s.edgesOnly)) codes.set(quantize(v, w, h, levels, s.dither));
    if (s.edges > 0) drawEdges(v, w, h, codes, levels, s.edges);
  }
  return { cols, rows, codes, colors: cellColors(rgba, cols, rows, sx, sy, s.saturation) };
}

/** Luminance in 0..1 after normalize, brightness, contrast, gamma and invert. */
function tone(rgba: Uint8ClampedArray, n: number, s: Settings): Float32Array {
  const v = new Float32Array(n);
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    // Transparent pixels count as black, which is "no ink" before any flip.
    const y = ((0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255) * a;
    v[i] = y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const span = s.normalize && hi - lo > 0.02 ? hi - lo : 1;
  const base = s.normalize && hi - lo > 0.02 ? lo : 0;
  const c = s.contrast >= 0 ? 1 / (1 - s.contrast * 0.98) : 1 + s.contrast;
  const g = 1 / s.gamma;
  for (let i = 0; i < n; i++) {
    let y = (v[i] - base) / span;
    y = (y - 0.5) * c + 0.5 + s.brightness;
    y = y <= 0 ? 0 : y >= 1 ? 1 : y;
    if (g !== 1) y = Math.pow(y, g);
    v[i] = s.invert ? 1 - y : y;
  }
  return v;
}

/** Quantises 0..1 values to `levels` steps, optionally dithering between them. */
export function quantize(v: Float32Array, w: number, h: number, levels: number, dither: Dither): Uint16Array {
  const out = new Uint16Array(w * h);
  const top = levels - 1;
  if (dither === "none" || dither === "bayer") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = dither === "bayer" ? BAYER4[(y & 3) * 4 + (x & 3)] : 0.5;
        out[i] = Math.min(top, Math.max(0, Math.floor(v[i] * top + t)));
      }
    }
    return out;
  }
  // Error diffusion, in units of one ramp step.
  const e = Float32Array.from(v, (x) => x * top);
  const kernel =
    dither === "atkinson"
      ? [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]
      : [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const q = Math.min(top, Math.max(0, Math.round(e[i])));
      out[i] = q;
      const err = e[i] - q;
      for (const [dx, dy, f] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny < h) e[ny * w + nx] += err * f;
      }
    }
  }
  return out;
}

/** Replaces cells on strong edges with a line character that follows the edge. */
function drawEdges(v: Float32Array, w: number, h: number, codes: Uint16Array, levels: number, strength: number) {
  const threshold = (1.02 - strength) * 0.7;
  const at = (x: number, y: number) => v[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      if (Math.hypot(gx, gy) / 4 < threshold) continue;
      // The edge runs perpendicular to the gradient. Screen y points down, so 45° is a falling line.
      const deg = ((Math.atan2(gy, gx) * 180) / Math.PI + 90 + 360) % 180;
      codes[y * w + x] = levels + (Math.round(deg / 45) % 4);
    }
  }
}

function cellColors(rgba: Uint8ClampedArray, cols: number, rows: number, sx: number, sy: number, saturation: number): Uint8Array {
  const out = new Uint8Array(cols * rows * 3);
  const w = cols * sx;
  const n = sx * sy;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let R = 0, G = 0, B = 0;
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const i = ((r * sy + dy) * w + c * sx + dx) * 4;
          R += rgba[i];
          G += rgba[i + 1];
          B += rgba[i + 2];
        }
      }
      R /= n; G /= n; B /= n;
      if (saturation !== 1) {
        const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        R = y + (R - y) * saturation;
        G = y + (G - y) * saturation;
        B = y + (B - y) * saturation;
      }
      const o = (r * cols + c) * 3;
      out[o] = Math.max(0, Math.min(255, R));
      out[o + 1] = Math.max(0, Math.min(255, G));
      out[o + 2] = Math.max(0, Math.min(255, B));
    }
  }
  return out;
}
