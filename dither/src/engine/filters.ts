export interface AdjustParams {
  brightness: number; // -100..100
  contrast: number; // -100..100
  gamma: number; // 0.2..3
  saturation: number; // 0..2
  invert: boolean;
}

export function adjust(rgb: Float32Array, p: AdjustParams): void {
  const c = p.contrast / 100;
  const cf = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
  const bOff = (p.brightness / 100) * 255;
  const invG = 1 / p.gamma;
  const lut = new Float32Array(256 * 4);
  for (let i = 0; i < lut.length; i++) {
    let v = i / 4;
    v = (v - 127.5) * cf + 127.5 + bOff;
    v = Math.min(255, Math.max(0, v));
    v = 255 * Math.pow(v / 255, invG);
    if (p.invert) v = 255 - v;
    lut[i] = v;
  }
  const sat = p.saturation;
  for (let i = 0; i < rgb.length; i += 3) {
    let r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    if (sat !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    rgb[i] = lut[idx(r)];
    rgb[i + 1] = lut[idx(g)];
    rgb[i + 2] = lut[idx(b)];
  }
}

function idx(v: number): number {
  const i = Math.round(v * 4);
  return i < 0 ? 0 : i > 1023 ? 1023 : i;
}

export function boxBlur(rgb: Float32Array, w: number, h: number, radius: number): void {
  // Three box passes approximate a gaussian.
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(rgb.length);
  for (let pass = 0; pass < 3; pass++) {
    blurAxis(rgb, tmp, w, h, r, true);
    blurAxis(tmp, rgb, w, h, r, false);
  }
}

function blurAxis(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horiz: boolean): void {
  const len = horiz ? w : h;
  const lines = horiz ? h : w;
  const stride = horiz ? 3 : w * 3;
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horiz ? line * w * 3 : line * 3;
    for (let ch = 0; ch < 3; ch++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        acc += src[base + Math.min(len - 1, Math.max(0, k)) * stride + ch];
      }
      for (let i = 0; i < len; i++) {
        dst[base + i * stride + ch] = acc * norm;
        const out = Math.max(0, i - r);
        const inn = Math.min(len - 1, i + r + 1);
        acc += src[base + inn * stride + ch] - src[base + out * stride + ch];
      }
    }
  }
}

export function unsharp(rgb: Float32Array, w: number, h: number, amount: number): void {
  const blurred = rgb.slice();
  boxBlur(blurred, w, h, 1);
  for (let i = 0; i < rgb.length; i++) {
    rgb[i] = rgb[i] + (rgb[i] - blurred[i]) * amount;
  }
}

export function posterize(rgb: Float32Array, levels: number): void {
  const n = Math.max(2, Math.round(levels)) - 1;
  for (let i = 0; i < rgb.length; i++) {
    const v = Math.min(255, Math.max(0, rgb[i]));
    rgb[i] = (Math.round((v / 255) * n) / n) * 255;
  }
}

/** The grain's xorshift sequence, in -0.5..0.5. Shared with the GPU renderer so both add the same noise. */
export function grainRandom(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296 - 0.5;
  };
}

/** Film-style grain. Seeded so that still images stay stable between renders. */
export function grain(rgb: Float32Array, amount: number, mono: boolean, seed: number): void {
  const rand = grainRandom(seed);
  const a = amount * 255;
  for (let i = 0; i < rgb.length; i += 3) {
    if (mono) {
      const n = rand() * a;
      rgb[i] += n; rgb[i + 1] += n; rgb[i + 2] += n;
    } else {
      rgb[i] += rand() * a; rgb[i + 1] += rand() * a; rgb[i + 2] += rand() * a;
    }
  }
}

/** Sobel edge magnitude, mixed back over the image. */
export function edges(rgb: Float32Array, w: number, h: number, strength: number, mix: number, invert: boolean): void {
  const l = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    l[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const mid = y * w;
    const dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(w - 1, x + 1);
      const gx = -l[up + xl] - 2 * l[mid + xl] - l[dn + xl] + l[up + xr] + 2 * l[mid + xr] + l[dn + xr];
      const gy = -l[up + xl] - 2 * l[up + x] - l[up + xr] + l[dn + xl] + 2 * l[dn + x] + l[dn + xr];
      let e = Math.min(255, Math.sqrt(gx * gx + gy * gy) * strength);
      if (invert) e = 255 - e;
      const o = (mid + x) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = rgb[o + c] * (1 - mix) + e * mix;
    }
  }
}

/** Maps luminance onto a gradient through the given colors (duotone, tritone...). */
export function gradientMap(rgb: Float32Array, stops: [number, number, number][], mix: number): void {
  if (stops.length < 2) return;
  const lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f;
  }
  for (let i = 0; i < rgb.length; i += 3) {
    const l = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    const li = Math.min(255, Math.max(0, Math.round(l))) * 3;
    for (let c = 0; c < 3; c++) rgb[i + c] = rgb[i + c] * (1 - mix) + lut[li + c] * mix;
  }
}
