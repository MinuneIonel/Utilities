import type { NodeDef, RunContext, VideoValue } from "../runtime/types";
import { decodeImage } from "./image";
import { lastError, nativeTools, toolFile } from "./native";

const isHeic = (b: Blob) => /^image\/hei[cf]/.test(b.type) || /\.hei[cf]$/i.test((b as File).name ?? "");
const heicCopies = new WeakMap<Blob, Promise<Blob>>();

/** iPhone photos (HEIC) as JPEG, through macOS's sips: browsers can't decode HEIC. Other images as they are. */
export function readable(blob: Blob): Promise<Blob> {
  if (!isHeic(blob)) return Promise.resolve(blob);
  let p = heicCopies.get(blob);
  if (!p) {
    p = (async () => {
      const tools = nativeTools();
      if (!tools?.sips) throw new Error("HEIC photos (from iPhones) open in the Mac app. Elsewhere, export them as JPEG first.");
      const r = await tools.run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "92", "in.heic", "--out", "out.jpg"], { "in.heic": await toolFile(blob) });
      const out = r.files["out.jpg"];
      if (r.code !== 0 || !out) throw new Error(`Couldn't read this HEIC photo: ${lastError(r.log)}`);
      return new Blob([out as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
    })();
    heicCopies.set(blob, p);
    p.catch(() => heicCopies.delete(blob));
  }
  return p;
}

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
    const image = await decodeImage(await readable(blob), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
    return { image };
  },
};

export const imagesInput: NodeDef = {
  type: "input.images",
  title: "Several images",
  category: "input",
  description:
    "Several images as a list. Nodes after it (Resize, Dither, Encode image, Overlay…) run on each one, and Save writes one file per image. Or feed it to Images to PDF for a document, or to Encode video for a slideshow, one image a second.",
  inputs: [],
  outputs: [{ key: "images", label: "Images", type: "video" }],
  params: [{ key: "at", label: "Preview image", kind: "number", min: 1, max: 500, step: 1 }],
  defaults: () => ({ assetIds: [], names: [], at: 1 }),
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  previewParams: ["at"],
  async run(_inputs, params, ctx) {
    const ids = Array.isArray(params.assetIds) ? params.assetIds.map(String) : [];
    const names = Array.isArray(params.names) ? params.names.map(String) : [];
    const found = ids.map((id, i) => ({ blob: ctx.assets.get(id), name: names[i] })).filter((x): x is { blob: Blob; name: string } => !!x.blob);
    if (!found.length) throw new Error("Choose or drop images");
    return { images: await listOfImages(found.map((x) => ({ name: x.name, read: async () => x.blob })), params.at, ctx) };
  },
};

/** One image of a list, read only when it's needed. */
export interface ImageItem {
  name: string;
  read(): Promise<Blob>;
}

/**
 * A list of images as a sequence, one a second: every frame node after it runs on each, and Save
 * writes one file per image. Only the previewed image (`at`, from 1) is read up front; the others
 * are read one at a time as the frames are asked for, and let go once used.
 */
export async function listOfImages(items: ImageItem[], at: unknown, ctx: RunContext, about?: string): Promise<VideoValue> {
  const i = Math.min(items.length, Math.max(1, Math.floor(Number(at) || 1))) - 1;
  const poster = await decodeImage(await readable(await items[i].read()), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
  const full = poster.scale && poster.scale < 1 ? { w: Math.round(poster.width / poster.scale), h: Math.round(poster.height / poster.scale) } : { w: poster.width, h: poster.height };
  return {
    kind: "video",
    of: "image",
    width: full.w,
    height: full.h,
    duration: items.length,
    fps: 1,
    poster,
    about,
    async *frames(signal, opts = {}) {
      for (let i = Math.max(0, Math.floor(opts.from ?? 0)); i < items.length; i++) {
        if (signal?.aborted) return;
        if (opts.skipTo && i < opts.skipTo()) continue;
        yield { value: await decodeImage(await readable(await items[i].read()), opts.maxSide), timestamp: i, duration: 1, name: items[i].name };
      }
    },
  };
}
