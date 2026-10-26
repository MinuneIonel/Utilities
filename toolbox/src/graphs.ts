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
  const c = newNode("output.save-file", { x: 640, y: 120 });
  c.params.name = "dithered";
  return {
    version: 1,
    nodes: [a, b, c],
    edges: [
      { id: newId("e"), source: a.id, sourceHandle: "image", target: b.id, targetHandle: "image" },
      { id: newId("e"), source: b.id, sourceHandle: "image", target: c.id, targetHandle: "file" },
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

/** A ready-made chain for a common job, dropped into the graph from the Workflows tab. */
export interface Workflow {
  id: string;
  title: string;
  description: string;
  build(): Graph;
}

/** Ready-made graphs for common jobs; the user fills in the input and presses Render. */
export const WORKFLOWS: Workflow[] = [
  {
    id: "download-video",
    title: "Download a video",
    description: "Paste a YouTube (or Vimeo, Instagram, TikTok…) link and save the video as it is.",
    build: () =>
      chain([
        ["input.download", {}, undefined, "file"],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "download-mp3",
    title: "Download the sound as MP3",
    description: "Paste a YouTube or SoundCloud link and save just the sound, as an MP3.",
    build: () =>
      chain([
        ["input.download", { quality: "audio" }, undefined, "audio"],
        ["audio.convert", { format: "mp3" }],
        ["output.save-file", {}, "file"],
      ]),
  },
  {
    id: "extract-audio",
    title: "Extract audio from a video",
    description: "Drop in a video and save its sound track as an MP3.",
    build: () =>
      chain([
        ["input.video", {}],
        ["video.extract-audio", {}],
        ["audio.convert", { format: "mp3" }],
        ["output.save-file", {}, "file"],
      ]),
  },
  {
    id: "shrink-video",
    title: "Shrink a video for sharing",
    description: "Drop in a video; it comes out as a smaller 720p MP4 that sends easily.",
    build: () =>
      chain([
        ["input.video", {}],
        ["media.transform", { resize: "long-edge", size: 1280 }],
        ["video.encode", { container: "mp4", quality: "medium", name: "small" }],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "video-gif",
    title: "Video to GIF",
    description: "Drop in a short video and save it as a 480px GIF.",
    build: () =>
      chain([
        ["input.video", {}],
        ["media.transform", { resize: "long-edge", size: 480 }],
        ["video.encode", { container: "gif", fps: 12, name: "clip" }],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "download-gif",
    title: "Link to GIF",
    description: "Paste a video link and save it as a 480px GIF.",
    build: () =>
      chain([
        ["input.download", { quality: "480" }],
        ["media.transform", { resize: "long-edge", size: 480 }],
        ["video.encode", { container: "gif", fps: 12, name: "clip" }],
        ["output.save-file", {}],
      ]),
  },
  {
    id: "compress-image",
    title: "Compress an image",
    description: "Drop in a photo and save it as a JPEG under 500 KB.",
    build: () =>
      chain([
        ["input.file", {}],
        ["media.encode", { format: "jpeg", quality: 80, maxKB: 500 }],
        ["output.save-file", {}],
      ]),
  },
  { id: "dither", title: "Dither an image", description: "Drop in an image, pick a look, save a PNG.", build: starterGraph },
  {
    id: "video-ascii",
    title: "Video to ASCII MP4",
    description: "Drop in a video and turn every frame into ASCII art.",
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
    id: "photos-pdf",
    title: "Photos to PDF",
    description: "Drop in several photos and save them as one PDF, a page each.",
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
    description: "Drop in a PDF, stamp text on every page and lock it with a password.",
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
    description: "Paste Romanian text without diacritics and get it back with ă, â, î, ș and ț.",
    build: () =>
      chain([
        ["input.text", { text: "Lipeste aici textul fara diacritice." }],
        ["text.diacritics", {}],
        ["output.save-file", { name: "text-cu-diacritice" }, "file"],
      ]),
  },
  {
    id: "webcam",
    title: "Record the webcam, dithered",
    description: "Record yourself through a dither effect and save an MP4. Render starts, Stop ends.",
    build: () =>
      chain([
        ["input.webcam", {}],
        ["dither.recipe", {}],
        ["video.encode", { container: "mp4", name: "webcam" }],
        ["output.save-file", {}],
      ]),
  },
];

/** A workflow's graph moved so its first node sits at `at`, with fresh ids so it can go next to anything. */
export function placeWorkflow(w: Workflow, at: { x: number; y: number }): Graph {
  const g = w.build();
  const origin = g.nodes[0]?.position ?? { x: 0, y: 0 };
  const ids = new Map(g.nodes.map((n) => [n.id, newId("n")]));
  return {
    version: 1,
    nodes: g.nodes.map((n) => ({ ...n, id: ids.get(n.id)!, position: { x: n.position.x - origin.x + at.x, y: n.position.y - origin.y + at.y } })),
    edges: g.edges.map((e) => ({ ...e, id: newId("e"), source: ids.get(e.source)!, target: ids.get(e.target)! })),
  };
}
