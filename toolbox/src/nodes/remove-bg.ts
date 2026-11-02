// Remove background: finds the subject (a person, an animal, a product) with a local
// model and cuts it out with a transparent background, a colour, or another picture
// behind it. As a frame node it also works on every image of a list and every frame of a video.
import type { ImageValue, NodeDef } from "../runtime/types";
import { MODELS, composite, finishMask, maskImage, parseHex, type Fill, type ModelId } from "./remove-bg-core";

export const removeBackground: NodeDef = {
  type: "image.removebg",
  title: "Remove background",
  category: "image",
  description:
    "Finds the subject (a person, an animal, a product) and removes everything behind it, leaving a transparent background; Save as PNG keeps it. Or fill the background with a colour, or wire in a picture to put behind the subject. The model runs on this computer: it downloads once the first time, then works offline.",
  inputs: [
    { key: "image", label: "Image", type: "image" },
    { key: "background", label: "New background", type: "image", optional: true },
  ],
  outputs: [
    { key: "image", label: "Image", type: "image" },
    { key: "mask", label: "Mask", type: "image" },
  ],
  params: [
    {
      key: "model",
      label: "Model",
      kind: "select",
      options: [
        { value: "best", label: `Best: sharp edges (${MODELS.best.mb} MB download)` },
        { value: "fast", label: `Fast: rougher edges (${MODELS.fast.mb} MB download)` },
      ],
    },
    {
      key: "fill",
      label: "Background",
      kind: "select",
      options: [
        { value: "transparent", label: "Transparent" },
        { value: "color", label: "Colour" },
      ],
    },
    { key: "color", label: "Colour", kind: "text", commit: true, placeholder: "#ffffff" },
    { key: "refine", label: "Refine edges (hair, fur)", kind: "toggle" },
    { key: "hardness", label: "Edge hardness %", kind: "number", min: 0, max: 100, step: 1 },
    { key: "shift", label: "Grow / shrink edge px", kind: "number", min: -30, max: 30, step: 1, advanced: true },
    { key: "invert", label: "Keep the background instead", kind: "toggle", advanced: true },
  ],
  defaults: () => ({ model: "best", fill: "transparent", color: "#ffffff", refine: true, hardness: 0, shift: 0, invert: false }),
  visible: (key, p) => key !== "color" || p.fill === "color",
  kind: "frame",
  async run(inputs, params, ctx) {
    const img = inputs.image as ImageValue;
    const bg = inputs.background as ImageValue | undefined;
    const id: ModelId = params.model === "fast" ? "fast" : "best";
    const { predictMask } = await import("./remove-bg-model");
    const small = await predictMask(img, id, ctx.progress);
    const alpha = finishMask(
      img,
      small,
      MODELS[id].size,
      {
        refine: params.refine !== false,
        hardness: Number(params.hardness ?? 0),
        shift: Number(params.shift ?? 0),
        invert: params.invert === true,
      },
      img.scale ?? 1,
    );
    const fill: Fill = bg
      ? { type: "image", image: bg }
      : params.fill === "color"
        ? { type: "color", rgb: parseHex(String(params.color ?? ""), [255, 255, 255]) }
        : { type: "transparent" };
    const base = { kind: "image" as const, width: img.width, height: img.height, ...(img.scale ? { scale: img.scale } : {}) };
    return {
      image: { ...base, data: composite(img, alpha, fill) },
      mask: { ...base, data: maskImage(alpha, img.width, img.height) },
    };
  },
};
