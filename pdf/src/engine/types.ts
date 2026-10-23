// Plain data types for the PDF engine. Everything here is serialisable
// (bytes aside), so a plan can be stored, shared or produced by a pipeline.

export type Bytes = Uint8Array;

export type Rotation = 0 | 90 | 180 | 270;

/** RGB, each channel 0..1. */
export type Color = [number, number, number];

export interface PdfSource {
  kind: "pdf";
  bytes: Bytes;
  /** Needed to open an encrypted file. */
  password?: string;
}

export interface ImageSource {
  kind: "image";
  bytes: Bytes;
  mime: "image/png" | "image/jpeg";
}

/** An input document. An image counts as a one-page document. */
export type Source = PdfSource | ImageSource;

/**
 * A rectangle in visual page space: 0..1 of the page as it is displayed
 * (after rotation), origin at the top-left.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextOverlay {
  type: "text";
  /** Top-left corner of the first line, in visual page space. */
  x: number;
  y: number;
  text: string;
  /** Font size in points. */
  size: number;
  color: Color;
  opacity?: number;
}

export interface ImageOverlay {
  type: "image";
  box: Box;
  /** Index into Plan.images. */
  image: number;
  opacity?: number;
}

export interface RectOverlay {
  type: "rect";
  box: Box;
  fill?: Color;
  stroke?: Color;
  /** Points. */
  strokeWidth?: number;
  opacity?: number;
  /** Multiply makes highlights keep the text underneath readable. */
  blend?: "normal" | "multiply";
}

export interface InkOverlay {
  type: "ink";
  /** Polyline in visual page space. */
  points: [number, number][];
  color: Color;
  /** Points. */
  width: number;
  opacity?: number;
}

export type Overlay = TextOverlay | ImageOverlay | RectOverlay | InkOverlay;

/** One page of the output. */
export interface PageRef {
  /** Index into the sources array. */
  source: number;
  /** Zero-based page of that source (always 0 for an image). */
  page: number;
  /** Extra clockwise rotation on top of the page's own. */
  rotate?: Rotation;
  overlays?: Overlay[];
}

export type FieldValue = string | boolean | string[];

export interface Watermark {
  text: string;
  /** Points. */
  size: number;
  color: Color;
  opacity: number;
  /** Counter-clockwise degrees, as seen on the page. */
  angle: number;
}

export type NumberPosition =
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "top-left"
  | "top-center"
  | "top-right";

export interface PageNumbers {
  /** {n} is the page number, {total} the page count. */
  format: string;
  position: NumberPosition;
  size: number;
  color: Color;
  /** Number given to the first page. */
  start: number;
}

export interface Metadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
}

export interface Plan {
  pages: PageRef[];
  /** Images referenced by image overlays. */
  images?: { bytes: Bytes; mime: "image/png" | "image/jpeg" }[];
  /** Form values by source index, then by field name. */
  forms?: Record<number, Record<string, FieldValue>>;
  /** Bake form fields into the page so they can no longer be edited. */
  flattenForms?: boolean;
  watermark?: Watermark;
  pageNumbers?: PageNumbers;
  /** Fields left undefined keep the first document's value. */
  metadata?: Metadata;
  /**
   * A TrueType/OpenType font for text the standard Helvetica cannot encode
   * (anything outside Latin-1, e.g. ș ț). Embedded as a subset.
   */
  font?: Bytes;
}

export interface Protection {
  userPassword?: string;
  /** Defaults to the user password. */
  ownerPassword?: string;
  allowPrinting?: boolean;
  allowCopying?: boolean;
  allowModifying?: boolean;
}

export interface FieldInfo {
  name: string;
  type: "text" | "checkbox" | "radio" | "dropdown" | "list" | "button" | "signature" | "unknown";
  value: FieldValue;
  options?: string[];
  multiline?: boolean;
  readOnly: boolean;
}

export interface PageInfo {
  /** Visual size in points, after the page's own rotation. */
  width: number;
  height: number;
  rotation: Rotation;
}

export interface DocumentInfo {
  pageCount: number;
  pages: PageInfo[];
  fields: FieldInfo[];
  metadata: Metadata;
}

export interface RasterPage {
  /** JPEG or PNG bytes of the whole page. */
  bytes: Bytes;
  mime: "image/png" | "image/jpeg";
  /** Page size in points. */
  width: number;
  height: number;
}
