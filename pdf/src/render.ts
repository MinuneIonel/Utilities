// Page rendering for the UI, with pdf.js. Kept out of the engine because it
// needs a canvas.

// The legacy build carries polyfills for browsers a year or two old.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { Bytes, Rotation } from "./engine";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSET_BASE = new URL("./pdfjs/", document.baseURI).href;

export type PdfHandle = pdfjs.PDFDocumentProxy;

/** Open a PDF for rendering. pdf.js takes ownership of the buffer, so pass a copy. */
export async function openForRender(bytes: Bytes, password?: string): Promise<PdfHandle> {
  return pdfjs.getDocument({
    data: bytes.slice(),
    password,
    standardFontDataUrl: ASSET_BASE + "standard_fonts/",
    cMapUrl: ASSET_BASE + "cmaps/",
    cMapPacked: true,
  }).promise;
}

export function isPasswordError(err: unknown): boolean {
  return (err as { name?: string })?.name === "PasswordException";
}

/**
 * Draw one PDF page into a canvas, `width` CSS pixels wide, with `rotate`
 * degrees added to the page's own rotation.
 */
export async function renderPdfPage(
  doc: PdfHandle,
  index: number,
  rotate: Rotation,
  width: number,
  canvas = document.createElement("canvas"),
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1);
  const rotation = (page.rotate + rotate) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (width / base.width) * dpr, rotation });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return canvas;
}

/** Draw an image rotated clockwise into a canvas `width` CSS pixels wide. */
export function renderImage(
  img: ImageBitmap,
  rotate: Rotation,
  width: number,
  canvas = document.createElement("canvas"),
): HTMLCanvasElement {
  const swap = rotate % 180 !== 0;
  const vw = swap ? img.height : img.width;
  const vh = swap ? img.width : img.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min((width / vw) * dpr, 1);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return canvas;
}

/** Render every page of a PDF to JPEG at the given resolution. */
export async function rasterize(
  bytes: Bytes,
  dpi: number,
  quality: number,
  onPage?: (done: number, total: number) => void,
): Promise<{ bytes: Bytes; mime: "image/jpeg"; width: number; height: number }[]> {
  const doc = await openForRender(bytes);
  const out = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob>((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode page"))), "image/jpeg", quality),
      );
      out.push({
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: "image/jpeg" as const,
        width: size.width,
        height: size.height,
      });
      page.cleanup();
      onPage?.(i, doc.numPages);
    }
  } finally {
    await doc.loadingTask.destroy();
  }
  return out;
}
