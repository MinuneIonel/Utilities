import type { ImageFormat, ImageJob, Resize, Rotation } from "../../../media/src/engine/types";
import type { ImageValue, NodeDef } from "../runtime/types";

/** Media Lab's image engine (the jsquash codecs), loaded on first use. */
const engine = () => import("../../../media/src/engine/image");

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Media Lab's job shape from this node's flat params. Crop is in percent so it survives preview downscaling. */
function job(p: Record<string, unknown>, w: number, h: number): ImageJob {
  const cx = num(p.cropX, 0) / 100;
  const cy = num(p.cropY, 0) / 100;
  const cw = num(p.cropW, 100) / 100;
  const ch = num(p.cropH, 100) / 100;
  const cropped = cx > 0 || cy > 0 || cw < 1 || ch < 1;
  const upscale = p.upscale === true;
  let resize: Resize = { mode: "none" };
  switch (p.resize) {
    case "percent":
      resize = { mode: "percent", percent: num(p.percent, 50) };
      break;
    case "long-edge":
      resize = { mode: "long-edge", size: num(p.size, 1920), upscale };
      break;
    case "contain":
    case "cover":
    case "fill":
      resize = { mode: "box", width: num(p.width, 1920), height: num(p.height, 1080), fit: p.resize, upscale };
      break;
  }
  return {
    crop: cropped ? { x: cx * w, y: cy * h, width: cw * w, height: ch * h } : undefined,
    rotate: num(p.rotate, 0) as Rotation,
    flipH: p.flipH === true,
    flipV: p.flipV === true,
    resize,
    format: (p.format as ImageFormat) ?? "png",
    quality: num(p.quality, 80),
    lossless: p.lossless === true,
    maxBytes: num(p.maxKB, 0) > 0 ? num(p.maxKB, 0) * 1024 : undefined,
    background: typeof p.background === "string" ? p.background : "#ffffff",
    pngLevel: num(p.pngLevel, 2),
  };
}

export const imageTransform: NodeDef = {
  type: "media.transform",
  title: "Resize / crop",
  category: "image",
  description: "Media Lab's crop, rotate, flip and high-quality (Lanczos) resize.",
  inputs: [{ key: "image", label: "Image", type: "image" }],
  outputs: [{ key: "image", label: "Image", type: "image" }],
  params: [
    { key: "cropX", label: "Crop left %", kind: "number", min: 0, max: 99, step: 1 },
    { key: "cropY", label: "Crop top %", kind: "number", min: 0, max: 99, step: 1 },
    { key: "cropW", label: "Crop width %", kind: "number", min: 1, max: 100, step: 1 },
    { key: "cropH", label: "Crop height %", kind: "number", min: 1, max: 100, step: 1 },
    {
      key: "rotate",
      label: "Rotate",
      kind: "select",
      options: [
        { value: "0", label: "None" },
        { value: "90", label: "90° right" },
        { value: "180", label: "180°" },
        { value: "270", label: "90° left" },
      ],
    },
    { key: "flipH", label: "Flip horizontal", kind: "toggle" },
    { key: "flipV", label: "Flip vertical", kind: "toggle" },
    {
      key: "resize",
      label: "Resize",
      kind: "select",
      options: [
        { value: "none", label: "Keep size" },
        { value: "percent", label: "Percent" },
        { value: "long-edge", label: "Long edge" },
        { value: "contain", label: "Fit inside box" },
        { value: "cover", label: "Fill box (crop)" },
        { value: "fill", label: "Stretch to box" },
      ],
    },
    { key: "percent", label: "Percent", kind: "number", min: 1, max: 400, step: 1 },
    { key: "size", label: "Long edge px", kind: "number", min: 16, max: 8192, step: 16 },
    { key: "width", label: "Box width px", kind: "number", min: 16, max: 8192, step: 16 },
    { key: "height", label: "Box height px", kind: "number", min: 16, max: 8192, step: 16 },
    { key: "upscale", label: "Allow upscale", kind: "toggle" },
  ],
  defaults: () => ({
    cropX: 0, cropY: 0, cropW: 100, cropH: 100, rotate: "0", flipH: false, flipV: false,
    resize: "none", percent: 50, size: 1920, width: 1920, height: 1080, upscale: false,
  }),
  visible(key, p) {
    if (key === "percent") return p.resize === "percent";
    if (key === "size") return p.resize === "long-edge";
    if (key === "width" || key === "height") return ["contain", "cover", "fill"].includes(String(p.resize));
    if (key === "upscale") return p.resize !== "none" && p.resize !== "percent";
    return true;
  },
  kind: "frame",
  async run(inputs, params) {
    const src = inputs.image as ImageValue;
    const j = job(params, src.width, src.height);
    // Pixel sizes refer to the full-size render; preview frames are smaller, so scale them down too.
    const k = src.scale ?? 1;
    if (k < 1 && j.resize.mode !== "none" && j.resize.mode !== "percent") {
      if (j.resize.mode === "long-edge") j.resize.size *= k;
      else {
        if (j.resize.width) j.resize.width *= k;
        if (j.resize.height) j.resize.height *= k;
      }
    }
    const out = await (await engine()).transformImage(src, j);
    return { image: { kind: "image", width: out.width, height: out.height, data: out.data, scale: k } };
  },
};

export const imageEncode: NodeDef = {
  type: "media.encode",
  title: "Encode image",
  category: "image",
  description: "Media Lab's encoders (MozJPEG, WebP, AVIF, oxipng PNG), with an optional size limit. Feed it to Save file.",
  inputs: [{ key: "image", label: "Image", type: "image" }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "jpeg", label: "JPEG (MozJPEG)" },
        { value: "webp", label: "WebP" },
        { value: "avif", label: "AVIF" },
        { value: "png", label: "PNG (oxipng)" },
      ],
    },
    { key: "quality", label: "Quality", kind: "number", min: 1, max: 100, step: 1 },
    { key: "lossless", label: "Lossless", kind: "toggle" },
    { key: "maxKB", label: "Max size KB (0 = off)", kind: "number", min: 0, max: 10000, step: 10 },
    { key: "pngLevel", label: "PNG effort", kind: "number", min: 0, max: 6, step: 1 },
    { key: "name", label: "File name", kind: "text" },
  ],
  defaults: () => ({ format: "jpeg", quality: 80, lossless: false, maxKB: 0, pngLevel: 2, name: "image" }),
  visible(key, p) {
    if (key === "quality" || key === "maxKB") return p.format !== "png" && !(p.lossless && p.format !== "jpeg");
    if (key === "lossless") return p.format === "webp" || p.format === "avif";
    if (key === "pngLevel") return p.format === "png";
    return true;
  },
  kind: "job",
  async run(inputs, params) {
    const src = inputs.image as ImageValue;
    const r = await (await engine()).processImage(src, { ...job(params, src.width, src.height), crop: undefined, rotate: 0, flipH: false, flipV: false, resize: { mode: "none" } });
    const base = String(params.name || "image").replace(/[\\/:*?"<>|]+/g, "-");
    return { file: { kind: "file", name: `${base}.${r.ext}`, mime: r.mime, bytes: r.bytes } };
  },
};
