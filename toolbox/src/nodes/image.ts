// Pixel helpers built on OffscreenCanvas, which exists both in the window and in workers.
import type { ImageValue } from "../runtime/types";

function canvas(w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  return { c, g: c.getContext("2d", { willReadFrequently: true })! };
}

export async function decodeImage(blob: Blob, maxSide = Infinity): Promise<ImageValue> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error("Can't read this file as an image");
  }
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const { g } = canvas(w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { kind: "image", width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}

/** Resamples to w × h; `smooth` false keeps hard pixel edges (for upscaling dithered output). */
export function scaleImage(img: ImageValue, w: number, h: number, smooth: boolean): ImageValue {
  if (w === img.width && h === img.height) return img;
  const src = canvas(img.width, img.height);
  src.g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const dst = canvas(w, h);
  dst.g.imageSmoothingEnabled = smooth;
  dst.g.imageSmoothingQuality = "high";
  dst.g.drawImage(src.c, 0, 0, w, h);
  return { kind: "image", width: w, height: h, data: dst.g.getImageData(0, 0, w, h).data };
}

export async function encodeImage(img: ImageValue, mime: string, quality: number): Promise<Uint8Array> {
  const { c, g } = canvas(img.width, img.height);
  g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await c.convertToBlob({ type: mime, quality });
  if (blob.type !== mime) throw new Error(`This system can't encode ${mime}`);
  return new Uint8Array(await blob.arrayBuffer());
}
