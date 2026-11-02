// Transparency helpers for the encoders. Plain loops over RGBA, no canvases, so they test in Node.
import type { applyPalette, quantize } from "gifenc";

/** gifenc's quantizer, passed in: the package is CommonJS, which Node's test runner can't import by name. */
export interface Quantizer {
  quantize: typeof quantize;
  applyPalette: typeof applyPalette;
}

/** Pixels below this alpha count as transparent where a format only has on/off (GIF), like Dither's cut. */
export const ALPHA_CUT = 128;

/** Whether any pixel is less than fully opaque. */
export function hasTransparency(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

/**
 * The image composited onto black, for encoders that drop alpha (H.264, HEVC, most ProRes).
 * Without this they show whatever colour sits under transparent pixels, such as Dither's
 * pattern, which it keeps under alpha 0.
 */
export function flattenOnBlack(rgba: Uint8ClampedArray): Uint8ClampedArray {
  if (!hasTransparency(rgba)) return rgba;
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    out[i] = (rgba[i] * a) / 255;
    out[i + 1] = (rgba[i + 1] * a) / 255;
    out[i + 2] = (rgba[i + 2] * a) / 255;
    out[i + 3] = 255;
  }
  return out;
}

export interface GifFrame {
  index: Uint8Array;
  palette: number[][];
  /** The palette entry that is see-through, when the frame has transparent pixels. */
  transparentIndex?: number;
}

/**
 * A frame as GIF palette indices. A frame with transparency gets 255 colours picked from its
 * visible pixels only, plus one see-through entry for every pixel under ALPHA_CUT.
 */
export function gifFrame(rgba: Uint8ClampedArray, { quantize, applyPalette }: Quantizer): GifFrame {
  // gifenc reads the pixels as 32-bit words, so it needs a buffer of its own.
  const data = rgba.byteOffset === 0 && rgba.byteLength === rgba.buffer.byteLength ? rgba : rgba.slice();
  if (!hasTransparency(data)) {
    const palette = quantize(data, 256);
    return { index: applyPalette(data, palette), palette };
  }
  let visible = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= ALPHA_CUT) visible++;
  const opaque = new Uint8ClampedArray(Math.max(1, visible) * 4);
  for (let i = 0, o = 0; i < data.length; i += 4) {
    if (data[i + 3] < ALPHA_CUT) continue;
    opaque[o++] = data[i];
    opaque[o++] = data[i + 1];
    opaque[o++] = data[i + 2];
    opaque[o++] = 255;
  }
  const palette = visible ? quantize(opaque, 255) : [[0, 0, 0]];
  const index = visible ? applyPalette(data, palette) : new Uint8Array(data.length / 4);
  const transparentIndex = palette.length;
  palette.push([0, 0, 0]);
  for (let p = 0, i = 3; i < data.length; p++, i += 4) if (data[i] < ALPHA_CUT) index[p] = transparentIndex;
  return { index, palette, transparentIndex };
}
