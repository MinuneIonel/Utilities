// The GPU, through WebGPU, for frame nodes that work pixel by pixel. One device
// per thread (the graph worker has its own). Without WebGPU, or after a GPU
// error, nodes run their CPU code instead, which gives the same pictures.
import { GpuRenderer } from "../../../dither/src/engine/gpu";
import { GpuResizer } from "../../../media/src/engine/gpu-resize";

/** The engines' GPU halves, sharing one device. */
export interface Gpu {
  device: GPUDevice;
  dither: GpuRenderer;
  lanczos: GpuResizer;
}

let enabled = true;
let renderer: Promise<Gpu | null> | undefined;

/** Turns the GPU path off (benchmarks, tests, or a machine where it misbehaves). */
export function setGpuEnabled(on: boolean) {
  enabled = on;
}

async function create(): Promise<Gpu | null> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  // Big frames need big buffers; the defaults (128 MB bindings) are smaller than a 4096 px working image.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  void device.lost.then(() => {
    renderer = undefined;
  });
  const r = new GpuRenderer(device);
  // A quick check that the shaders compiled and run: one red and one blue pixel average to purple.
  const px = await r.resize(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, 1, 1);
  if (Math.abs(px[0] - 128) > 1 || Math.abs(px[2] - 128) > 1 || px[3] !== 255) {
    device.destroy();
    return null;
  }
  return { device, dither: r, lanczos: new GpuResizer(device) };
}

/** The GPU engines, or null when this thread has no usable GPU. */
export function gpu(): Promise<Gpu | null> {
  if (!enabled || typeof navigator === "undefined" || !("gpu" in navigator)) return Promise.resolve(null);
  renderer ??= create().catch((e) => {
    console.warn("WebGPU unavailable, using the CPU:", e);
    return null;
  });
  return renderer;
}

/**
 * Runs `onGpu` when there's a GPU, else (or if it throws) `onCpu`. A GPU that
 * fails once is dropped for the rest of the session.
 */
export async function preferGpu<T>(onGpu: (g: Gpu) => Promise<T | undefined>, onCpu: () => T | Promise<T>): Promise<T> {
  const g = await gpu();
  if (g) {
    try {
      const r = await onGpu(g);
      if (r !== undefined) return r;
    } catch (e) {
      console.warn("GPU pass failed, using the CPU from now on:", e);
      enabled = false;
    }
  }
  return onCpu();
}
