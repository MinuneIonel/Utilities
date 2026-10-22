// App state: the files that were added and the page list built from them.
// toPlan() turns it into the engine's plain Source[] + Plan.

import type {
  Bytes,
  Color,
  DocumentInfo,
  FieldValue,
  Metadata,
  Overlay,
  PageNumbers,
  Plan,
  Protection,
  Rotation,
  Source,
  Watermark,
} from "./engine";
import type { PdfHandle } from "./render";

export interface FileEntry {
  id: string;
  name: string;
  source: Source;
  info: DocumentInfo;
  /** pdf.js document, for PDFs. */
  handle?: PdfHandle;
  /** Decoded picture, for images. */
  bitmap?: ImageBitmap;
}

export interface PageItem {
  id: string;
  file: string;
  page: number;
  rotate: Rotation;
  overlays: Overlay[];
}

export interface OverlayImage {
  bytes: Bytes;
  mime: "image/png" | "image/jpeg";
  bitmap: ImageBitmap;
}

export interface Settings {
  watermark: Watermark & { enabled: boolean };
  numbers: PageNumbers & { enabled: boolean };
  metadata: Metadata;
  flattenForms: boolean;
  protection: Protection & { enabled: boolean };
  compress: { mode: "none" | "lossless" | "raster"; dpi: number; quality: number };
  split: { mode: "every" | "ranges"; n: number; ranges: string };
}

export const state = {
  files: [] as FileEntry[],
  pages: [] as PageItem[],
  selected: new Set<string>(),
  images: [] as OverlayImage[],
  forms: {} as Record<string, Record<string, FieldValue>>,
  settings: {
    watermark: {
      enabled: false,
      text: "CONFIDENTIAL",
      size: 64,
      color: [1, 0.23, 0.19],
      opacity: 0.2,
      angle: 45,
    },
    numbers: {
      enabled: false,
      format: "{n} / {total}",
      position: "bottom-center",
      size: 10,
      color: [0, 0, 0],
      start: 1,
    },
    metadata: {},
    flattenForms: false,
    protection: { enabled: false, allowPrinting: true, allowCopying: true, allowModifying: true },
    compress: { mode: "none", dpi: 125, quality: 0.7 },
    split: { mode: "every", n: 1, ranges: "" },
  } as Settings,
};

let seq = 0;
export const uid = (prefix: string) => `${prefix}${++seq}`;

export const fileById = (id: string) => state.files.find((f) => f.id === id);

// ---------------------------------------------------------------- change events

type Listener = () => void;
const listeners: Listener[] = [];
export const onChange = (fn: Listener) => listeners.push(fn);
export const changed = () => listeners.forEach((fn) => fn());

// ---------------------------------------------------------------- undo

// Snapshots of the page list. Overlays are plain data, so a JSON-ish clone
// is enough; images live in state.images and are only ever appended.
const past: PageItem[][] = [];
const future: PageItem[][] = [];
const snapshot = () => structuredClone(state.pages);

/** Call before changing the page list. */
export function checkpoint() {
  past.push(snapshot());
  if (past.length > 100) past.shift();
  future.length = 0;
}

export function undo(): boolean {
  const prev = past.pop();
  if (!prev) return false;
  future.push(snapshot());
  restore(prev);
  return true;
}

export function redo(): boolean {
  const next = future.pop();
  if (!next) return false;
  past.push(snapshot());
  restore(next);
  return true;
}

function restore(pages: PageItem[]) {
  // A file may have been removed since the snapshot.
  state.pages = pages.filter((p) => fileById(p.file));
  const ids = new Set(state.pages.map((p) => p.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  changed();
}

// ---------------------------------------------------------------- plan

const isLatin1 = (s: string) => /^[\x00-\xff]*$/.test(s);

/** Texts the plan will draw, to decide whether a Unicode font is needed. */
export function planTexts(plan: Plan): string[] {
  const out: string[] = [];
  for (const p of plan.pages) for (const o of p.overlays ?? []) if (o.type === "text") out.push(o.text);
  if (plan.watermark) out.push(plan.watermark.text);
  if (plan.pageNumbers) out.push(plan.pageNumbers.format);
  for (const values of Object.values(plan.forms ?? {})) {
    for (const v of Object.values(values)) if (typeof v === "string") out.push(v);
  }
  return out;
}

export const needsUnicode = (plan: Plan) => planTexts(plan).some((t) => !isLatin1(t));

export function toPlan(pages = state.pages): { sources: Source[]; plan: Plan } {
  const used = state.files.filter((f) => pages.some((p) => p.file === f.id));
  const index = new Map(used.map((f, i) => [f.id, i]));
  const s = state.settings;
  const forms: Plan["forms"] = {};
  for (const [fileId, values] of Object.entries(state.forms)) {
    const i = index.get(fileId);
    if (i !== undefined && Object.keys(values).length) forms[i] = values;
  }
  const { enabled: wmOn, ...watermark } = s.watermark;
  const { enabled: pnOn, ...numbers } = s.numbers;
  return {
    sources: used.map((f) => f.source),
    plan: {
      pages: pages.map((p) => ({
        source: index.get(p.file)!,
        page: p.page,
        rotate: p.rotate,
        overlays: p.overlays,
      })),
      images: state.images.map(({ bytes, mime }) => ({ bytes, mime })),
      forms,
      flattenForms: s.flattenForms,
      watermark: wmOn && watermark.text.trim() ? watermark : undefined,
      pageNumbers: pnOn ? numbers : undefined,
      metadata: s.metadata,
    },
  };
}

// ---------------------------------------------------------------- colors

export const toHex = (c: Color) =>
  "#" +
  c
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

export const fromHex = (hex: string): Color => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const cssColor = (c: Color, alpha = 1) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`;

/** Size in points of a page as it will be displayed. */
export function pageSize(item: PageItem): { width: number; height: number } {
  const info = fileById(item.file)!.info.pages[item.page];
  return item.rotate % 180 === 0
    ? { width: info.width, height: info.height }
    : { width: info.height, height: info.width };
}
