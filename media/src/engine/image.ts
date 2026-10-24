// Image pipeline: RGBA frame in, encoded file out. Uses the Squoosh codecs (jSquash):
// MozJPEG, libwebp, libavif, and oxipng, plus Squoosh's Lanczos resizer. No DOM.

import { encode as encodeAvif } from "@jsquash/avif";
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { optimise as optimisePng } from "@jsquash/oxipng";
import { encode as encodePng } from "@jsquash/png";
import resizeImage from "@jsquash/resize";
import { encode as encodeWebp } from "@jsquash/webp";
import { cropRGBA, flattenRGBA, hasAlpha, orientRGBA } from "./raster";
import { planGeometry, type EncodedFile, type ImageFormat, type ImageJob, type RGBAImage } from "./types";

export const IMAGE_FORMATS: Record<ImageFormat, { label: string; mime: string; ext: string; lossy: boolean; alpha: boolean }> = {
  jpeg: { label: "JPEG (MozJPEG)", mime: "image/jpeg", ext: "jpg", lossy: true, alpha: false },
  webp: { label: "WebP", mime: "image/webp", ext: "webp", lossy: true, alpha: true },
  avif: { label: "AVIF", mime: "image/avif", ext: "avif", lossy: true, alpha: true },
  png: { label: "PNG (oxipng)", mime: "image/png", ext: "png", lossy: false, alpha: true },
};

/** Resizes to exactly w × h; a host can pass its own (the GPU one in gpu-resize.ts) for the Lanczos step. */
export type Resizer = (img: RGBAImage, width: number, height: number) => Promise<RGBAImage | undefined>;

/** Crops, orients and resizes. Exposed separately so a pipeline can reuse it without encoding. */
export async function transformImage(src: RGBAImage, job: ImageJob, resizer?: Resizer): Promise<RGBAImage> {
  const g = planGeometry(src.width, src.height, job);
  let img = cropRGBA(src, g.crop);
  img = orientRGBA(img, g.rotate, g.flipH, g.flipV);
  if (img.width !== g.width || img.height !== g.height) {
    const fast = await resizer?.(img, g.width, g.height);
    if (fast) return fast;
    const out = await resizeImage(img as ImageData, {
      width: g.width,
      height: g.height,
      method: "lanczos3",
      fitMethod: "stretch",
      premultiply: true,
      linearRGB: true,
    });
    img = { width: out.width, height: out.height, data: out.data };
  }
  return img;
}

export async function encodeImage(img: RGBAImage, job: ImageJob, quality = job.quality): Promise<Uint8Array> {
  const q = Math.round(Math.min(100, Math.max(0, quality)));
  let buf: ArrayBuffer;
  switch (job.format) {
    case "jpeg": {
      const flat = hasAlpha(img) ? flattenRGBA(img, job.background) : img;
      buf = await encodeJpeg(flat as ImageData, { quality: q, progressive: true, optimize_coding: true });
      break;
    }
    case "webp":
      buf = await encodeWebp(img as ImageData, job.lossless ? { lossless: 1, quality: 100, exact: 1 } : { quality: q, method: 4 });
      break;
    case "avif":
      buf = await encodeAvif(img as ImageData, job.lossless ? { lossless: true } : { quality: q, speed: 6 });
      break;
    case "png": {
      const raw = await encodePng(img as ImageData);
      buf = job.pngLevel > 0 ? await optimisePng(raw, { level: job.pngLevel, optimiseAlpha: true }) : raw;
      break;
    }
  }
  return new Uint8Array(buf);
}

export interface ImageResult extends EncodedFile {
  /** The quality actually used (differs from the job when a size limit applied). */
  quality: number;
  /** False when even the lowest quality is over the size limit. */
  fits: boolean;
}

export async function processImage(src: RGBAImage, job: ImageJob): Promise<ImageResult> {
  const img = await transformImage(src, job);
  const fmt = IMAGE_FORMATS[job.format];
  const base = { mime: fmt.mime, ext: fmt.ext, width: img.width, height: img.height, via: "jSquash" };

  let bytes = await encodeImage(img, job);
  let quality = job.quality;
  let fits = true;
  if (job.maxBytes && bytes.length > job.maxBytes && fmt.lossy && !job.lossless) {
    // Binary search for the highest quality under the limit.
    let lo = 1;
    let hi = job.quality - 1;
    let best: { bytes: Uint8Array; q: number } | null = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = await encodeImage(img, job, mid);
      if (b.length <= job.maxBytes) {
        best = { bytes: b, q: mid };
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best) {
      bytes = best.bytes;
      quality = best.q;
    } else {
      bytes = await encodeImage(img, job, 1);
      quality = 1;
      fits = false;
    }
  } else if (job.maxBytes && bytes.length > job.maxBytes) fits = false;
  return { ...base, bytes, quality, fits };
}
