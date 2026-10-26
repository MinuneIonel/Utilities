import type { Converter, FileValue, ImageValue, NodeDef, TextValue, VideoValue } from "../runtime/types";

/** A Save node fed a list writes at most this many files. */
const MAX_BATCH = 2000;
const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".")) : "");
import { encodeImage } from "./image";

/** The extension for each kind of text. */
export const TEXT_FILE: Record<string, { ext: string; mime: string }> = {
  plain: { ext: "txt", mime: "text/plain" },
  html: { ext: "html", mime: "text/html" },
  ansi: { ext: "ans", mime: "text/plain" },
  svg: { ext: "svg", mime: "image/svg+xml" },
};

const FORMATS: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
};

export const saveImage: NodeDef = {
  type: "output.save-image",
  title: "Save image",
  hidden: true,
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

/** Lets an image or text wire straight into Save. */
export const SAVE_CONVERTERS: Converter[] = [
  {
    from: "image",
    to: "file",
    label: "png",
    async convert(v) {
      const bytes = await encodeImage(v as ImageValue, "image/png", 1);
      const f: FileValue = { kind: "file", name: "image.png", mime: "image/png", bytes };
      return f;
    },
  },
  {
    from: "text",
    to: "file",
    label: "text",
    async convert(v) {
      const t = v as TextValue;
      const f = TEXT_FILE[t.format ?? "plain"] ?? TEXT_FILE.plain;
      const file: FileValue = { kind: "file", name: `text.${f.ext}`, mime: f.mime, bytes: new TextEncoder().encode(t.text) };
      return file;
    },
  },
];

export const saveFile: NodeDef = {
  type: "output.save-file",
  title: "Save",
  category: "output",
  description:
    "Writes what's wired into it on Render: images as PNG, text, sound, PDFs, or files from Encode image and Encode video. Fed a list (Several images), it writes one file per item. Leave the name empty to keep the file's own. Pick a folder to save without asking each time.",
  inputs: [{ key: "file", label: "File", type: "file", sequence: true }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [{ key: "name", label: "File name", kind: "text" }],
  defaults: () => ({ name: "", folder: "" }),
  kind: "job",
  saves: true,
  async run(inputs, params, ctx) {
    const v = inputs.file as FileValue | VideoValue;
    const base = String(params.name ?? "").replace(/[\\/:*?"<>|]+/g, "-").trim();
    if (v.kind === "file") return { file: base ? { ...v, name: base + extOf(v.name) } : v };
    // A list (Several images, or each frame of a video): one file per item.
    const batch: FileValue[] = [];
    for await (const item of v.frames(ctx.signal)) {
      if (ctx.signal?.aborted) throw new Error("Cancelled");
      const f = item.value as FileValue;
      const n = batch.length + 1;
      if (n > MAX_BATCH) throw new Error(`That's more than ${MAX_BATCH} files. For a video, use Encode video before Save.`);
      const stem = base ? `${base}-${n}` : item.name ? item.name.replace(/\.[^.]+$/, "") : `${f.name.replace(/\.[^.]+$/, "")}-${n}`;
      batch.push({ ...f, name: stem + extOf(f.name) });
      if (v.duration > 0) ctx.progress?.(Math.min(0.99, item.timestamp / v.duration), `File ${n}`);
    }
    if (!batch.length) throw new Error("Nothing to save");
    return { file: { ...batch[0], batch } };
  },
};
