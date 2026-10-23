export type Mode = "ramp" | "braille";
export type Dither = "none" | "bayer" | "floyd-steinberg" | "atkinson";
export type ColorMode = "mono" | "color";

export interface Settings {
  version: 1;
  name: string;
  mode: Mode;
  charset: string;
  custom: string;
  /** Reorder the characters by measured ink coverage in the chosen font. */
  sortByInk: boolean;
  columns: number;
  font: string;
  bold: boolean;
  fontSize: number;
  lineHeight: number;
  brightness: number;
  contrast: number;
  gamma: number;
  invert: boolean;
  /** Stretch each frame's darkest to brightest value over the full range. */
  normalize: boolean;
  dither: Dither;
  /** Edge strength needed to draw a line character; 0 turns edges off. */
  edges: number;
  /** Draw only the edge lines and leave every other cell blank. */
  edgesOnly: boolean;
  colorMode: ColorMode;
  fg: string;
  bg: string;
  saturation: number;
}

export const FONTS: { id: string; name: string; css: string }[] = [
  { id: "system", name: "System mono", css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: "menlo", name: "Menlo", css: "Menlo, Monaco, monospace" },
  { id: "courier", name: "Courier", css: '"Courier New", Courier, monospace' },
  { id: "consolas", name: "Consolas", css: "Consolas, monospace" },
  { id: "monospace", name: "Browser mono", css: "monospace" },
];

export const THEMES: { name: string; fg: string; bg: string }[] = [
  { name: "White on black", fg: "#f2f2f2", bg: "#000000" },
  { name: "Terminal green", fg: "#33ff66", bg: "#050d07" },
  { name: "Amber", fg: "#ffb000", bg: "#140c00" },
  { name: "Paper", fg: "#1d1d1f", bg: "#f4efe6" },
  { name: "Blueprint", fg: "#e3f0ff", bg: "#1b3a7a" },
  { name: "Acid", fg: "#e8ff59", bg: "#111214" },
  { name: "Transparent", fg: "#ffffff", bg: "transparent" },
];

export function defaultSettings(): Settings {
  return {
    version: 1,
    name: "Untitled",
    mode: "ramp",
    charset: "classic",
    custom: " .oO0@",
    sortByInk: false,
    columns: 120,
    font: "system",
    bold: false,
    fontSize: 12,
    lineHeight: 1.0,
    brightness: 0,
    contrast: 0,
    gamma: 1,
    invert: false,
    normalize: false,
    dither: "none",
    edges: 0,
    edgesOnly: false,
    colorMode: "mono",
    fg: "#f2f2f2",
    bg: "#000000",
    saturation: 1,
  };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts.includes(v as T) ? (v as T) : d);
const color = (v: unknown, d: string) => (typeof v === "string" && /^(#[0-9a-f]{6}|transparent)$/i.test(v) ? v : d);

/** Validates and normalises imported settings, filling gaps with defaults. */
export function parseSettings(json: unknown): Settings {
  if (!json || typeof json !== "object") throw new Error("Not an ASCII Lab preset");
  const s = json as Partial<Settings>;
  const d = defaultSettings();
  return {
    version: 1,
    name: typeof s.name === "string" ? s.name : "Imported",
    mode: oneOf(s.mode, ["ramp", "braille"] as const, d.mode),
    charset: typeof s.charset === "string" ? s.charset : d.charset,
    custom: typeof s.custom === "string" ? s.custom.slice(0, 256) : d.custom,
    sortByInk: s.sortByInk === true,
    columns: Math.round(clamp(s.columns, 10, 600, d.columns)),
    font: typeof s.font === "string" && FONTS.some((f) => f.id === s.font) ? s.font : d.font,
    bold: s.bold === true,
    fontSize: clamp(s.fontSize, 4, 48, d.fontSize),
    lineHeight: clamp(s.lineHeight, 0.6, 2, d.lineHeight),
    brightness: clamp(s.brightness, -1, 1, d.brightness),
    contrast: clamp(s.contrast, -1, 1, d.contrast),
    gamma: clamp(s.gamma, 0.2, 5, d.gamma),
    invert: s.invert === true,
    normalize: s.normalize === true,
    dither: oneOf(s.dither, ["none", "bayer", "floyd-steinberg", "atkinson"] as const, d.dither),
    edges: clamp(s.edges, 0, 1, d.edges),
    edgesOnly: s.edgesOnly === true,
    colorMode: oneOf(s.colorMode, ["mono", "color"] as const, d.colorMode),
    fg: color(s.fg, d.fg),
    bg: color(s.bg, d.bg),
    saturation: clamp(s.saturation, 0, 3, d.saturation),
  };
}

export function encodeSettings(s: Settings): string {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSettings(str: string): Settings {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return parseSettings(JSON.parse(new TextDecoder().decode(bytes)));
}

export function fontCss(s: Settings, size: number): string {
  const family = FONTS.find((f) => f.id === s.font)?.css ?? FONTS[0].css;
  return `${s.bold ? "bold " : ""}${size}px ${family}`;
}
