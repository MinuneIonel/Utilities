// The PDF engine: bytes in, bytes out, no DOM. Built on pdf-lib
// (the maintained @cantoo fork, which adds encryption).

import {
  BlendMode,
  LineCapStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFPageLeaf,
  PDFPage,
  PDFRadioGroup,
  PDFSignature,
  PDFButton,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFField,
  type PDFImage,
  type PDFRef,
} from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";
import { normRotation, toPdf, visualSize, type PageFrame } from "./geometry";
import type {
  Bytes,
  Color,
  DocumentInfo,
  FieldInfo,
  FieldValue,
  ImageSource,
  Metadata,
  Overlay,
  PageNumbers,
  Plan,
  Protection,
  RasterPage,
  Source,
  Watermark,
} from "./types";

const PRODUCER = "Utilities PDF Lab";
/** CSS pixels to points, so a 96 dpi image keeps its size on screen. */
const PX_TO_PT = 0.75;

const color = (c: Color) => rgb(c[0], c[1], c[2]);

export async function openPdf(bytes: Bytes, password?: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { password, updateMetadata: false });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/encrypt|password/i.test(msg)) {
      throw new PasswordError(password ? "Wrong password" : "This PDF needs a password");
    }
    throw err;
  }
}

export class PasswordError extends Error {
  readonly needsPassword = true;
}

// ---------------------------------------------------------------- inspect

export async function inspect(source: Source): Promise<DocumentInfo> {
  if (source.kind === "image") {
    const doc = await PDFDocument.create();
    const img = await embedImage(doc, source);
    return {
      pageCount: 1,
      pages: [{ width: img.width * PX_TO_PT, height: img.height * PX_TO_PT, rotation: 0 }],
      fields: [],
      metadata: {},
    };
  }
  const doc = await openPdf(source.bytes, source.password);
  const pages = doc.getPages().map((p) => {
    const box = p.getCropBox();
    const rotation = normRotation(p.getRotation().angle);
    const swap = rotation % 180 !== 0;
    return { width: swap ? box.height : box.width, height: swap ? box.width : box.height, rotation };
  });
  const keywords = doc.getKeywords();
  return {
    pageCount: doc.getPageCount(),
    pages,
    fields: doc.getForm().getFields().map(fieldInfo),
    metadata: {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: keywords ? keywords.split(/\s*[,;]\s*|\s+/).filter(Boolean) : undefined,
    },
  };
}

function fieldInfo(f: PDFField): FieldInfo {
  const base = { name: f.getName(), readOnly: f.isReadOnly() };
  if (f instanceof PDFTextField) {
    return { ...base, type: "text", value: f.getText() ?? "", multiline: f.isMultiline() };
  }
  if (f instanceof PDFCheckBox) return { ...base, type: "checkbox", value: f.isChecked() };
  if (f instanceof PDFRadioGroup) {
    return { ...base, type: "radio", value: f.getSelected() ?? "", options: f.getOptions() };
  }
  if (f instanceof PDFDropdown) {
    return { ...base, type: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions() };
  }
  if (f instanceof PDFOptionList) {
    return { ...base, type: "list", value: f.getSelected(), options: f.getOptions() };
  }
  if (f instanceof PDFButton) return { ...base, type: "button", value: "" };
  if (f instanceof PDFSignature) return { ...base, type: "signature", value: "" };
  return { ...base, type: "unknown", value: "" };
}

// ---------------------------------------------------------------- build

/**
 * Assemble the output document: pick, order and rotate pages from any number
 * of sources, fill forms, and draw overlays, watermark and page numbers.
 *
 * Form fields stay editable on pages taken from the first page's document;
 * forms in the other documents are flattened, since a merged PDF can only
 * carry one form.
 */
export async function build(sources: Source[], plan: Plan): Promise<Bytes> {
  if (plan.pages.length === 0) throw new Error("The document has no pages");
  for (const ref of plan.pages) {
    const src = sources[ref.source];
    if (!src) throw new Error(`Page refers to missing source ${ref.source}`);
  }

  const docs = new Map<number, PDFDocument>();
  const load = async (i: number) => {
    let d = docs.get(i);
    if (!d) {
      const src = sources[i] as Extract<Source, { kind: "pdf" }>;
      d = await openPdf(src.bytes, src.password);
      d.registerFontkit(fontkit);
      docs.set(i, d);
    }
    return d;
  };

  const first = plan.pages[0];
  const baseIndex = sources[first.source].kind === "pdf" ? first.source : -1;
  const out = baseIndex >= 0 ? await load(baseIndex) : await PDFDocument.create();
  out.registerFontkit(fontkit);
  const fonts = new FontBox(out, plan.font);

  // Forms are filled in their own documents, before pages are copied out.
  const usedSources = new Set(plan.pages.map((p) => p.source));
  for (const i of usedSources) {
    if (sources[i].kind !== "pdf") continue;
    const doc = await load(i);
    const form = doc.getForm();
    const values = plan.forms?.[i];
    if (values) fillForm(doc, values);
    if (form.getFields().length === 0) continue;
    if (plan.flattenForms || i !== baseIndex) {
      await refreshAppearances(doc, values, plan.font);
      form.flatten();
    } else if (values) {
      await refreshAppearances(doc, values, plan.font);
    }
  }

  const basePages = out.getPages();
  const taken = new Set<number>();
  const pages: PDFPage[] = [];
  for (const ref of plan.pages) {
    const src = sources[ref.source];
    let page: PDFPage;
    if (src.kind === "image") {
      page = await imagePage(out, src);
    } else if (ref.source === baseIndex && !taken.has(ref.page)) {
      taken.add(ref.page);
      page = basePages[ref.page];
      if (!page) throw new Error(`Page ${ref.page + 1} does not exist`);
    } else {
      const doc = await load(ref.source);
      if (ref.page >= doc.getPageCount()) throw new Error(`Page ${ref.page + 1} does not exist`);
      [page] = await out.copyPages(doc, [ref.page]);
    }
    if (ref.rotate) page.setRotation(degrees(normRotation(page.getRotation().angle + ref.rotate)));
    pages.push(page);
  }

  // Rebuild the page tree in the new order. pdf-lib deletes a removed page's
  // object, so re-register it, and pin inherited attributes on the page first
  // because the tree nodes it inherited them from may be pruned.
  for (const p of pages) pinInherited(p);
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const p of pages) {
    out.context.assign(p.ref, p.node);
    out.addPage(p);
  }
  if (baseIndex >= 0) dropOrphanFields(out);

  const images = new Map<number, PDFImage>();
  const image = async (i: number) => {
    let img = images.get(i);
    if (!img) {
      const src = plan.images?.[i];
      if (!src) throw new Error(`Overlay refers to missing image ${i}`);
      img = await embedImage(out, src);
      images.set(i, img);
    }
    return img;
  };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    for (const o of plan.pages[i].overlays ?? []) await drawOverlay(page, o, fonts, image);
    if (plan.watermark?.text) await drawWatermark(page, plan.watermark, fonts);
    if (plan.pageNumbers) await drawPageNumber(page, plan.pageNumbers, i, pages.length, fonts);
  }

  applyMetadata(out, plan.metadata);
  return out.save({ useObjectStreams: true });
}

function pinInherited(page: PDFPage) {
  for (const key of PDFPageLeaf.InheritableEntries) {
    const name = PDFName.of(key);
    if (page.node.get(name)) continue;
    const value = page.node.getInheritableAttribute(name);
    if (value) page.node.set(name, value);
  }
}

/** Remove fields whose widgets all sat on pages that were dropped. */
function dropOrphanFields(doc: PDFDocument) {
  const form = doc.getForm();
  const kept = new Set<PDFRef>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (ref && "objectNumber" in ref) kept.add(ref as PDFRef);
    }
  }
  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    const onPage = widgets.some((w) => {
      const ref = doc.context.getObjectRef(w.dict);
      return ref !== undefined && kept.has(ref);
    });
    if (!onPage) form.acroForm.removeField(field.acroField);
  }
}

function fillForm(doc: PDFDocument, values: Record<string, FieldValue>) {
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    if (f instanceof PDFTextField) f.setText(String(value ?? ""));
    else if (f instanceof PDFCheckBox) value ? f.check() : f.uncheck();
    else if (f instanceof PDFRadioGroup) value ? f.select(String(value)) : f.clear();
    else if (f instanceof PDFDropdown) value ? f.select(String(value)) : f.clear();
    else if (f instanceof PDFOptionList) {
      const list = Array.isArray(value) ? value : value ? [String(value)] : [];
      if (list.length) f.select(list);
      else f.clear();
    }
  }
}

/** Text outside Latin-1 needs a real font to draw field appearances. */
async function refreshAppearances(
  doc: PDFDocument,
  values: Record<string, FieldValue> | undefined,
  fontBytes: Bytes | undefined,
) {
  const needsUnicode = Object.values(values ?? {}).some((v) => typeof v === "string" && !isLatin1(v));
  if (!needsUnicode) {
    doc.getForm().updateFieldAppearances();
    return;
  }
  if (!fontBytes) throw new Error("Form text has characters that need a Unicode font");
  doc.getForm().updateFieldAppearances(await doc.embedFont(fontBytes, { subset: true }));
}

async function imagePage(doc: PDFDocument, src: ImageSource): Promise<PDFPage> {
  const img = await embedImage(doc, src);
  const w = img.width * PX_TO_PT;
  const h = img.height * PX_TO_PT;
  const page = PDFPage.create(doc);
  page.setSize(w, h);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return page;
}

function embedImage(doc: PDFDocument, src: Pick<ImageSource, "bytes" | "mime">) {
  return src.mime === "image/png" ? doc.embedPng(src.bytes) : doc.embedJpg(src.bytes);
}

// ---------------------------------------------------------------- drawing

const isLatin1 = (s: string) => /^[\x00-\xff]*$/.test(s);

/** Helvetica when it can encode the text, the supplied Unicode font otherwise. */
class FontBox {
  private helv?: Promise<PDFFont>;
  private uni?: Promise<PDFFont>;
  constructor(
    private doc: PDFDocument,
    private bytes?: Bytes,
  ) {}

  for(text: string): Promise<PDFFont> {
    if (isLatin1(text)) return (this.helv ??= this.doc.embedFont(StandardFonts.Helvetica));
    if (!this.bytes) {
      throw new Error(`"${text.slice(0, 20)}" has characters that need a Unicode font`);
    }
    return (this.uni ??= this.doc.embedFont(this.bytes, { subset: true }));
  }
}

function frameOf(page: PDFPage): PageFrame {
  const box = page.getCropBox();
  return {
    x0: box.x,
    y0: box.y,
    width: box.width,
    height: box.height,
    rotation: normRotation(page.getRotation().angle),
  };
}

/**
 * Draw one line of text with its baseline at visual point (u, v), aligned
 * around that point and turned `angle` degrees counter-clockwise as seen.
 */
function drawLine(
  page: PDFPage,
  text: string,
  font: PDFFont,
  u: number,
  v: number,
  opts: {
    size: number;
    color: Color;
    opacity?: number;
    angle?: number;
    align?: "left" | "center" | "right";
    middle?: boolean;
  },
) {
  const f = frameOf(page);
  const theta = f.rotation + (opts.angle ?? 0);
  const rad = (theta * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const up = { x: -dir.y, y: dir.x };
  const width = font.widthOfTextAtSize(text, opts.size);
  const shift = opts.align === "center" ? width / 2 : opts.align === "right" ? width : 0;
  const lift = opts.middle ? font.heightAtSize(opts.size, { descender: false }) / 2 : 0;
  const p = toPdf(f, u, v);
  page.drawText(text, {
    x: p.x - dir.x * shift - up.x * lift,
    y: p.y - dir.y * shift - up.y * lift,
    size: opts.size,
    font,
    color: color(opts.color),
    opacity: opts.opacity ?? 1,
    rotate: degrees(theta),
  });
}

async function drawOverlay(
  page: PDFPage,
  o: Overlay,
  fonts: FontBox,
  image: (i: number) => Promise<PDFImage>,
) {
  const f = frameOf(page);
  const vis = visualSize(f);
  if (o.type === "text") {
    const font = await fonts.for(o.text);
    const ascent = font.heightAtSize(o.size, { descender: false });
    const lineHeight = o.size * 1.2;
    o.text.split("\n").forEach((line, i) => {
      if (!line) return;
      const v = o.y + (ascent + i * lineHeight) / vis.height;
      drawLine(page, line, font, o.x, v, { size: o.size, color: o.color, opacity: o.opacity });
    });
    return;
  }
  if (o.type === "ink") {
    if (o.points.length < 2) return;
    const pts = o.points.map(([u, v]) => toPdf(f, u, v));
    for (let i = 1; i < pts.length; i++) {
      page.drawLine({
        start: pts[i - 1],
        end: pts[i],
        thickness: o.width,
        color: color(o.color),
        opacity: o.opacity ?? 1,
        lineCap: LineCapStyle.Round,
      });
    }
    return;
  }
  // Boxes are anchored at their visual bottom-left and turned with the page.
  const anchor = toPdf(f, o.box.x, o.box.y + o.box.h);
  const width = o.box.w * vis.width;
  const height = o.box.h * vis.height;
  const rotate = degrees(f.rotation);
  if (o.type === "image") {
    page.drawImage(await image(o.image), { ...anchor, width, height, rotate, opacity: o.opacity ?? 1 });
    return;
  }
  page.drawRectangle({
    ...anchor,
    width,
    height,
    rotate,
    color: o.fill ? color(o.fill) : undefined,
    borderColor: o.stroke ? color(o.stroke) : undefined,
    borderWidth: o.stroke ? (o.strokeWidth ?? 1) : 0,
    opacity: o.opacity ?? 1,
    borderOpacity: o.opacity ?? 1,
    blendMode: o.blend === "multiply" ? BlendMode.Multiply : undefined,
  });
}

async function drawWatermark(page: PDFPage, w: Watermark, fonts: FontBox) {
  const font = await fonts.for(w.text);
  drawLine(page, w.text, font, 0.5, 0.5, {
    size: w.size,
    color: w.color,
    opacity: w.opacity,
    angle: w.angle,
    align: "center",
    middle: true,
  });
}

async function drawPageNumber(page: PDFPage, n: PageNumbers, index: number, count: number, fonts: FontBox) {
  const text = n.format
    .replaceAll("{n}", String(n.start + index))
    .replaceAll("{total}", String(n.start + count - 1));
  const font = await fonts.for(text);
  const vis = visualSize(frameOf(page));
  const margin = 28; // points
  const [vert, horiz] = n.position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  const u = horiz === "left" ? margin / vis.width : horiz === "right" ? 1 - margin / vis.width : 0.5;
  const v = vert === "top" ? (margin + n.size) / vis.height : 1 - margin / vis.height;
  drawLine(page, text, font, u, v, { size: n.size, color: n.color, align: horiz });
}

function applyMetadata(doc: PDFDocument, m: Metadata | undefined) {
  if (m?.title !== undefined) doc.setTitle(m.title);
  if (m?.author !== undefined) doc.setAuthor(m.author);
  if (m?.subject !== undefined) doc.setSubject(m.subject);
  if (m?.keywords !== undefined) doc.setKeywords(m.keywords);
  doc.setProducer(PRODUCER);
  doc.setModificationDate(new Date());
}

// ---------------------------------------------------------------- whole-file tools

/** One output file per group of zero-based page indexes. */
export async function split(bytes: Bytes, groups: number[][], password?: string): Promise<Bytes[]> {
  const src = await openPdf(bytes, password);
  const out: Bytes[] = [];
  for (const group of groups) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, group);
    pages.forEach((p) => doc.addPage(p));
    const title = src.getTitle();
    if (title) doc.setTitle(title);
    doc.setProducer(PRODUCER);
    out.push(await doc.save({ useObjectStreams: true }));
  }
  return out;
}

/** Add a password and permissions. */
export async function protect(bytes: Bytes, p: Protection): Promise<Bytes> {
  const doc = await openPdf(bytes);
  const owner = p.ownerPassword || p.userPassword;
  if (!owner) throw new Error("Set a password");
  doc.encrypt({
    userPassword: p.userPassword ?? "",
    ownerPassword: owner,
    permissions: {
      printing: p.allowPrinting === false ? false : "highResolution",
      copying: p.allowCopying !== false,
      modifying: p.allowModifying !== false,
      annotating: p.allowModifying !== false,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: p.allowModifying !== false,
    },
  });
  return doc.save({ useObjectStreams: false });
}

/**
 * Lossless size reduction: rewrite with object streams and drop unused
 * objects. Helps most on files saved by editors that append changes.
 */
export async function compact(bytes: Bytes): Promise<Bytes> {
  const doc = await openPdf(bytes);
  const fresh = await PDFDocument.create();
  const pages = await fresh.copyPages(doc, doc.getPageIndices());
  pages.forEach((p) => fresh.addPage(p));
  copyInfo(doc, fresh);
  const out = await fresh.save({ useObjectStreams: true });
  return out.length < bytes.length ? out : bytes;
}

/**
 * Build a PDF where every page is one picture. Paired with a renderer this
 * gives lossy compression (or "print to image" to strip text and layers).
 */
export async function fromRaster(pages: RasterPage[], metadata?: Metadata): Promise<Bytes> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const img = await embedImage(doc, p);
    const page = doc.addPage([p.width, p.height]);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
  }
  applyMetadata(doc, metadata);
  return doc.save({ useObjectStreams: true });
}

function copyInfo(from: PDFDocument, to: PDFDocument) {
  const keywords = from.getKeywords();
  applyMetadata(to, {
    title: from.getTitle(),
    author: from.getAuthor(),
    subject: from.getSubject(),
    keywords: keywords ? [keywords] : undefined,
  });
  const creator = from.getCreator();
  if (creator) to.setCreator(creator);
}
