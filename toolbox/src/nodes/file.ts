import type { NodeDef } from "../runtime/types";
import { decodeImage } from "./image";

/** Live preview works on frames no larger than this, so sliders stay responsive. */
export const PREVIEW_MAX = 1280;

export const fileInput: NodeDef = {
  type: "input.file",
  title: "File input",
  category: "input",
  description: "An image dropped into Toolbox. Drop a file on the window or on this node.",
  inputs: [],
  outputs: [{ key: "image", label: "Image", type: "image" }],
  params: [],
  defaults: () => ({ assetId: "", name: "" }),
  kind: "frame",
  // The asset id is already a param; the mode matters because preview frames are downscaled.
  cacheKey: (_p, ctx) => ctx.mode,
  async run(_inputs, params, ctx) {
    const blob = ctx.assets.get(String(params.assetId));
    if (!blob) throw new Error("Drop an image here");
    const image = await decodeImage(blob, ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
    return { image };
  },
};
