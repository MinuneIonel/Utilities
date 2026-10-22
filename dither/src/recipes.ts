import { newStep, type Recipe } from "./engine/recipe";

/** Starter recipes shown in the recipe menu. */
export function builtInRecipes(): Recipe[] {
  return [
    {
      version: 1,
      name: "Classic Mac",
      pixelSize: 2,
      steps: [
        newStep("adjust", { contrast: 15 }),
        newStep("dither", { algorithm: "atkinson", palette: "mac" }),
      ],
    },
    {
      version: 1,
      name: "Game Boy",
      pixelSize: 3,
      steps: [
        newStep("adjust", { contrast: 20, saturation: 0 }),
        newStep("dither", { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 }),
      ],
    },
    {
      version: 1,
      name: "Newsprint",
      pixelSize: 1,
      steps: [
        newStep("adjust", { contrast: 10, saturation: 0 }),
        newStep("blur", { radius: 1 }),
        newStep("dither", { algorithm: "halftone-dot", palette: "bw", cellSize: 7, angle: 45 }),
      ],
    },
    {
      version: 1,
      name: "Riso duotone",
      pixelSize: 2,
      steps: [
        newStep("adjust", { contrast: 10 }),
        newStep("gradient", { colors: ["#3d2a5c", "#0078bf", "#ff48b0", "#f4efe6"] }),
        newStep("grain", { amount: 0.08 }),
        newStep("dither", { algorithm: "blue-noise", palette: "risograph" }),
      ],
    },
    {
      version: 1,
      name: "PICO-8 VHS",
      pixelSize: 4,
      steps: [
        newStep("adjust", { saturation: 1.3, contrast: 10 }),
        newStep("grain", { amount: 0.12, mono: false }),
        newStep("dither", { algorithm: "bayer8", palette: "pico8", strength: 0.7 }),
      ],
    },
    {
      version: 1,
      name: "Ink sketch",
      pixelSize: 1,
      steps: [
        newStep("blur", { radius: 1 }),
        newStep("edges", { strength: 1.6, mix: 0.75 }),
        newStep("dither", { algorithm: "jarvis-judice-ninke", palette: "bw", strength: 0.8 }),
      ],
    },
    {
      version: 1,
      name: "E-ink Spectra",
      pixelSize: 2,
      steps: [
        newStep("adjust", { saturation: 1.4 }),
        newStep("dither", { algorithm: "floyd-steinberg", palette: "spectra6" }),
      ],
    },
    {
      version: 1,
      name: "Poster lines",
      pixelSize: 1,
      steps: [
        newStep("adjust", { contrast: 25 }),
        newStep("posterize", { levels: 4 }),
        newStep("dither", { algorithm: "halftone-line", palette: "cmyk", cellSize: 5, angle: 30 }),
      ],
    },
  ];
}
