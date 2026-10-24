import { convert } from "../../../ascii/src/engine/convert";
import { toAnsi, toHtml, toSvg, toText } from "../../../ascii/src/engine/export";
import { FONTS, parseSettings, type Settings } from "../../../ascii/src/engine/settings";
import { builtInPresets } from "../../../ascii/src/presets";
import { Renderer, inkIsDark } from "../../../ascii/src/render";
import type { Converter, GridValue, ImageValue, NodeDef, TextValue } from "../runtime/types";
import { preferGpu } from "./gpu";
import { scaleImage } from "./image";

/** Same cap as ASCII Lab. */
const MAX_ROWS = 600;

// One renderer per thread: it caches the glyph atlas between runs.
let renderer: Renderer | undefined;
const getRenderer = () => (renderer ??= new Renderer());

const fontFamily = (s: Settings) => FONTS.find((f) => f.id === s.font)?.css ?? FONTS[0].css;

export function gridToImage(v: GridValue, scale = 1): ImageValue {
  const r = getRenderer();
  const L = r.layout(v.settings, scale);
  const c = new OffscreenCanvas(1, 1);
  r.draw(c, v.grid, v.settings, L);
  const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  return { kind: "image", width: c.width, height: c.height, data };
}

export function gridToText(v: GridValue, format: "plain" | "html" | "ansi" | "svg"): TextValue {
  const { grid, glyphs, settings } = v;
  if (format === "html") return { kind: "text", format, text: toHtml(grid, glyphs, settings, fontFamily(settings)) };
  if (format === "ansi") return { kind: "text", format, text: toAnsi(grid, glyphs, settings) };
  if (format === "svg") {
    const L = getRenderer().layout(settings);
    return { kind: "text", format, text: toSvg(grid, glyphs, settings, fontFamily(settings), L.cellW, L.cellH) };
  }
  return { kind: "text", format: "plain", text: toText(grid, glyphs) };
}

export const asciiConvert: NodeDef = {
  type: "ascii.convert",
  title: "ASCII",
  category: "image",
  description: "ASCII Lab: turns an image into a grid of characters. Wire it to an image input to draw it, or to text to export it.",
  inputs: [{ key: "image", label: "Image", type: "image" }],
  outputs: [{ key: "grid", label: "Grid", type: "grid" }],
  params: [{ key: "settings", label: "Settings", kind: "custom" }],
  defaults: () => ({ settings: builtInPresets()[0] }),
  kind: "frame",
  async run(inputs, params) {
    const src = inputs.image as ImageValue;
    const s = parseSettings(params.settings);
    const L = getRenderer().layout(s);
    const cols = s.columns;
    // Characters are taller than they are wide, so fewer rows keep the picture's proportions.
    const rows = Math.max(1, Math.min(MAX_ROWS, Math.round((cols * src.height * L.cellW) / (src.width * L.cellH))));
    const sx = s.mode === "braille" ? 2 : 1;
    const sy = s.mode === "braille" ? 4 : 1;
    const sw = cols * sx;
    const sh = rows * sy;
    // Shrinking a full frame to one sample per character is the expensive part; the rest is a few thousand cells.
    const sample = await preferGpu(
      async (g) => (g.dither.fits(sw, sh, src.width, src.height) ? g.dither.resize(src.data, src.width, src.height, sw, sh) : undefined),
      () => scaleImage(src, sw, sh, true).data,
    );
    const grid = convert(sample, cols, rows, s, L.levels, inkIsDark(s));
    return { grid: { kind: "grid", grid, settings: s, glyphs: L.glyphs } };
  },
};

export const asciiRender: NodeDef = {
  type: "ascii.render",
  title: "Draw ASCII",
  category: "image",
  description: "Draws a character grid as an image, with the font and colours from the ASCII node.",
  inputs: [{ key: "grid", label: "Grid", type: "grid" }],
  outputs: [{ key: "image", label: "Image", type: "image" }],
  params: [{ key: "scale", label: "Scale", kind: "number", min: 1, max: 4, step: 1 }],
  defaults: () => ({ scale: 1 }),
  kind: "frame",
  async run(inputs, params) {
    return { image: gridToImage(inputs.grid as GridValue, Number(params.scale) || 1) };
  },
};

export const asciiText: NodeDef = {
  type: "ascii.text",
  title: "ASCII to text",
  category: "text",
  description: "Exports a character grid as plain text, HTML, ANSI (coloured terminal text) or SVG.",
  inputs: [{ key: "grid", label: "Grid", type: "grid" }],
  outputs: [{ key: "text", label: "Text", type: "text" }],
  params: [
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "plain", label: "Plain text" },
        { value: "html", label: "HTML" },
        { value: "ansi", label: "ANSI" },
        { value: "svg", label: "SVG" },
      ],
    },
  ],
  defaults: () => ({ format: "plain" }),
  kind: "frame",
  async run(inputs, params) {
    return { text: gridToText(inputs.grid as GridValue, params.format as "plain" | "html" | "ansi" | "svg") };
  },
};

export const ASCII_CONVERTERS: Converter[] = [
  { from: "grid", to: "image", label: "draw", convert: async (v) => gridToImage(v as GridValue) },
  { from: "grid", to: "text", label: "text", convert: async (v) => gridToText(v as GridValue, "plain") },
];
