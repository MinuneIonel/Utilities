// Background removal, minus the model: turning a picture into the model's input,
// its output into a mask the size of the picture, and the mask into a cut-out.
// No DOM and no ONNX here, so it runs in the worker and in Node tests alike.

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type ModelId = "best" | "fast";

export interface ModelSpec {
  /** The file's name, as published with rembg's models (and kept in Toolbox's folder). */
  file: string;
  /** The square the model looks at. */
  size: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** The output is logits that need a sigmoid (otherwise it's already 0–1). */
  sigmoid: boolean;
  /** Download size, for the progress label. */
  mb: number;
}

/**
 * Both are general-purpose salient-object models (people, animals, products, cars),
 * Apache-2.0, converted to ONNX by the rembg project.
 * best: IS-Net (DIS) at 1024 px; fast: U²-Net small at 320 px.
 */
export const MODELS: Record<ModelId, ModelSpec> = {
  best: { file: "isnet-general-use.onnx", size: 1024, mean: [0.485, 0.456, 0.406], std: [1, 1, 1], sigmoid: false, mb: 179 },
  fast: { file: "u2netp.onnx", size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], sigmoid: false, mb: 5 },
};

/** Bilinear sample of one channel of an interleaved image (`ch` channels per pixel), clamped at the edges. */
function bilinear(src: ArrayLike<number>, w: number, h: number, ch: number, c: number, x: number, y: number): number {
  const xc = Math.min(w - 1, Math.max(0, x));
  const yc = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = xc - x0;
  const fy = yc - y0;
  const a = src[(y0 * w + x0) * ch + c] * (1 - fx) + src[(y0 * w + x1) * ch + c] * fx;
  const b = src[(y1 * w + x0) * ch + c] * (1 - fx) + src[(y1 * w + x1) * ch + c] * fx;
  return a * (1 - fy) + b * fy;
}

/** Halves (box filter) until the picture is at most twice `n`, so the final resize doesn't alias. */
function shrinkTowards(img: Rgba, n: number): Rgba {
  let cur = img;
  while (cur.width >= 2 * n * 2 || cur.height >= 2 * n * 2) {
    const w = cur.width >> 1;
    const h = cur.height >> 1;
    const out = new Uint8ClampedArray(w * h * 4);
    const s = cur.data;
    const sw = cur.width;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (2 * y * sw + 2 * x) * 4;
        const j = i + sw * 4;
        for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = (s[i + c] + s[i + 4 + c] + s[j + c] + s[j + 4 + c] + 2) >> 2;
      }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}

/** The picture as the model's input: n×n, planar RGB (1, 3, n, n), normalised. Transparent pixels count as black. */
export function toTensor(img: Rgba, spec: ModelSpec): Float32Array {
  const n = spec.size;
  const src = shrinkTowards(img, n);
  const { width: w, height: h, data } = src;
  const out = new Float32Array(3 * n * n);
  const sx = w / n;
  const sy = h / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = (x + 0.5) * sx - 0.5;
      const py = (y + 0.5) * sy - 0.5;
      const a = bilinear(data, w, h, 4, 3, px, py) / 255;
      for (let c = 0; c < 3; c++) out[c * n * n + y * n + x] = ((bilinear(data, w, h, 4, c, px, py) / 255) * a - spec.mean[c]) / spec.std[c];
    }
  return out;
}

/**
 * The model's first output channel as a 0–1 mask (n×n). Like rembg, it's stretched to fill
 * 0–1, except when the model sees nothing at all (a flat prediction), which stays as it is.
 */
export function maskFromOutput(raw: ArrayLike<number>, spec: ModelSpec): Float32Array {
  const n = spec.size;
  const m = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const v = spec.sigmoid ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
    m[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo > 0.05) for (let i = 0; i < m.length; i++) m[i] = (m[i] - lo) / (hi - lo);
  else for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, m[i]));
  return m;
}

/** A square n×n mask stretched back over a w×h picture. */
export function resizeMask(mask: Float32Array, n: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const sx = n / w;
  const sy = n / h;
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < w; x++) out[y * w + x] = bilinear(mask, n, n, 1, 0, (x + 0.5) * sx - 0.5, py);
  }
  return out;
}

/** Mean of a w×h float image over a (2r+1)² window, clamped at the edges (summed-area table). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** A w×h float image averaged down by a whole factor `f` (edge blocks may be partial). */
function shrinkFloat(src: Float32Array, w: number, h: number, f: number) {
  const sw = Math.ceil(w / f);
  const sh = Math.ceil(h / f);
  const sum = new Float32Array(sw * sh);
  const cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const j = row + ((x / f) | 0);
      sum[j] += src[y * w + x];
      cnt[j]++;
    }
  }
  for (let j = 0; j < sum.length; j++) sum[j] /= cnt[j];
  return { data: sum, w: sw, h: sh };
}

/** Largest side the guided filter works at; bigger photos use the "fast guided filter" (coefficients at low size). */
const GUIDE_MAX = 1536;

/**
 * Guided filter (He et al.): the mask's edges follow the picture's own edges, so a mask
 * worked out at 1024 px snaps to hair and outlines in a much bigger photo. `r` is in
 * the picture's pixels.
 */
export function guidedRefine(img: Rgba, mask: Float32Array, r: number, eps = 1e-4): Float32Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  const f = Math.max(1, Math.ceil(Math.max(w, h) / GUIDE_MAX));
  const g = f > 1 ? shrinkFloat(I, w, h, f) : { data: I, w, h };
  const p = f > 1 ? shrinkFloat(mask, w, h, f).data : mask;
  const m = g.w * g.h;
  const rr = Math.max(1, Math.round(r / f));
  const Ip = new Float32Array(m);
  const II = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    Ip[i] = g.data[i] * p[i];
    II[i] = g.data[i] * g.data[i];
  }
  const mI = boxMean(g.data, g.w, g.h, rr);
  const mp = boxMean(p, g.w, g.h, rr);
  const mIp = boxMean(Ip, g.w, g.h, rr);
  const mII = boxMean(II, g.w, g.h, rr);
  const a = new Float32Array(m);
  const b = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const cov = mIp[i] - mI[i] * mp[i];
    const v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, g.w, g.h, rr);
  const mb = boxMean(b, g.w, g.h, rr);
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5) / f - 0.5;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Only the uncertain band around the edge changes: where the model was sure, the filter
      // would just bleed a little of the subject into the background (and back).
      if (mask[i] <= 0.01 || mask[i] >= 0.99) {
        out[i] = mask[i];
        continue;
      }
      const gx = (x + 0.5) / f - 0.5;
      const A = f > 1 ? bilinear(ma, g.w, g.h, 1, 0, gx, gy) : ma[i];
      const B = f > 1 ? bilinear(mb, g.w, g.h, 1, 0, gx, gy) : mb[i];
      out[i] = Math.min(1, Math.max(0, A * I[i] + B));
    }
  }
  return out;
}

export interface MaskOptions {
  /** Snap the mask to the picture's edges (helps most on photos bigger than the model's square). */
  refine: boolean;
  /** 0 keeps the model's soft edge; 100 makes it a hard cut. */
  hardness: number;
  /** Grow (+) or shrink (−) the subject, in pixels of the full-size picture. */
  shift: number;
  /** Keep the background and drop the subject instead. */
  invert: boolean;
}

/** Erodes (negative) or dilates (positive) a mask by |px| with a separable min/max. */
function morph(m: Float32Array, w: number, h: number, px: number): Float32Array {
  const r = Math.round(Math.abs(px));
  if (!r) return m;
  const grow = px > 0;
  const pick = grow ? Math.max : Math.min;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = m[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, m[y * w + k]);
      tmp[y * w + x] = v;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  return out;
}

/** The model's n×n mask as a 0–255 alpha for the full picture, after the edge settings. */
export function finishMask(img: Rgba, small: Float32Array, n: number, opts: MaskOptions, scale = 1): Uint8ClampedArray {
  const { width: w, height: h } = img;
  let m = resizeMask(small, n, w, h);
  // Smaller pictures already get the model's full detail; refining them only adds halos.
  if (opts.refine && Math.max(w, h) > n * 1.25) {
    // About one model pixel, in this picture's pixels: enough to pull the edge onto the real outline.
    const r = Math.max(2, Math.round((Math.max(w, h) / n) * 2));
    m = guidedRefine(img, m, r);
  }
  // Shift is in full-size pixels; a preview is smaller, so it moves by less.
  m = morph(m, w, h, opts.shift * scale);
  const hard = Math.min(100, Math.max(0, opts.hardness)) / 100;
  // Hardness narrows the 0→1 ramp around the middle: 0 keeps it, 1 is a step at 0.5.
  const half = 0.5 * (1 - hard) + 0.01 * hard;
  const lo = 0.5 - half;
  const span = 2 * half;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    let v = Math.min(1, Math.max(0, (m[i] - lo) / span));
    if (opts.invert) v = 1 - v;
    out[i] = Math.round(v * 255);
  }
  return out;
}

export type Fill = { type: "transparent" } | { type: "color"; rgb: [number, number, number] } | { type: "image"; image: Rgba };

/** The picture over `fill`, through `alpha`. An image fill is scaled to cover the picture and centred. */
export function composite(img: Rgba, alpha: Uint8ClampedArray, fill: Fill): Uint8ClampedArray {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  let bgAt: ((x: number, y: number, c: number) => number) | undefined;
  if (fill.type === "image") {
    const b = fill.image;
    const s = Math.max(w / b.width, h / b.height);
    const ox = (b.width * s - w) / 2;
    const oy = (b.height * s - h) / 2;
    bgAt = (x, y, c) => bilinear(b.data, b.width, b.height, 4, c, (x + 0.5 + ox) / s - 0.5, (y + 0.5 + oy) / s - 0.5);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = (alpha[i] / 255) * (data[i * 4 + 3] / 255);
      if (fill.type === "transparent") {
        out[i * 4] = data[i * 4];
        out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4 + 2];
        out[i * 4 + 3] = Math.round(a * 255);
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const bg = fill.type === "color" ? fill.rgb[c] : bgAt!(x, y, c);
        out[i * 4 + c] = data[i * 4 + c] * a + bg * (1 - a);
      }
      out[i * 4 + 3] = fill.type === "image" ? Math.round(bgAt!(x, y, 3) * (1 - a) + 255 * a) : 255;
    }
  return out;
}

/** The mask as an opaque grey picture: white keeps, black drops. */
export function maskImage(alpha: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = alpha[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** "#rgb" or "#rrggbb", or the fallback. */
export function parseHex(s: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return fallback;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
