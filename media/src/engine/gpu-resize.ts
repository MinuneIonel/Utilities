// WebGPU version of the Lanczos3 resize in transformImage: the same filter in
// linear light with premultiplied alpha, run as two separable compute passes.
// No DOM, so it runs in a worker.

const SHADER = /* wgsl */ `
struct P { sw: u32, sh: u32, w: u32, h: u32 };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> a: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> b: array<vec4f>;

const PI = 3.14159265358979;
fn sinc(x: f32) -> f32 {
  if (abs(x) < 1e-5) { return 1.0; }
  return sin(PI * x) / (PI * x);
}
fn lanczos3(x: f32) -> f32 {
  if (abs(x) >= 3.0) { return 0.0; }
  return sinc(x) * sinc(x / 3.0);
}
fn toLinear(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn toSrgb(c: f32) -> f32 {
  if (c <= 0.0031308) { return c * 12.92; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// raw (sw × sh) → a: linear, premultiplied.
@compute @workgroup_size(16, 16)
fn unpack(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.sw || g.y >= p.sh) { return; }
  let i = g.y * p.sw + g.x;
  let v = raw[i];
  let al = f32(v >> 24u) / 255.0;
  let rgb = vec3f(toLinear(f32(v & 255u) / 255.0), toLinear(f32((v >> 8u) & 255u) / 255.0), toLinear(f32((v >> 16u) & 255u) / 255.0));
  a[i] = vec4f(rgb * al, al);
}

// One axis of the filter: out pixel x samples in pixels around its centre, widened when shrinking.
fn filterAxis(x: u32, inLen: u32, outLen: u32) -> vec4f {
  let scale = f32(inLen) / f32(outLen);
  let support = 3.0 * max(scale, 1.0);
  let centre = (f32(x) + 0.5) * scale;
  return vec4f(centre, support, 1.0 / max(scale, 1.0), 0.0);
}

// a (sw × sh) → b (w × sh)
@compute @workgroup_size(16, 16)
fn across(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.sh) { return; }
  let f = filterAxis(g.x, p.sw, p.w);
  let lo = i32(max(0.0, floor(f.x - f.y)));
  let hi = i32(min(f32(p.sw), ceil(f.x + f.y)));
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = lo; i < hi; i++) {
    let wt = lanczos3((f32(i) + 0.5 - f.x) * f.z);
    acc += a[g.y * p.sw + u32(i)] * wt;
    wsum += wt;
  }
  b[g.y * p.w + g.x] = acc / wsum;
}

// b (w × sh) → a (w × h)
@compute @workgroup_size(16, 16)
fn down(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let f = filterAxis(g.y, p.sh, p.h);
  let lo = i32(max(0.0, floor(f.x - f.y)));
  let hi = i32(min(f32(p.sh), ceil(f.x + f.y)));
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = lo; i < hi; i++) {
    let wt = lanczos3((f32(i) + 0.5 - f.x) * f.z);
    acc += b[u32(i) * p.w + g.x] * wt;
    wsum += wt;
  }
  a[g.y * p.w + g.x] = acc / wsum;
}

// a (w × h) → raw, back to sRGB and straight alpha.
@compute @workgroup_size(16, 16)
fn pack(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let i = g.y * p.w + g.x;
  let c = a[i];
  let al = clamp(c.a, 0.0, 1.0);
  var rgb = vec3f(0.0);
  if (al > 0.0) { rgb = clamp(c.rgb / al, vec3f(0.0), vec3f(1.0)); }
  let q = vec3u(round(vec3f(toSrgb(rgb.r), toSrgb(rgb.g), toSrgb(rgb.b)) * 255.0));
  raw[i] = q.r | (q.g << 8u) | (q.b << 16u) | (u32(round(al * 255.0)) << 24u);
}
`;

const PASSES = ["unpack", "across", "down", "pack"] as const;

export class GpuResizer {
  private pipelines = new Map<string, GPUComputePipeline>();
  private layout: GPUBindGroupLayout;

  constructor(readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 0 ? "uniform" : "storage" } as GPUBufferBindingLayout })),
    });
    const module = device.createShaderModule({ code: SHADER });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    for (const pass of PASSES) this.pipelines.set(pass, device.createComputePipeline({ layout, compute: { module, entryPoint: pass } }));
  }

  /** Whether both sizes fit in this device's storage buffers. */
  fits(sw: number, sh: number, w: number, h: number): boolean {
    const max = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    return Math.max(sw * sh, w * sh, w * h) * 16 <= max;
  }

  /** Lanczos3 resize of straight-alpha sRGB RGBA, like Squoosh's resizer with premultiply and linearRGB. */
  async resize(src: Uint8ClampedArray, sw: number, sh: number, w: number, h: number): Promise<Uint8ClampedArray> {
    const d = this.device;
    const floats = Math.max(sw * sh, w * sh, w * h) * 16;
    const rawBytes = Math.max(sw * sh, w * h) * 4;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const raw = d.createBuffer({ size: rawBytes, usage });
    const a = d.createBuffer({ size: floats, usage });
    const b = d.createBuffer({ size: floats, usage });
    const uni = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const staging = d.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      d.queue.writeBuffer(raw, 0, src.buffer, src.byteOffset, src.byteLength);
      d.queue.writeBuffer(uni, 0, new Uint32Array([sw, sh, w, h]));
      const group = d.createBindGroup({
        layout: this.layout,
        entries: [uni, raw, a, b].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setBindGroup(0, group);
      const sizes: Record<(typeof PASSES)[number], [number, number]> = { unpack: [sw, sh], across: [w, sh], down: [w, h], pack: [w, h] };
      for (const name of PASSES) {
        pass.setPipeline(this.pipelines.get(name)!);
        pass.dispatchWorkgroups(Math.ceil(sizes[name][0] / 16), Math.ceil(sizes[name][1] / 16));
      }
      pass.end();
      enc.copyBufferToBuffer(raw, 0, staging, 0, w * h * 4);
      d.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return new Uint8ClampedArray(staging.getMappedRange().slice(0));
    } finally {
      for (const x of [raw, a, b, uni, staging]) x.destroy();
    }
  }
}
