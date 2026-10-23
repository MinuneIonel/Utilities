// Pixel operations on raw RGBA frames. Pure TypeScript, no DOM.

import type { Geometry, RGBAImage, Rect } from "./types";

export function cropRGBA(src: RGBAImage, r: Rect): RGBAImage {
  if (r.x === 0 && r.y === 0 && r.width === src.width && r.height === src.height) return src;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let row = 0; row < r.height; row++) {
    const from = ((r.y + row) * src.width + r.x) * 4;
    out.set(src.data.subarray(from, from + r.width * 4), row * r.width * 4);
  }
  return { width: r.width, height: r.height, data: out };
}

/** Rotates clockwise by a multiple of 90°, then flips. */
export function orientRGBA(src: RGBAImage, rotate: Geometry["rotate"], flipH: boolean, flipV: boolean): RGBAImage {
  if (rotate === 0 && !flipH && !flipV) return src;
  const { width: w, height: h } = src;
  const sideways = rotate === 90 || rotate === 270;
  const ow = sideways ? h : w;
  const oh = sideways ? w : h;
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, w * h);
  const outBytes = new Uint8ClampedArray(ow * oh * 4);
  const o = new Uint32Array(outBytes.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (rotate === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (rotate === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else if (rotate === 270) {
        nx = y;
        ny = w - 1 - x;
      } else {
        nx = x;
        ny = y;
      }
      if (flipH) nx = ow - 1 - nx;
      if (flipV) ny = oh - 1 - ny;
      o[ny * ow + nx] = s[y * w + x];
    }
  }
  return { width: ow, height: oh, data: outBytes };
}

export function hasAlpha(img: RGBAImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** Composites onto a solid color, for formats without transparency. */
export function flattenRGBA(img: RGBAImage, hex: string): RGBAImage {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const br = (n >> 16) & 255;
  const bg = (n >> 8) & 255;
  const bb = n & 255;
  const d = img.data;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + br * (1 - a);
    out[i + 1] = d[i + 1] * a + bg * (1 - a);
    out[i + 2] = d[i + 2] * a + bb * (1 - a);
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}
