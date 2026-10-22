// Shared job types and the geometry planner. Pure TypeScript, no DOM.

export type Kind = "image" | "video";

/** A rectangle in source pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Raw RGBA pixels, row-major, 4 bytes per pixel. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Rotation = 0 | 90 | 180 | 270;

export type Resize =
  | { mode: "none" }
  | { mode: "percent"; percent: number }
  /**
   * A target box. Leave one side out to keep the aspect ratio.
   * contain: fit inside the box. cover: fill the box exactly, trimming the overflow from the center.
   * fill: stretch to the box.
   */
  | { mode: "box"; width?: number; height?: number; fit: "contain" | "cover" | "fill"; upscale: boolean }
  /** Scale so the longer side is this many pixels. */
  | { mode: "long-edge"; size: number; upscale: boolean };

/** Geometry shared by images and videos. Applied in this order: crop, rotate, flip, resize. */
export interface Transform {
  /** In the source's displayed orientation. Leave out for the whole frame. */
  crop?: Rect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  resize: Resize;
}

export type ImageFormat = "jpeg" | "webp" | "avif" | "png";

export interface ImageJob extends Transform {
  format: ImageFormat;
  /** 0–100. Ignored for PNG and lossless WebP. */
  quality: number;
  lossless: boolean;
  /** When set, quality is lowered until the file fits (lossy formats only). */
  maxBytes?: number;
  /** Fill for transparent pixels when the format has no alpha (JPEG). */
  background: string;
  /** PNG optimizer effort, 0–6 (oxipng). */
  pngLevel: number;
}

export type VideoContainer = "mp4" | "webm" | "mov" | "mkv" | "gif";
export type VideoCodecChoice = "auto" | "avc" | "hevc" | "vp9" | "av1" | "vp8";
export type QualityLevel = "very-low" | "low" | "medium" | "high" | "very-high";

export interface VideoJob extends Transform {
  container: VideoContainer;
  codec: VideoCodecChoice;
  /** How the encoder decides on size. */
  rate: { mode: "copy" } | { mode: "quality"; level: QualityLevel } | { mode: "bitrate"; kbps: number } | { mode: "size"; megabytes: number };
  /** Output frame rate. 0 keeps the source rate. */
  fps: number;
  /** Seconds. Leave out to keep the whole clip. */
  trim?: { start: number; end: number };
  audio: "keep" | "remove";
  audioKbps: number;
}

export interface EncodedFile {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  /** Which library produced the file, for display. */
  via: string;
}

export interface Progress {
  /** 0–1, or -1 when unknown. */
  fraction: number;
  label?: string;
}

export interface Geometry {
  /** Crop in source space, clamped and rounded. */
  crop: Rect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** Final size, after rotation and resize. */
  width: number;
  height: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampRect(r: Rect, w: number, h: number): Rect {
  const x = clamp(Math.round(r.x), 0, w - 1);
  const y = clamp(Math.round(r.y), 0, h - 1);
  return {
    x,
    y,
    width: clamp(Math.round(r.width), 1, w - x),
    height: clamp(Math.round(r.height), 1, h - y),
  };
}

/** Shrinks a rectangle around its center until it has the given aspect ratio (width / height). */
export function centerToAspect(r: Rect, aspect: number): Rect {
  if (r.width / r.height > aspect) {
    const width = r.height * aspect;
    return { x: r.x + (r.width - width) / 2, y: r.y, width, height: r.height };
  }
  const height = r.width / aspect;
  return { x: r.x, y: r.y + (r.height - height) / 2, width: r.width, height };
}

/**
 * Works out the crop and final size for a source of the given size. `even` rounds the output
 * to even numbers, which most video encoders need.
 */
export function planGeometry(srcW: number, srcH: number, t: Transform, even = false): Geometry {
  let crop = clampRect(t.crop ?? { x: 0, y: 0, width: srcW, height: srcH }, srcW, srcH);
  const sideways = t.rotate === 90 || t.rotate === 270;
  const rw = sideways ? crop.height : crop.width;
  const rh = sideways ? crop.width : crop.height;

  let w = rw;
  let h = rh;
  const r = t.resize;
  if (r.mode === "percent") {
    w = (rw * r.percent) / 100;
    h = (rh * r.percent) / 100;
  } else if (r.mode === "long-edge") {
    const s = r.size / Math.max(rw, rh);
    if (s < 1 || r.upscale) {
      w = rw * s;
      h = rh * s;
    }
  } else if (r.mode === "box") {
    const bw = r.width && r.width > 0 ? r.width : undefined;
    const bh = r.height && r.height > 0 ? r.height : undefined;
    if (bw && bh) {
      if (r.fit === "fill") {
        w = bw;
        h = bh;
      } else if (r.fit === "contain") {
        const s = Math.min(bw / rw, bh / rh);
        if (s < 1 || r.upscale) {
          w = rw * s;
          h = rh * s;
        }
      } else {
        // Cover: trim the crop to the box's shape, then scale to the box.
        const aspect = sideways ? bh / bw : bw / bh;
        crop = clampRect(centerToAspect(crop, aspect), srcW, srcH);
        const cw = sideways ? crop.height : crop.width;
        if (bw / cw < 1 || r.upscale) {
          w = bw;
          h = bh;
        } else {
          w = cw;
          h = sideways ? crop.width : crop.height;
        }
      }
    } else if (bw || bh) {
      const s = bw ? bw / rw : bh! / rh;
      if (s < 1 || r.upscale) {
        w = rw * s;
        h = rh * s;
      }
    }
  }

  const round = (v: number) => (even ? Math.max(2, Math.round(v / 2) * 2) : Math.max(1, Math.round(v)));
  if (even) {
    // Keep the crop itself even too, so encoders and scalers agree.
    crop = { ...crop, width: Math.max(2, crop.width - (crop.width % 2)), height: Math.max(2, crop.height - (crop.height % 2)) };
  }
  return { crop, rotate: t.rotate, flipH: t.flipH, flipV: t.flipV, width: round(w), height: round(h) };
}

/** Maps a source-space crop into the rotated and flipped frame (the space Mediabunny crops in). */
export function cropInTransformedSpace(g: Geometry, srcW: number, srcH: number): Rect {
  const { x, y, width: w, height: h } = g.crop;
  let r: Rect;
  let fw = srcW;
  let fh = srcH;
  switch (g.rotate) {
    case 90:
      r = { x: srcH - (y + h), y: x, width: h, height: w };
      fw = srcH;
      fh = srcW;
      break;
    case 180:
      r = { x: srcW - (x + w), y: srcH - (y + h), width: w, height: h };
      break;
    case 270:
      r = { x: y, y: srcW - (x + w), width: h, height: w };
      fw = srcH;
      fh = srcW;
      break;
    default:
      r = { x, y, width: w, height: h };
  }
  if (g.flipH) r = { ...r, x: fw - (r.x + r.width) };
  if (g.flipV) r = { ...r, y: fh - (r.y + r.height) };
  return r;
}

export function kindOf(file: { type: string; name: string }): Kind | null {
  const t = file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  // Animated GIFs are treated as video so they can become MP4/WebM, and back.
  if (t === "image/gif" || ext === "gif") return "video";
  if (t.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "avif", "bmp", "heic", "heif", "tif", "tiff", "ico", "svg"].includes(ext)) return "image";
  if (t.startsWith("video/") || ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "mts", "m2ts", "3gp", "ogv"].includes(ext)) return "video";
  return null;
}

export function swapExt(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + "." + ext;
}
