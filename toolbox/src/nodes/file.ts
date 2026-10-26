import type { NodeDef, VideoValue } from "../runtime/types";
import { decodeImage } from "./image";
import { lastError, nativeTools, toolFile } from "./native";

const isHeic = (b: Blob) => /^image\/hei[cf]/.test(b.type) || /\.hei[cf]$/i.test((b as File).name ?? "");
const heicCopies = new WeakMap<Blob, Promise<Blob>>();

/** iPhone photos (HEIC) as JPEG, through macOS's sips: browsers can't decode HEIC. Other images as they are. */
function readable(blob: Blob): Promise<Blob> {
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
  async run(_inputs, params, ctx) {
    const ids = Array.isArray(params.assetIds) ? params.assetIds.map(String) : [];
    const names = Array.isArray(params.names) ? params.names.map(String) : [];
    const found = ids.map((id, i) => ({ blob: ctx.assets.get(id), name: names[i] })).filter((x): x is { blob: Blob; name: string } => !!x.blob);
    const blobs = found.map((x) => x.blob);
    if (!blobs.length) throw new Error("Choose or drop images");
    const at = Math.min(blobs.length, Math.max(1, Math.floor(Number(params.at) || 1))) - 1;
    const poster = await decodeImage(await readable(blobs[at]), ctx.mode === "preview" ? PREVIEW_MAX : Infinity);
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
          yield { value: await decodeImage(await readable(blobs[i])), timestamp: i, duration: 1, name: found[i].name };
        }
      },
    };
    return { images: video };
  },
};
