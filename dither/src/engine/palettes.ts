export type RGB = [number, number, number];

export interface PalettePreset {
  id: string;
  name: string;
  colors: string[];
}

export const PRESETS: PalettePreset[] = [
  { id: "bw", name: "1-bit black & white", colors: ["#000000", "#ffffff"] },
  { id: "mac", name: "Mac Classic", colors: ["#2b2b26", "#e3dfd2"] },
  { id: "gray4", name: "Grayscale 4", colors: ["#000000", "#555555", "#aaaaaa", "#ffffff"] },
  {
    id: "gray8",
    name: "Grayscale 8",
    colors: ["#000000", "#242424", "#494949", "#6d6d6d", "#929292", "#b6b6b6", "#dbdbdb", "#ffffff"],
  },
  { id: "gb", name: "Game Boy", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
  { id: "gbp", name: "Game Boy Pocket", colors: ["#000000", "#545454", "#a9a9a9", "#ffffff"] },
  { id: "cga1", name: "CGA mode 4 (high)", colors: ["#000000", "#55ffff", "#ff55ff", "#ffffff"] },
  { id: "cga0", name: "CGA mode 4 (low)", colors: ["#000000", "#00aa00", "#aa0000", "#aa5500"] },
  {
    id: "ega",
    name: "EGA 16",
    colors: [
      "#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa",
      "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff",
    ],
  },
  {
    id: "pico8",
    name: "PICO-8",
    colors: [
      "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
    ],
  },
  {
    id: "c64",
    name: "Commodore 64",
    colors: [
      "#000000", "#ffffff", "#880000", "#aaffee", "#cc44cc", "#00cc55", "#0000aa", "#eeee77",
      "#dd8855", "#664400", "#ff7777", "#333333", "#777777", "#aaff66", "#0088ff", "#bbbbbb",
    ],
  },
  {
    id: "zx",
    name: "ZX Spectrum",
    colors: [
      "#000000", "#0000d8", "#d80000", "#d800d8", "#00d800", "#00d8d8", "#d8d800", "#d8d8d8",
      "#0000ff", "#ff0000", "#ff00ff", "#00ff00", "#00ffff", "#ffff00", "#ffffff",
    ],
  },
  { id: "eink4", name: "E-ink 4 gray", colors: ["#1a1a1a", "#6b6b6b", "#b0b0b0", "#ececec"] },
  {
    id: "spectra6",
    name: "E-ink Spectra 6",
    colors: ["#191e21", "#e8e8e8", "#b21e1e", "#e6c619", "#2950a8", "#3f7d3a"],
  },
  { id: "cmyk", name: "CMYK + white", colors: ["#00a0e3", "#e6007e", "#ffed00", "#1d1d1b", "#ffffff"] },
  { id: "risograph", name: "Riso pink & blue", colors: ["#f4efe6", "#ff48b0", "#0078bf", "#3d2a5c"] },
  { id: "sepia", name: "Sepia", colors: ["#2b1d0e", "#6b4a2b", "#a98157", "#e8d4b0"] },
];

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Pull hex colors out of free text such as "#fff, 00ff00 ff0000". */
export function parseHexList(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    out.push(rgbToHex(hexToRgb(m[1])));
  }
  return out;
}
