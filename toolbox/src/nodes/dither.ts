import { parseRecipe, render, type Recipe } from "../../../dither/src/engine/recipe";
import { builtInRecipes } from "../../../dither/src/recipes";
import type { ImageValue, NodeDef } from "../runtime/types";
import { preferGpu } from "./gpu";
import { scaleImage } from "./image";

/** Same cap as Dither Lab uses for still images. */
const MAX_WORK = 4096;

export const ditherRecipe: NodeDef = {
  type: "dither.recipe",
  title: "Dither",
  category: "image",
  description: "Dither Lab's effect stack: adjustments, filters and a dither step with a palette.",
  inputs: [{ key: "image", label: "Image", type: "image" }],
  outputs: [{ key: "image", label: "Image", type: "image" }],
  params: [
    { key: "recipe", label: "Effect stack", kind: "custom" },
    {
      key: "size",
      label: "Output size",
      kind: "select",
      options: [
        { value: "source", label: "Same as input (big pixels)" },
        { value: "pixels", label: "One pixel per dither pixel" },
      ],
    },
  ],
  defaults: () => ({ recipe: builtInRecipes()[0], size: "source" }),
  kind: "frame",
  async run(inputs, params) {
    const src = inputs.image as ImageValue;
    const recipe: Recipe = parseRecipe(params.recipe);
    // Pixel size is in full-size pixels; a downscaled preview frame needs proportionally smaller ones.
    const ps = Math.max(1, recipe.pixelSize * (src.scale ?? 1));
    let w = Math.max(1, Math.round(src.width / ps));
    let h = Math.max(1, Math.round(src.height / ps));
    const s = Math.min(1, MAX_WORK / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
    const big = params.size !== "pixels";
    const image = await preferGpu<ImageValue>(
      async (g) => {
        if (!g.dither.fits(w, h, src.width, src.height)) return undefined;
        const out = await g.dither.render(src.data, src.width, src.height, w, h, recipe, big ? { outWidth: src.width, outHeight: src.height } : {});
        return { kind: "image", width: out.width, height: out.height, data: out.rgba, scale: src.scale };
      },
      () => {
        const work = scaleImage(src, w, h, true);
        const out = render(work.data, w, h, recipe);
        return { kind: "image", width: w, height: h, data: out.rgba, scale: src.scale };
      },
    );
    // The GPU draws the big pixels itself unless the recipe ended on the CPU.
    return { image: big ? scaleImage(image, src.width, src.height, false) : image };
  },
};
