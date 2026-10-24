import type { NodeDef, VideoValue } from "../runtime/types";
import { decodeImage } from "./image";

/** Live preview works on frames no larger than this, so sliders stay responsive. */
export const PREVIEW_MAX = 1280;

export const fileInput: NodeDef = {
  type: "input.file",
  title: "Image file",
  category: "input",
  description: "An image dropped into Toolbox. Drop a file on the window or choose one on the node.",
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

export const imagesInput: NodeDef = {
  type: "input.images",
  title: "Images",
  category: "input",
  description: "Several images as one sequence, one per second: feed it to Images to PDF for a document, or to Encode video for a slideshow.",
  inputs: [],
  outputs: [{ key: "images", label: "Images", type: "video" }],
  params: [{ key: "at", label: "Preview image", kind: "number", min: 1, max: 500, step: 1 }],
  defaults: () => ({ assetIds: [], names: [], at: 1 }),
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  async run(_inputs, params, ctx) {
    const ids = Array.isArray(params.assetIds) ? params.assetIds.map(String) : [];
    const blobs = ids.map((id) => ctx.assets.get(id)).filter((b): b is Blob => !!b);
    if (!blobs.length) throw new Error("Choose or drop images");
    const at = Math.min(blobs.length, Math.max(1, Math.floor(Number(params.at) || 1))) - 1;
    const poster = await decodeImage(blobs[at], ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
    const full = poster.scale && poster.scale < 1 ? { w: Math.round(poster.width / poster.scale), h: Math.round(poster.height / poster.scale) } : { w: poster.width, h: poster.height };
    const video: VideoValue = {
      kind: "video",
      of: "image",
      width: full.w,
      height: full.h,
      duration: blobs.length,
      fps: 1,
      poster,
      async *frames(signal) {
        for (let i = 0; i < blobs.length; i++) {
          if (signal?.aborted) return;
          yield { value: await decodeImage(blobs[i]), timestamp: i, duration: 1 };
        }
      },
    };
    return { images: video };
  },
};
