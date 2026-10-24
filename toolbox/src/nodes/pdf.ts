// PDF nodes over PDF Lab's engine (pdf-lib), plus pdf.js for turning pages into images.
// Both load on first use (pdf-render.ts holds the pdf.js side), so the window never parses them.
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import type { NumberPosition, Plan, RasterPage, Source } from "../../../pdf/src/engine";
import { parseRanges } from "../../../pdf/src/engine/ranges";
import type { Converter, DocumentValue, FileValue, FrameItem, ImageValue, NodeDef, Value, VideoValue } from "../runtime/types";
import { encodeImage } from "./image";
import { frameImage } from "./video";

/** PDF Lab's engine (pdf-lib), loaded on first use. */
const engine = () => import("../../../pdf/src/engine");
/** pdf.js, loaded on first use. */
export const pdfRender = () => import("./pdf-render");

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const baseName = (n: string) => n.replace(/\.pdf$/i, "") || "document";

async function documentOf(name: string, bytes: Uint8Array): Promise<DocumentValue> {
  const { inspect, PasswordError } = await engine();
  try {
    const info = await inspect({ kind: "pdf", bytes });
    return { kind: "document", name, bytes, pageCount: info.pageCount };
  } catch (e) {
    if (e instanceof PasswordError) throw new Error("This PDF has a password. Remove it in PDF Lab first.");
    throw e;
  }
}

const allPages = (docs: DocumentValue[]) => docs.flatMap((d, source) => Array.from({ length: d.pageCount }, (_, page) => ({ source, page })));

let font: Promise<Uint8Array> | undefined;
/** DejaVu Sans, for stamps outside Latin-1 (ș, ț). */
const loadFont = () =>
  (font ??= fetch(fontUrl)
    .then((r) => {
      if (!r.ok) throw new Error("Couldn't load the font");
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b))
    .catch((e) => {
      font = undefined;
      throw e;
    }));

export const pdfInput: NodeDef = {
  type: "input.pdf",
  title: "PDF file",
  category: "input",
  description: "A PDF dropped into Toolbox.",
  inputs: [],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [],
  defaults: () => ({ assetId: "", name: "" }),
  kind: "frame",
  async run(_inputs, params, ctx) {
    const blob = ctx.assets.get(String(params.assetId));
    if (!blob) throw new Error("Drop a PDF here");
    return { document: await documentOf(String(params.name || "document.pdf"), new Uint8Array(await blob.arrayBuffer())) };
  },
};

export const pdfMerge: NodeDef = {
  type: "pdf.merge",
  title: "Merge PDFs",
  category: "pdf",
  description: "Joins documents in order: A, then B, then C and D if connected.",
  inputs: [
    { key: "a", label: "A", type: "document" },
    { key: "b", label: "B", type: "document" },
    { key: "c", label: "C", type: "document", optional: true },
    { key: "d", label: "D", type: "document", optional: true },
  ],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [{ key: "name", label: "File name", kind: "text" }],
  defaults: () => ({ name: "merged" }),
  kind: "frame",
  async run(inputs, params) {
    const docs = ["a", "b", "c", "d"].map((k) => inputs[k] as DocumentValue | undefined).filter((d): d is DocumentValue => !!d);
    const sources: Source[] = docs.map((d) => ({ kind: "pdf", bytes: d.bytes }));
    const bytes = await (await engine()).build(sources, { pages: allPages(docs) });
    return { document: { kind: "document", name: `${params.name || "merged"}.pdf`, bytes, pageCount: allPages(docs).length } };
  },
};

export const pdfPages: NodeDef = {
  type: "pdf.pages",
  title: "Pick pages",
  category: "pdf",
  description: "Keeps, reorders or repeats pages (e.g. \"1-3, 5, 9-\"), and rotates them.",
  inputs: [{ key: "document", label: "Document", type: "document" }],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [
    { key: "pages", label: "Pages (empty = all)", kind: "text" },
    {
      key: "rotate",
      label: "Rotate",
      kind: "select",
      options: [
        { value: "0", label: "None" },
        { value: "90", label: "90° right" },
        { value: "180", label: "180°" },
        { value: "270", label: "90° left" },
      ],
    },
  ],
  defaults: () => ({ pages: "", rotate: "0" }),
  kind: "frame",
  async run(inputs, params) {
    const d = inputs.document as DocumentValue;
    const spec = String(params.pages ?? "").trim();
    const picked = spec ? parseRanges(spec, d.pageCount) : allPages([d]).map((p) => p.page);
    if (!picked.length) throw new Error("No pages picked");
    const rotate = num(params.rotate, 0) as 0 | 90 | 180 | 270;
    const bytes = await (await engine()).build([{ kind: "pdf", bytes: d.bytes }], { pages: picked.map((page) => ({ source: 0, page, rotate })) });
    return { document: { ...d, bytes, pageCount: picked.length } };
  },
};

const POSITIONS: NumberPosition[] = ["bottom-center", "bottom-right", "bottom-left", "top-center", "top-right", "top-left"];

export const pdfStamp: NodeDef = {
  type: "pdf.stamp",
  title: "Watermark / numbers",
  category: "pdf",
  description: "Adds a diagonal watermark and page numbers to every page.",
  inputs: [{ key: "document", label: "Document", type: "document" }],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [
    { key: "watermark", label: "Watermark text", kind: "text" },
    { key: "size", label: "Watermark size pt", kind: "number", min: 12, max: 200, step: 1 },
    { key: "opacity", label: "Watermark opacity %", kind: "number", min: 5, max: 100, step: 1 },
    { key: "numbers", label: "Page numbers", kind: "toggle" },
    { key: "format", label: "Number format", kind: "text" },
    { key: "position", label: "Number position", kind: "select", options: POSITIONS.map((p) => ({ value: p, label: p.replace("-", " ") })) },
  ],
  defaults: () => ({ watermark: "DRAFT", size: 72, opacity: 20, numbers: true, format: "{n} / {total}", position: "bottom-center" }),
  visible: (key, p) => !(key === "format" || key === "position") || p.numbers === true,
  kind: "frame",
  async run(inputs, params) {
    const d = inputs.document as DocumentValue;
    const text = String(params.watermark ?? "").trim();
    const plan: Plan = { pages: allPages([d]), font: await loadFont() };
    if (text) plan.watermark = { text, size: num(params.size, 72), color: [0.8, 0.1, 0.1], opacity: num(params.opacity, 20) / 100, angle: 45 };
    if (params.numbers === true)
      plan.pageNumbers = {
        format: String(params.format || "{n}"),
        position: (POSITIONS.includes(params.position as NumberPosition) ? params.position : "bottom-center") as NumberPosition,
        size: 10,
        color: [0.2, 0.2, 0.2],
        start: 1,
      };
    return { document: { ...d, bytes: await (await engine()).build([{ kind: "pdf", bytes: d.bytes }], plan) } };
  },
};

export const pdfProtect: NodeDef = {
  type: "pdf.protect",
  title: "Protect PDF",
  category: "pdf",
  description: "Adds a password and limits printing, copying or editing. Runs on Render.",
  inputs: [{ key: "document", label: "Document", type: "document" }],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [
    { key: "password", label: "Password to open", kind: "text" },
    { key: "owner", label: "Owner password", kind: "text" },
    { key: "print", label: "Allow printing", kind: "toggle" },
    { key: "copy", label: "Allow copying", kind: "toggle" },
    { key: "modify", label: "Allow editing", kind: "toggle" },
  ],
  defaults: () => ({ password: "", owner: "", print: true, copy: false, modify: false }),
  kind: "job",
  async run(inputs, params) {
    const d = inputs.document as DocumentValue;
    const bytes = await (await engine()).protect(d.bytes, {
      userPassword: String(params.password ?? "") || undefined,
      ownerPassword: String(params.owner ?? "") || undefined,
      allowPrinting: params.print === true,
      allowCopying: params.copy === true,
      allowModifying: params.modify === true,
    });
    return { document: { ...d, bytes } };
  },
};

export const pdfCompact: NodeDef = {
  type: "pdf.compact",
  title: "Compact PDF",
  category: "pdf",
  description: "Rewrites the file with compressed object streams. Runs on Render.",
  inputs: [{ key: "document", label: "Document", type: "document" }],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [],
  defaults: () => ({}),
  kind: "job",
  async run(inputs) {
    const d = inputs.document as DocumentValue;
    return { document: { ...d, bytes: await (await engine()).compact(d.bytes) } };
  },
};

export const imagesToPdf: NodeDef = {
  type: "pdf.from-images",
  title: "Images to PDF",
  category: "pdf",
  description: "One page per image. Wire in a video or PDF pages to get one page per frame. Runs on Render.",
  inputs: [{ key: "pages", label: "Pages", type: "image", sequence: true }],
  outputs: [{ key: "document", label: "Document", type: "document" }],
  params: [
    { key: "dpi", label: "Resolution DPI", kind: "number", min: 36, max: 600, step: 1 },
    { key: "quality", label: "JPEG quality", kind: "number", min: 10, max: 100, step: 1 },
    { key: "every", label: "Every n-th frame", kind: "number", min: 1, max: 1000, step: 1 },
    { key: "max", label: "Most pages", kind: "number", min: 1, max: 2000, step: 1 },
    { key: "name", label: "File name", kind: "text" },
  ],
  defaults: () => ({ dpi: 150, quality: 85, every: 1, max: 200, name: "images" }),
  kind: "job",
  async run(inputs, params, ctx) {
    const v = inputs.pages as Value;
    const dpi = num(params.dpi, 150);
    const every = Math.max(1, Math.floor(num(params.every, 1)));
    const max = Math.max(1, Math.floor(num(params.max, 200)));
    const pages: RasterPage[] = [];
    const add = async (img: ImageValue) =>
      pages.push({ bytes: await encodeImage(img, "image/jpeg", num(params.quality, 85) / 100), mime: "image/jpeg" as const, width: (img.width * 72) / dpi, height: (img.height * 72) / dpi });
    if (v.kind === "video") {
      let i = 0;
      for await (const f of v.frames(ctx.signal)) {
        if (ctx.signal?.aborted) throw new Error("Cancelled");
        if (i++ % every) continue;
        await add(frameImage(f.value));
        if (v.duration > 0) ctx.progress?.(Math.min(0.99, f.timestamp / v.duration), `Page ${pages.length}`);
        if (pages.length >= max) break;
      }
      if (ctx.signal?.aborted) throw new Error("Cancelled");
    } else await add(frameImage(v));
    if (!pages.length) throw new Error("No pages");
    const bytes = await (await engine()).fromRaster(pages);
    return { document: { kind: "document", name: `${params.name || "images"}.pdf`, bytes, pageCount: pages.length } };
  },
};

export const pdfToImages: NodeDef = {
  type: "pdf.to-images",
  title: "Pages to images",
  category: "pdf",
  description: "Every page as an image, one per second, like a video. Image nodes after it run on every page.",
  inputs: [{ key: "document", label: "Document", type: "document" }],
  outputs: [{ key: "pages", label: "Pages", type: "video" }],
  params: [
    { key: "page", label: "Preview page", kind: "number", min: 1, max: 999, step: 1 },
    { key: "dpi", label: "Resolution DPI", kind: "number", min: 36, max: 600, step: 1 },
  ],
  defaults: () => ({ page: 1, dpi: 150 }),
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  async run(inputs, params, ctx) {
    const d = inputs.document as DocumentValue;
    const dpi = num(params.dpi, 150);
    const at = Math.min(d.pageCount, Math.max(1, Math.floor(num(params.page, 1)))) - 1;
    const { openForRender, renderPage } = await pdfRender();
    const doc = await openForRender(d.bytes);
    // Preview pages fit in the preview size; render pages use the DPI.
    const full = (w: number) => Math.min(dpi / 72, 8000 / w);
    let ratio = 1;
    const poster = await renderPage(doc, at, (w, h) => {
      if (ctx.mode !== "preview") return full(w);
      const s = Math.min(full(w), 1280 / Math.max(w, h));
      ratio = s / full(w);
      return s;
    });
    poster.scale = ratio;
    doc.close();
    const video: VideoValue = {
      kind: "video",
      of: "image",
      width: Math.round(poster.width / (poster.scale ?? 1)),
      height: Math.round(poster.height / (poster.scale ?? 1)),
      duration: d.pageCount,
      fps: 1,
      poster,
      async *frames(signal) {
        const doc = await openForRender(d.bytes);
        try {
          for (let i = 0; i < d.pageCount; i++) {
            if (signal?.aborted) return;
            const value = await renderPage(doc, i, full);
            yield { value, timestamp: i, duration: 1 } satisfies FrameItem;
          }
        } finally {
          doc.close();
        }
      },
    };
    return { pages: video };
  },
};

export const PDF_CONVERTERS: Converter[] = [
  {
    from: "document",
    to: "file",
    label: "pdf",
    async convert(v) {
      const d = v as DocumentValue;
      const f: FileValue = { kind: "file", name: /\.pdf$/i.test(d.name) ? d.name : `${baseName(d.name)}.pdf`, mime: "application/pdf", bytes: d.bytes };
      return f;
    },
  },
];
