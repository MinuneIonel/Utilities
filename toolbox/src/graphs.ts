import { REGISTRY } from "./nodes";
import type { Graph, GraphNode } from "./runtime/types";

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newNode(type: string, position: { x: number; y: number }): GraphNode {
  const def = REGISTRY.get(type);
  if (!def) throw new Error(`Unknown node type ${type}`);
  return { id: newId("n"), type, params: def.defaults(), position };
}

/** What a fresh window starts with: file in, dither, save. */
export function starterGraph(): Graph {
  const a = newNode("input.file", { x: 40, y: 120 });
  const b = newNode("dither.recipe", { x: 340, y: 120 });
  const c = newNode("output.save-image", { x: 640, y: 120 });
  return {
    version: 1,
    nodes: [a, b, c],
    edges: [
      { id: newId("e"), source: a.id, sourceHandle: "image", target: b.id, targetHandle: "image" },
      { id: newId("e"), source: b.id, sourceHandle: "image", target: c.id, targetHandle: "image" },
    ],
  };
}

/** Validates a saved graph, dropping nodes of unknown types and edges that point nowhere. */
export function parseGraph(text: string): Graph {
  const g = JSON.parse(text) as Partial<Graph>;
  if (!g || g.version !== 1 || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error("Not a Toolbox graph");
  const nodes = g.nodes
    .filter((n) => n && typeof n.id === "string" && REGISTRY.has(n.type))
    .map((n) => ({
      id: n.id,
      type: n.type,
      params: { ...REGISTRY.get(n.type)!.defaults(), ...n.params },
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => e && ids.has(e.source) && ids.has(e.target));
  return { version: 1, nodes, edges };
}

/** Saved graphs don't carry dropped files, so file inputs come back empty. */
export function serializeGraph(g: Graph): string {
  const nodes = g.nodes.map((n) => {
    const params = { ...n.params };
    if ("assetId" in params) params.assetId = "";
    if ("assetIds" in params) params.assetIds = [];
    return { ...n, params };
  });
  return JSON.stringify({ ...g, nodes }, null, 2);
}

/** Builds a left-to-right chain: each step's output feeds the next step's input. */
function chain(steps: [type: string, params: Record<string, unknown>, input?: string, output?: string][]): Graph {
  const nodes = steps.map(([type, params], i) => {
    const n = newNode(type, { x: 40 + i * 300, y: 120 });
    n.params = { ...n.params, ...params };
    return n;
  });
  const edges = steps.slice(1).map(([, , input], i) => ({
    id: newId("e"),
    source: nodes[i].id,
    sourceHandle: steps[i][3] ?? REGISTRY.get(nodes[i].type)!.outputs[0].key,
    target: nodes[i + 1].id,
    targetHandle: input ?? REGISTRY.get(nodes[i + 1].type)!.inputs[0].key,
  }));
  return { version: 1, nodes, edges };
}

/** Ready-made graphs for common jobs; the user drops in the input and presses Render. */
export const TEMPLATES: { id: string; title: string; build(): Graph }[] = [
  { id: "dither", title: "Dither an image", build: starterGraph },
  {
    id: "video-ascii",
    title: "Video to ASCII MP4",
    build: () =>
      chain([
        ["input.video", {}],
        ["media.transform", { resize: "long-edge", size: 960 }],
        ["ascii.convert", {}],
        ["video.encode", { container: "mp4", name: "ascii" }],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "download-gif",
    title: "Link to GIF",
    build: () =>
      chain([
        ["input.download", { quality: "480" }],
        ["media.transform", { resize: "long-edge", size: 480 }],
        ["video.encode", { container: "gif", fps: 12, name: "clip" }],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "mp3",
    title: "Sound from a video as MP3",
    build: () =>
      chain([
        ["input.video", {}],
        ["video.extract-audio", {}],
        ["audio.convert", { format: "mp3" }],
        ["output.save-file", {}, "file"],
      ]),
  },
  {
    id: "photos-pdf",
    title: "Photos to PDF",
    build: () =>
      chain([
        ["input.images", {}],
        ["pdf.from-images", { name: "photos" }],
        ["output.save-file", {}, "file"],
      ]),
  },
  {
    id: "pdf-watermark",
    title: "Watermark and protect a PDF",
    build: () =>
      chain([
        ["input.pdf", {}],
        ["pdf.stamp", {}],
        ["pdf.protect", {}],
        ["output.save-file", {}, "file"],
      ]),
  },
  {
    id: "romanian",
    title: "Clean up Romanian text",
    build: () =>
      chain([
        ["input.text", { text: "Lipeste aici textul fara diacritice." }],
        ["text.diacritics", {}],
        ["output.save-text", { name: "text-cu-diacritice" }],
      ]),
  },
  {
    id: "webcam",
    title: "Record the webcam, dithered",
    build: () =>
      chain([
        ["input.webcam", {}],
        ["dither.recipe", {}],
        ["video.encode", { container: "mp4", name: "webcam" }],
        ["output.save-file", {}],
      ]),
  },
];
