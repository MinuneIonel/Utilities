import { defaultSettings, type Settings } from "./engine/settings";

const preset = (name: string, s: Partial<Settings>): Settings => ({ ...defaultSettings(), ...s, name });

/** Starter presets shown in the preset menu. */
export function builtInPresets(): Settings[] {
  return [
    preset("Classic", { charset: "classic", columns: 120, contrast: 0.1 }),
    preset("Detailed", { charset: "detailed", columns: 160, fontSize: 9, contrast: 0.15, dither: "floyd-steinberg" }),
    preset("Terminal", { charset: "detailed", columns: 120, fg: "#33ff66", bg: "#050d07", contrast: 0.2, dither: "atkinson" }),
    preset("Matrix", { charset: "katakana", columns: 100, fg: "#33ff66", bg: "#020602", sortByInk: true, contrast: 0.3, fontSize: 14 }),
    preset("Full color", { charset: "detailed", columns: 160, fontSize: 9, colorMode: "color", saturation: 1.3, bold: true }),
    preset("Color blocks", { charset: "blocks", columns: 120, colorMode: "color", saturation: 1.2, lineHeight: 1.2 }),
    preset("Braille", { mode: "braille", columns: 140, dither: "floyd-steinberg", contrast: 0.1 }),
    preset("Line art", { charset: "minimal", columns: 140, edges: 0.75, edgesOnly: true, fg: "#1d1d1f", bg: "#f4efe6", contrast: 0.2 }),
    preset("Newsprint", { charset: "dots", columns: 140, fg: "#1d1d1f", bg: "#f4efe6", dither: "bayer", fontSize: 10 }),
    preset("Amber webcam", { charset: "classic", columns: 100, fg: "#ffb000", bg: "#140c00", normalize: true, dither: "bayer" }),
  ];
}
