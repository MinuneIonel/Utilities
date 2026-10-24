// pdf.js, for turning pages into images. Loaded on first use, so only the graph
// worker pulls it in.
// The legacy build carries polyfills (e.g. Map.getOrInsertComputed) for Chromium versions a year or two old.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { DocumentValue, ImageValue } from "../runtime/types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** pdf.js draws into OffscreenCanvas here, since the worker has no document. */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: { canvas: OffscreenCanvas }, width: number, height: number) {
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (cc.canvas) cc.canvas.width = cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

const ASSETS = () => new URL("/pdfjs/", self.location.href).href;

export async function openForRender(bytes: Uint8Array) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    CanvasFactory: OffscreenCanvasFactory as any,
    // Fonts are added to the worker's FontFaceSet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ownerDocument: self as any,
    isOffscreenCanvasSupported: true,
    standardFontDataUrl: ASSETS() + "standard_fonts/",
    cMapUrl: ASSETS() + "cmaps/",
    cMapPacked: true,
  });
  const doc = await task.promise;
  return Object.assign(doc, { close: () => void task.destroy() });
}

export async function renderPage(doc: pdfjs.PDFDocumentProxy, index: number, scale: (wPt: number, hPt: number) => number): Promise<ImageValue> {
  const page = await doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: scale(base.width, base.height) });
  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({ canvas: canvas as any, canvasContext: g as any, viewport }).promise;
  page.cleanup();
  return { kind: "image", width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}

/** First page of a document at thumbnail size, for node cards. */
export async function pdfThumbnail(d: DocumentValue, width = 480): Promise<ImageValue | undefined> {
  try {
    const doc = await openForRender(d.bytes);
    try {
      return await renderPage(doc, 0, (w) => width / w);
    } finally {
      doc.close();
    }
  } catch {
    return undefined;
  }
}
