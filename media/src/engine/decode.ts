// Decodes an image file into RGBA. Uses the browser's own decoders through createImageBitmap
// and OffscreenCanvas, so it works in a worker as well as on the main thread.

import type { RGBAImage } from "./types";

/** Largest side we decode, to keep memory sane (a 16k × 16k RGBA frame is 1 GB). */
export const MAX_DECODE = 16384;

export async function decodeImage(file: Blob): Promise<RGBAImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: "default" });
  } catch {
    throw new Error("This browser can't decode this image format.");
  }
  const { width, height } = bmp;
  if (width > MAX_DECODE || height > MAX_DECODE) {
    bmp.close();
    throw new Error(`Image is too large (${width}×${height}).`);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, width, height);
  return { width, height, data: img.data };
}
