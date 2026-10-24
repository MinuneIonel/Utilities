// WebGPU version of the recipe renderer: the resize to working size, every
// per-pixel step and the ordered, halftone and noise dithers run as compute
// passes. Error diffusion walks the image pixel by pixel, so when a recipe
// reaches one the GPU hands its float pixels to the CPU renderer for the rest.
// Same inputs and outputs as `render`; no DOM, so it runs in a worker.
import { BLUE_NOISE_SIZE, blueNoise } from "./bluenoise";
import { autoSpread, bayerMap, DIFFUSION_KERNELS, halftoneCdf } from "./dither";
import { grainRandom } from "./filters";
import { hexToRgb } from "./palettes";
import { renderFrom, type Recipe, type Step } from "./recipe";
import { defaultParams, matcherFor, resolvePalette, stepDef, type ParamValue } from "./steps";
import type { DistanceMode, PaletteMatcher } from "./color";

const SHADER = /* wgsl */ `
struct P {
  w: u32, h: u32, sw: u32, sh: u32,
  k: u32, mode: u32, frame: u32, aoff: u32,
  a: f32, b: f32, c: f32, d: f32,
  poff: u32, p1: u32, p2: u32, p3: u32,
};
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> img: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> tmp: array<vec4f>;
@group(0) @binding(3) var<storage, read> aux: array<f32>;
@group(0) @binding(4) var<storage, read> lut: array<u32>;
@group(0) @binding(5) var<storage, read_write> raw: array<u32>;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);
// Math.round, which rounds halves up (WGSL's round() rounds them to even).
fn jsRound(v: f32) -> f32 { return floor(v + 0.5); }
fn at(x: i32, y: i32) -> u32 { return u32(clamp(y, 0, i32(p.h) - 1)) * p.w + u32(clamp(x, 0, i32(p.w) - 1)); }

// Source texels that cover output pixel x along one axis: a box when shrinking, two taps when growing.
fn span(x: u32, n: u32, out: u32) -> vec2u {
  let f = f32(n) / f32(out);
  if (f >= 1.0) {
    let a = f32(x) * f;
    return vec2u(u32(floor(a)), min(n, u32(ceil(a + f))));
  }
  let c = clamp((f32(x) + 0.5) * f - 0.5, 0.0, f32(n - 1u));
  let i0 = u32(floor(c));
  return vec2u(i0, min(n, i0 + 2u));
}
fn weight(x: u32, i: u32, n: u32, out: u32) -> f32 {
  let f = f32(n) / f32(out);
  if (f >= 1.0) {
    let a = f32(x) * f;
    return max(0.0, min(a + f, f32(i + 1u)) - max(a, f32(i)));
  }
  let c = clamp((f32(x) + 0.5) * f - 0.5, 0.0, f32(n - 1u));
  return max(0.0, 1.0 - abs(f32(i) - c));
}

// raw (sw × sh packed RGBA) → img (w × h), weighting by alpha so transparent pixels don't darken edges.
@compute @workgroup_size(16, 16)
fn resample(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let rx = span(g.x, p.sw, p.w);
  let ry = span(g.y, p.sh, p.h);
  var sum = vec3f(0.0);
  var plain = vec3f(0.0);
  var sa = 0.0;
  var sw = 0.0;
  for (var iy = ry.x; iy < ry.y; iy++) {
    let wy = weight(g.y, iy, p.sh, p.h);
    for (var ix = rx.x; ix < rx.y; ix++) {
      let wt = wy * weight(g.x, ix, p.sw, p.w);
      if (wt <= 0.0) { continue; }
      let v = raw[iy * p.sw + ix];
      let c = vec4f(f32(v & 255u), f32((v >> 8u) & 255u), f32((v >> 16u) & 255u), f32(v >> 24u));
      sum += c.rgb * (c.a * wt);
      plain += c.rgb * wt;
      sa += c.a * wt;
      sw += wt;
    }
  }
  // Fully transparent areas keep their colour (the CPU renderer dithers it too, under alpha 0).
  var rgb = plain / max(sw, 1e-6);
  if (sa > 0.0) { rgb = sum / sa; }
  // The CPU renderer starts from 8-bit pixels, so these do too.
  img[g.y * p.w + g.x] = vec4f(clamp(jsRound3(rgb), vec3f(0.0), vec3f(255.0)), clamp(jsRound(sa / max(sw, 1e-6)), 0.0, 255.0));
}
fn jsRound3(v: vec3f) -> vec3f { return floor(v + 0.5); }

// img (w × h) → raw (sw × sh packed RGBA), nearest neighbour. Alpha is cut at half like the CPU
// renderer does, unless k = 1 (a plain resize).
@compute @workgroup_size(16, 16)
fn pack(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.sw || g.y >= p.sh) { return; }
  let sx = min(p.w - 1u, u32(floor((f32(g.x) + 0.5) * f32(p.w) / f32(p.sw))));
  let sy = min(p.h - 1u, u32(floor((f32(g.y) + 0.5) * f32(p.h) / f32(p.sh))));
  let c = img[sy * p.w + sx];
  let q = vec3u(round(clamp(c.rgb, vec3f(0.0), vec3f(255.0))));
  var a = select(0u, 255u, c.a >= 128.0);
  if (p.k == 1u) { a = u32(round(clamp(c.a, 0.0, 255.0))); }
  raw[g.y * p.sw + g.x] = q.r | (q.g << 8u) | (q.b << 16u) | (a << 24u);
}

fn lutIndex(v: f32) -> u32 { return u32(clamp(jsRound(v * 4.0), 0.0, 1023.0)); }

// a = saturation; aux = the 1024-entry brightness/contrast/gamma/invert table.
@compute @workgroup_size(16, 16)
fn adjust(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  var c = img[i];
  if (p.a != 1.0) {
    let l = dot(c.rgb, LUMA);
    c = vec4f(l + (c.rgb - l) * p.a, c.a);
  }
  img[i] = vec4f(aux[p.aoff + lutIndex(c.r)], aux[p.aoff + lutIndex(c.g)], aux[p.aoff + lutIndex(c.b)], c.a);
}

// k = radius. img → tmp across, tmp → img down.
@compute @workgroup_size(16, 16)
fn blurH(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let r = i32(p.k);
  var acc = vec3f(0.0);
  for (var k = -r; k <= r; k++) { acc += img[at(i32(g.x) + k, i32(g.y))].rgb; }
  let i = g.y * p.w + g.x;
  tmp[i] = vec4f(acc * (1.0 / f32(2 * r + 1)), img[i].a);
}
@compute @workgroup_size(16, 16)
fn blurV(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let r = i32(p.k);
  var acc = vec3f(0.0);
  for (var k = -r; k <= r; k++) { acc += tmp[at(i32(g.x), i32(g.y) + k)].rgb; }
  let i = g.y * p.w + g.x;
  img[i] = vec4f(acc * (1.0 / f32(2 * r + 1)), tmp[i].a);
}

// a = amount; tmp holds the blurred copy.
@compute @workgroup_size(16, 16)
fn unsharp(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  let c = img[i];
  img[i] = vec4f(c.rgb + (c.rgb - tmp[i].rgb) * p.a, c.a);
}

// a = levels - 1.
@compute @workgroup_size(16, 16)
fn posterize(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  let c = img[i];
  let v = clamp(c.rgb, vec3f(0.0), vec3f(255.0));
  img[i] = vec4f(jsRound3(v / 255.0 * p.a) / p.a * 255.0, c.a);
}

// k = 1 for one noise value per pixel, 0 for one per channel; aux = the noise.
@compute @workgroup_size(16, 16)
fn grain(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  let c = img[i];
  var n: vec3f;
  if (p.k == 1u) { n = vec3f(aux[p.aoff + i]); }
  else { n = vec3f(aux[p.aoff + i * 3u], aux[p.aoff + i * 3u + 1u], aux[p.aoff + i * 3u + 2u]); }
  img[i] = vec4f(c.rgb + n, c.a);
}

fn L(x: i32, y: i32) -> f32 { return dot(img[at(x, y)].rgb, LUMA); }

// a = strength, b = mix, k = 1 for dark lines. img → tmp.
@compute @workgroup_size(16, 16)
fn edges(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let gx = -L(x - 1, y - 1) - 2.0 * L(x - 1, y) - L(x - 1, y + 1) + L(x + 1, y - 1) + 2.0 * L(x + 1, y) + L(x + 1, y + 1);
  let gy = -L(x - 1, y - 1) - 2.0 * L(x, y - 1) - L(x + 1, y - 1) + L(x - 1, y + 1) + 2.0 * L(x, y + 1) + L(x + 1, y + 1);
  var e = min(255.0, sqrt(gx * gx + gy * gy) * p.a);
  if (p.k == 1u) { e = 255.0 - e; }
  let i = g.y * p.w + g.x;
  let c = img[i];
  tmp[i] = vec4f(c.rgb * (1.0 - p.b) + e * p.b, c.a);
}

// a = mix; aux = 256 RGB ramp entries.
@compute @workgroup_size(16, 16)
fn gradient(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  let c = img[i];
  let li = p.aoff + u32(clamp(jsRound(dot(c.rgb, LUMA)), 0.0, 255.0)) * 3u;
  let ramp = vec3f(aux[li], aux[li + 1u], aux[li + 2u]);
  img[i] = vec4f(c.rgb * (1.0 - p.a) + ramp * p.a, c.a);
}

fn q6(v: f32) -> u32 {
  if (v < 0.0) { return 0u; }
  if (v > 255.0) { return 63u; }
  return u32(v) >> 2u;
}

fn spot(kind: u32, a: f32, b: f32) -> f32 {
  if (kind == 1u) { return b * 2.0 * 0.999; }
  if (kind == 2u) { return max(a, b) * 2.0 * 0.999; }
  if (kind == 3u) { return (a + b) * 0.999; }
  if (a + b <= 0.5) { return (a * a + b * b) * 2.0 * 0.999; }
  return (1.0 - ((0.5 - a) * (0.5 - a) + (0.5 - b) * (0.5 - b)) * 2.0) * 0.999;
}

// Ordered dithers. k: 0 threshold map (mode = its size), 1 white noise, 2 plain threshold, 3 halftone (mode = spot).
// a = spread, b = cell size, c/d = cos/sin of the screen angle.
// aux: the palette as RGB from poff, the threshold map or halftone ranks from aoff. lut: nearest colour per 6-bit RGB.
@compute @workgroup_size(16, 16)
fn ordered(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  var t = 0.5;
  if (p.k == 0u) {
    let n = p.mode;
    t = aux[p.aoff + (g.y % n) * n + (g.x % n)];
  } else if (p.k == 1u) {
    var s = g.x * 374761393u + g.y * 668265263u + p.frame * 2246822519u;
    s = (s ^ (s >> 13u)) * 1274126177u;
    t = f32(s ^ (s >> 16u)) / 4294967296.0;
  } else if (p.k == 3u) {
    let px = f32(g.x) + 0.5;
    let py = f32(g.y) + 0.5;
    let u = (px * p.c + py * p.d) / p.b;
    let v = (-px * p.d + py * p.c) / p.b;
    let s = spot(p.mode, abs(u - floor(u) - 0.5), abs(v - floor(v) - 0.5));
    t = aux[p.aoff + min(1023u, u32(floor(s * 1024.0)))];
  }
  let i = g.y * p.w + g.x;
  let c = img[i];
  let v = c.rgb + (t - 0.5) * p.a;
  let idx = lut[(q6(v.r) << 12u) | (q6(v.g) << 6u) | q6(v.b)];
  let o = p.poff + idx * 3u;
  img[i] = vec4f(aux[o], aux[o + 1u], aux[o + 2u], c.a);
}
`;

const PASSES = ["resample", "pack", "adjust", "blurH", "blurV", "unsharp", "posterize", "grain", "edges", "gradient", "ordered"] as const;
type Pass = (typeof PASSES)[number];

/** Steps the GPU runs; a dither step only when it isn't error diffusion. */
export function gpuCanRun(step: Step): boolean {
  if (step.type === "dither") return !DIFFUSION_KERNELS[String(step.params.algorithm ?? defaultParams("dither").algorithm)];
  return ["adjust", "blur", "sharpen", "posterize", "grain", "edges", "gradient"].includes(step.type);
}

const HALFTONE_SPOT: Record<string, number> = { "halftone-dot": 0, "halftone-line": 1, "halftone-square": 2, "halftone-diamond": 3 };

interface Uniform {
  w: number; h: number; sw?: number; sh?: number;
  k?: number; mode?: number; frame?: number; aoff?: number;
  a?: number; b?: number; c?: number; d?: number;
  poff?: number;
}

interface Op {
  /** "copy" copies tmp's buffer into img's, between passes. */
  pass: Pass | "copy";
  u: Uniform;
  /** Which of the three float buffers play img and tmp. */
  img: 0 | 1 | 2;
  tmp: 0 | 1 | 2;
  lut?: GPUBuffer;
}

/** Floats for the aux buffer, each section starting on a 256-byte boundary so passes can find it by offset. */
class Aux {
  parts: Float32Array[] = [];
  length = 0;
  add(data: ArrayLike<number>): number {
    const at = this.length;
    const padded = Math.ceil(Math.max(1, data.length) / 64) * 64;
    const f = new Float32Array(padded);
    f.set(data);
    this.parts.push(f);
    this.length += padded;
    return at;
  }
  build(): Float32Array {
    const out = new Float32Array(Math.max(64, this.length));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export interface GpuRenderOptions {
  /** Size to draw the result at, nearest neighbour (big pixels). Defaults to the working size. */
  outWidth?: number;
  outHeight?: number;
  frame?: number;
}

export interface GpuRenderResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** How many enabled steps ran on the GPU; the rest ran on the CPU. */
  gpuSteps: number;
}

/**
 * One per GPU device. Buffers are kept between calls and grown when a frame
 * needs more, so a video reuses them frame after frame.
 */
export class GpuRenderer {
  private pipelines = new Map<Pass, GPUComputePipeline>();
  private layout: GPUBindGroupLayout;
  private float: GPUBuffer[] = [];
  private floatBytes = 0;
  private raw?: GPUBuffer;
  private rawBytes = 0;
  private dummy: GPUBuffer;
  private luts = new WeakMap<PaletteMatcher, GPUBuffer>();

  constructor(readonly device: GPUDevice) {
    const storage = (type: GPUBufferBindingType): GPUBindGroupLayoutEntry["buffer"] => ({ type });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: storage("uniform") },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: storage("storage") },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: storage("storage") },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: storage("read-only-storage") },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: storage("read-only-storage") },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: storage("storage") },
      ],
    });
    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    for (const pass of PASSES) this.pipelines.set(pass, device.createComputePipeline({ layout, compute: { module, entryPoint: pass } }));
    this.dummy = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE });
  }

  /** Whether a working image of w × h pixels fits in one storage buffer here. */
  fits(w: number, h: number, sw = w, sh = h): boolean {
    const max = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    return w * h * 16 <= max && sw * sh * 4 <= max;
  }

  private buffers(floatBytes: number, rawBytes: number) {
    const d = this.device;
    if (floatBytes > this.floatBytes) {
      for (const b of this.float) b.destroy();
      this.float = [0, 1, 2].map(() => d.createBuffer({ size: floatBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }));
      this.floatBytes = floatBytes;
    }
    if (rawBytes > this.rawBytes) {
      this.raw?.destroy();
      this.raw = d.createBuffer({ size: rawBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.rawBytes = rawBytes;
    }
  }

  /** The palette's nearest-colour table on the 6-bit grid PaletteMatcher caches on, so both pick the same colours. */
  private lutFor(m: PaletteMatcher): GPUBuffer {
    let b = this.luts.get(m);
    if (!b) {
      const t = new Uint32Array(1 << 18);
      for (let k = 0; k < t.length; k++) t[k] = m.nearest(((k >> 12) << 2) + 2, (((k >> 6) & 63) << 2) + 2, ((k & 63) << 2) + 2);
      b = this.device.createBuffer({ size: t.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, t);
      this.luts.set(m, b);
    }
    return b;
  }

  private encode(enc: GPUCommandEncoder, ops: Op[], aux: GPUBuffer) {
    const d = this.device;
    const slot = 256;
    const uni = d.createBuffer({ size: Math.max(1, ops.length) * slot, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = new ArrayBuffer(Math.max(1, ops.length) * slot);
    ops.forEach((op, i) => {
      const u = op.u;
      new Uint32Array(data, i * slot, 8).set([u.w, u.h, u.sw ?? u.w, u.sh ?? u.h, u.k ?? 0, u.mode ?? 0, u.frame ?? 0, u.aoff ?? 0]);
      new Float32Array(data, i * slot + 32, 4).set([u.a ?? 0, u.b ?? 0, u.c ?? 0, u.d ?? 0]);
      new Uint32Array(data, i * slot + 48, 1).set([u.poff ?? 0]);
    });
    d.queue.writeBuffer(uni, 0, data);
    const pass = enc.beginComputePass();
    ops.forEach((op, i) => {
      const group = d.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: uni, offset: i * slot, size: 64 } },
          { binding: 1, resource: { buffer: this.float[op.img] } },
          { binding: 2, resource: { buffer: this.float[op.tmp] } },
          { binding: 3, resource: { buffer: aux } },
          { binding: 4, resource: { buffer: op.lut ?? this.dummy } },
          { binding: 5, resource: { buffer: this.raw! } },
        ],
      });
      pass.setPipeline(this.pipelines.get(op.pass as Pass)!);
      pass.setBindGroup(0, group);
      const gw = op.pass === "pack" ? op.u.sw! : op.u.w;
      const gh = op.pass === "pack" ? op.u.sh! : op.u.h;
      pass.dispatchWorkgroups(Math.ceil(gw / 16), Math.ceil(gh / 16));
    });
    pass.end();
    return uni;
  }

  private upload(src: Uint8ClampedArray) {
    this.device.queue.writeBuffer(this.raw!, 0, src.buffer, src.byteOffset, src.byteLength);
  }

  /** Resamples an RGBA image: averaged when shrinking, bilinear when growing. */
  async resize(src: Uint8ClampedArray, sw: number, sh: number, w: number, h: number): Promise<Uint8ClampedArray> {
    this.buffers(w * h * 16, Math.max(sw * sh, w * h) * 4);
    this.upload(src);
    const ops: Op[] = [
      { pass: "resample", u: { w, h, sw, sh }, img: 0, tmp: 1 },
      { pass: "pack", u: { w, h, sw: w, sh: h, k: 1 }, img: 0, tmp: 1 },
    ];
    return new Uint8ClampedArray(await this.run(ops, new Float32Array(64), { buffer: "raw", bytes: w * h * 4 }));
  }

  /**
   * Scales `src` (sw × sh) to the w × h working size and runs the recipe. The
   * result is outWidth × outHeight when every step ran here, else w × h.
   */
  async render(src: Uint8ClampedArray, sw: number, sh: number, w: number, h: number, recipe: Recipe, opts: GpuRenderOptions = {}): Promise<GpuRenderResult> {
    const frame = opts.frame ?? 0;
    const steps = recipe.steps.filter((s) => s.enabled && stepDef(s.type));
    let cut = steps.findIndex((s) => !gpuCanRun(s));
    if (cut < 0) cut = steps.length;
    const gpuSteps = steps.slice(0, cut);
    const rest = steps.slice(cut);
    const outW = rest.length ? w : (opts.outWidth ?? w);
    const outH = rest.length ? h : (opts.outHeight ?? h);
    const n = w * h;
    this.buffers(n * 16, Math.max(sw * sh, outW * outH) * 4);
    this.upload(src);

    // Palettes taken from the image, and the CPU half of a recipe, need the resized source here.
    const resample: Op = { pass: "resample", u: { w, h, sw, sh }, img: 0, tmp: 1 };
    const ops: Op[] = [];
    let source: Uint8ClampedArray | undefined;
    if (rest.length > 0 || gpuSteps.some((s) => s.type === "dither" && s.params.palette === "extract")) {
      const f = new Float32Array(await this.run([resample], new Float32Array(64), { buffer: 0, bytes: n * 16 }));
      source = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n * 4; i++) source[i] = f[i];
    } else ops.push(resample);

    const aux = new Aux();
    let cur: 0 | 1 | 2 = 0;
    const other = (a: number, b?: number) => [0, 1, 2].find((x) => x !== a && x !== b) as 0 | 1 | 2;
    for (const step of gpuSteps) {
      const p: Record<string, ParamValue> = { ...defaultParams(step.type), ...step.params };
      const num = (k: string) => Number(p[k]);
      const t = other(cur);
      switch (step.type) {
        case "adjust": {
          const c = num("contrast") / 100;
          const cf = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
          const bOff = (num("brightness") / 100) * 255;
          const invG = 1 / num("gamma");
          const lut = new Float32Array(1024);
          for (let i = 0; i < lut.length; i++) {
            let v = i / 4;
            v = (v - 127.5) * cf + 127.5 + bOff;
            v = Math.min(255, Math.max(0, v));
            v = 255 * Math.pow(v / 255, invG);
            if (p.invert) v = 255 - v;
            lut[i] = v;
          }
          ops.push({ pass: "adjust", u: { w, h, a: num("saturation"), aoff: aux.add(lut) }, img: cur, tmp: t });
          break;
        }
        case "blur": {
          const r = Math.max(1, Math.round(num("radius")));
          if (num("radius") > 0) for (let i = 0; i < 3; i++) ops.push({ pass: "blurH", u: { w, h, k: r }, img: cur, tmp: t }, { pass: "blurV", u: { w, h, k: r }, img: cur, tmp: t });
          break;
        }
        case "sharpen": {
          const copy = other(cur, t);
          ops.push({ pass: "copy", u: { w, h }, img: copy, tmp: cur });
          for (let i = 0; i < 3; i++) ops.push({ pass: "blurH", u: { w, h, k: 1 }, img: copy, tmp: t }, { pass: "blurV", u: { w, h, k: 1 }, img: copy, tmp: t });
          ops.push({ pass: "unsharp", u: { w, h, a: num("amount") }, img: cur, tmp: copy });
          break;
        }
        case "posterize":
          ops.push({ pass: "posterize", u: { w, h, a: Math.max(2, Math.round(num("levels"))) - 1 }, img: cur, tmp: t });
          break;
        case "grain": {
          const mono = p.mono === true;
          const rand = grainRandom(p.animate === true ? frame + 1 : 1);
          const a = num("amount") * 255;
          const noise = new Float32Array(mono ? n : n * 3);
          for (let i = 0; i < noise.length; i++) noise[i] = rand() * a;
          ops.push({ pass: "grain", u: { w, h, k: mono ? 1 : 0, aoff: aux.add(noise) }, img: cur, tmp: t });
          break;
        }
        case "edges":
          ops.push({ pass: "edges", u: { w, h, a: num("strength"), b: num("mix"), k: p.invert === true ? 1 : 0 }, img: cur, tmp: t });
          cur = t;
          break;
        case "gradient": {
          const stops = (p.colors as string[]).map(hexToRgb);
          if (stops.length < 2) break;
          const lut = new Float32Array(256 * 3);
          for (let i = 0; i < 256; i++) {
            const x = (i / 255) * (stops.length - 1);
            const k = Math.min(stops.length - 2, Math.floor(x));
            const f = x - k;
            for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f;
          }
          ops.push({ pass: "gradient", u: { w, h, a: num("mix"), aoff: aux.add(lut) }, img: cur, tmp: t });
          break;
        }
        case "dither": {
          const m = matcherFor(resolvePalette(p, source), String(p.distance) as DistanceMode);
          const kind = String(p.algorithm);
          let u: Uniform;
          if (kind.startsWith("bayer")) {
            const size = parseInt(kind.slice(5), 10);
            u = { w, h, k: 0, mode: size, aoff: aux.add(bayerMap(size)) };
          } else if (kind === "blue-noise") u = { w, h, k: 0, mode: BLUE_NOISE_SIZE, aoff: aux.add(blueNoise()) };
          else if (kind === "white-noise") u = { w, h, k: 1, frame };
          else if (kind === "threshold") u = { w, h, k: 2 };
          else {
            const a = (num("angle") * Math.PI) / 180;
            u = { w, h, k: 3, mode: HALFTONE_SPOT[kind] ?? 0, b: Math.max(2, num("cellSize")), c: Math.cos(a), d: Math.sin(a), aoff: aux.add(halftoneCdf(kind)) };
          }
          u.a = kind === "threshold" ? 0 : autoSpread(m) * num("strength");
          u.poff = aux.add(m.colors.flat());
          ops.push({ pass: "ordered", u, img: cur, tmp: t, lut: this.lutFor(m) });
          break;
        }
      }
    }

    if (!rest.length) {
      ops.push({ pass: "pack", u: { w, h, sw: outW, sh: outH }, img: cur, tmp: other(cur) });
      const out = await this.run(ops, aux.build(), { buffer: "raw", bytes: outW * outH * 4 });
      return { rgba: new Uint8ClampedArray(out), width: outW, height: outH, gpuSteps: gpuSteps.length };
    }
    const f = new Float32Array(await this.run(ops, aux.build(), { buffer: cur, bytes: n * 16 }));
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = f[i * 4];
      rgb[i * 3 + 1] = f[i * 4 + 1];
      rgb[i * 3 + 2] = f[i * 4 + 2];
    }
    const r = renderFrom(rgb, source!, w, h, rest, frame);
    return { rgba: r.rgba, width: w, height: h, gpuSteps: gpuSteps.length };
  }

  /** Runs the passes in one submission and reads back one buffer. */
  private async run(ops: Op[], auxData: Float32Array, read: { buffer: 0 | 1 | 2 | "raw"; bytes: number }): Promise<ArrayBuffer> {
    const d = this.device;
    const aux = d.createBuffer({ size: Math.max(256, auxData.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(aux, 0, auxData);
    const trash = [aux];
    const enc = d.createCommandEncoder();
    let chunk: Op[] = [];
    const flush = () => {
      if (chunk.length) trash.push(this.encode(enc, chunk, aux));
      chunk = [];
    };
    for (const op of ops) {
      if (op.pass === "copy") {
        flush();
        enc.copyBufferToBuffer(this.float[op.tmp], 0, this.float[op.img], 0, op.u.w * op.u.h * 16);
      } else chunk.push(op);
    }
    flush();
    const staging = d.createBuffer({ size: read.bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    trash.push(staging);
    enc.copyBufferToBuffer(read.buffer === "raw" ? this.raw! : this.float[read.buffer], 0, staging, 0, read.bytes);
    d.queue.submit([enc.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      return staging.getMappedRange().slice(0);
    } finally {
      for (const b of trash) b.destroy();
    }
  }
}
