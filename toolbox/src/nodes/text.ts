import { parseModel, type Model } from "../../../diacritics/src/engine/model";
import { parseNeural } from "../../../diacritics/src/engine/neural";
import { restoreText } from "../../../diacritics/src/engine/restore";
import modelUrl from "../../../diacritics/public/model.dat?url";
import neuralUrl from "../../../diacritics/public/neural.dat?url";
import type { NodeDef, TextValue } from "../runtime/types";

export const textInput: NodeDef = {
  type: "input.text",
  title: "Text",
  category: "input",
  description: "Text you type or paste.",
  inputs: [],
  outputs: [{ key: "text", label: "Text", type: "text" }],
  params: [{ key: "text", label: "Text", kind: "text", multiline: true }],
  defaults: () => ({ text: "Si daca ma intrebi, tara asta e frumoasa." }),
  kind: "frame",
  async run(_inputs, params) {
    return { text: { kind: "text", text: String(params.text ?? "") } };
  },
};

function gunzip(res: Response): Response {
  if (!res.ok || !res.body) throw new Error(`Couldn't load ${res.url} (HTTP ${res.status})`);
  return new Response(res.body.pipeThrough(new DecompressionStream("gzip")));
}

// The 5 MB model loads once per thread, on first use.
let model: Promise<Model> | undefined;
function loadModel(): Promise<Model> {
  model ??= (async () => {
    const [text, neural] = await Promise.all([
      fetch(modelUrl).then((r) => gunzip(r).text()),
      fetch(neuralUrl)
        .then((r) => gunzip(r).arrayBuffer())
        .then(parseNeural)
        .catch(() => undefined),
    ]);
    const m = parseModel(text);
    m.neural = neural;
    return m;
  })().catch((err) => {
    model = undefined;
    throw err;
  });
  return model;
}

export const diacritics: NodeDef = {
  type: "text.diacritics",
  title: "Diacritice",
  category: "text",
  description: "Restores Romanian diacritics (ă â î ș ț) in text typed without them. Offline, no LLM.",
  inputs: [{ key: "text", label: "Text", type: "text" }],
  outputs: [{ key: "text", label: "Text", type: "text" }],
  params: [{ key: "keepExisting", label: "Keep typed diacritics", kind: "toggle" }],
  defaults: () => ({ keepExisting: true }),
  kind: "frame",
  async run(inputs, params) {
    const src = inputs.text as TextValue;
    const m = await loadModel();
    return { text: { ...src, text: restoreText(src.text, m, { keepExisting: params.keepExisting !== false }) } };
  },
};

const EXT: Record<string, { ext: string; mime: string }> = {
  plain: { ext: "txt", mime: "text/plain" },
  html: { ext: "html", mime: "text/html" },
  ansi: { ext: "ans", mime: "text/plain" },
  svg: { ext: "svg", mime: "image/svg+xml" },
};

export const saveText: NodeDef = {
  type: "output.save-text",
  title: "Save text",
  category: "output",
  description: "Writes text on Render. The extension follows the text's format (.txt, .html, .ans, .svg).",
  inputs: [{ key: "text", label: "Text", type: "text" }],
  outputs: [{ key: "file", label: "File", type: "file" }],
  params: [{ key: "name", label: "File name", kind: "text" }],
  defaults: () => ({ name: "toolbox-text", folder: "" }),
  kind: "job",
  saves: true,
  async run(inputs, params) {
    const t = inputs.text as TextValue;
    const f = EXT[t.format ?? "plain"] ?? EXT.plain;
    const base = String(params.name || "toolbox-text").replace(/[\\/:*?"<>|]+/g, "-");
    return { file: { kind: "file", name: `${base}.${f.ext}`, mime: f.mime, bytes: new TextEncoder().encode(t.text) } };
  },
};
