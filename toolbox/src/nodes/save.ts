import type { FileValue, ImageValue, NodeDef } from "../runtime/types";
import { encodeImage } from "./image";

const FORMATS: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
};

export const saveImage: NodeDef = {
  type: "output.save-image",
  title: "Save image",
  category: "output",
  description: "Encodes the image on Render and saves it. Pick a folder to save without asking each time.",
  inputs: [{ key: "image", label: "Image", type: "image" }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [
    { key: "name", label: "File name", kind: "text" },
    {
      key: "format",
      label: "Format",
      kind: "select",
      options: [
        { value: "png", label: "PNG" },
        { value: "jpeg", label: "JPEG" },
        { value: "webp", label: "WebP" },
      ],
    },
    { key: "quality", label: "Quality (JPEG, WebP)", kind: "number", min: 10, max: 100, step: 1 },
  ],
  defaults: () => ({ name: "toolbox-output", format: "png", quality: 90, folder: "" }),
  kind: "job",
  saves: true,
  async run(inputs, params) {
    const fmt = FORMATS[String(params.format)] ?? FORMATS.png;
    const bytes = await encodeImage(inputs.image as ImageValue, fmt.mime, Number(params.quality) / 100);
    const base = String(params.name || "toolbox-output").replace(/[\\/:*?"<>|]+/g, "-");
    return { file: { kind: "file", name: `${base}.${fmt.ext}`, mime: fmt.mime, bytes } };
  },
};

export const saveFile: NodeDef = {
  type: "output.save-file",
  title: "Save file",
  category: "output",
  description: "Writes an encoded file (from Encode image and similar) on Render. Leave the name empty to keep the file's own.",
  inputs: [{ key: "file", label: "File", type: "file" }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [{ key: "name", label: "File name", kind: "text" }],
  defaults: () => ({ name: "", folder: "" }),
  kind: "job",
  saves: true,
  async run(inputs, params) {
    const f = inputs.file as FileValue;
    const base = String(params.name ?? "").replace(/[\\/:*?"<>|]+/g, "-").trim();
    if (!base) return { file: f };
    const ext = f.name.includes(".") ? f.name.slice(f.name.lastIndexOf(".")) : "";
    return { file: { ...f, name: base + ext } };
  },
};
