import { checkGraph, type CheckedGraph } from "./graph-file";
import { REGISTRY } from "./nodes";
import type { Graph, GraphNode } from "./runtime/types";
import type { WorkflowForm } from "./simple-form";

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

/** Reads a saved graph, repairing what it can; `notes` says what was repaired. */
export function readGraph(text: string): CheckedGraph {
  return checkGraph(text, (type) => REGISTRY.get(type)?.defaults(), newId);
}

/** A saved graph, repaired where needed (nodes of unknown types, wires that point nowhere or loop). */
export function parseGraph(text: string): Graph {
  return readGraph(text).graph;
}

/**
 * Saved graphs don't carry dropped files, so file inputs come back empty. Files are indented for
 * people to read; the autosave passes `indent` 0, as it keeps every open graph in a few MB.
 */
export function serializeGraph(g: Graph, indent = 2): string {
  const nodes = g.nodes.map((n) => {
    const params = { ...n.params };
    if ("assetId" in params) params.assetId = "";
    if ("assetIds" in params) params.assetIds = [];
    return { ...n, params };
  });
  return JSON.stringify({ ...g, nodes }, null, indent || undefined);
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
  /** How Simple view shows it (see simple-form.ts). */
  form: WorkflowForm;
}

/** Ready-made graphs for common jobs; the user fills in the input and presses Render. */
export const WORKFLOWS: Workflow[] = [
  {
    id: "download-video",
    title: "Download a video",
    description: "Paste a YouTube (or Vimeo, Instagram, TikTok…) link and save the video as it is. A playlist link saves every video.",
    build: () =>
      chain([
        ["input.download", {}, undefined, "file"],
        ["output.save-file", {}],
      ]),
    form: {
      input: { node: 0, kind: "link", label: "Link to the video or playlist" },
      fields: [
        { node: 0, param: "playlist", label: "This link is in a playlist" },
        { node: 0, param: "which", label: "Which videos" },
        { node: 0, param: "quality", label: "Quality" },
      ],
      action: "Download",
      topic: "link",
    },
  },
  {
    id: "download-mp3",
    title: "Download the sound as MP3",
    description: "Paste a YouTube or SoundCloud link and save just the sound, as an MP3. A playlist link saves one MP3 per video.",
    build: () =>
      chain([
        ["input.download", { quality: "mp3" }, undefined, "file"],
        ["output.save-file", {}],
      ]),
    form: {
      input: { node: 0, kind: "link", label: "Link to the video, song or playlist" },
      fields: [
        { node: 0, param: "playlist", label: "This link is in a playlist" },
        { node: 0, param: "which", label: "Which videos" },
      ],
      action: "Download",
      topic: "sound",
    },
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
    form: {
      input: { node: 0, kind: "file", label: "Your video", accept: "video/*" },
      fields: [{ node: 2, param: "format", label: "Format" }],
      preview: 0,
      action: "Extract the sound",
      topic: "sound",
    },
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
    form: {
      input: { node: 0, kind: "file", label: "Your video", accept: "video/*" },
      fields: [
        { node: 1, param: "size", label: "Longest side (pixels)" },
        { node: 2, param: "quality", label: "Quality" },
      ],
      action: "Shrink",
      topic: "video",
    },
  },
  {
    id: "split-video",
    title: "Split a video into clips",
    description: "Drop in a video and save it as 30-second clips, or pick the times to cut at.",
    build: () =>
      chain([
        ["input.video", {}],
        ["media.split", { mode: "every", every: 30 }, "video", "clips"],
        ["output.save-file", {}],
      ]),
    form: {
      input: { node: 0, kind: "file", label: "Your video", accept: "video/*" },
      fields: [
        { node: 1, param: "mode", label: "Split" },
        { node: 1, param: "every", label: "Clip length (1:30 or 90)" },
        { node: 1, param: "count", label: "Number of clips" },
        { node: 1, param: "at", label: "Cut at" },
      ],
      action: "Split",
      topic: "video",
    },
  },
  {
    id: "cut-audio",
    title: "Cut a part out of a sound",
    description: "Drop in a sound, set Start and End, and save it with that part taken out.",
    build: () =>
      chain([
        ["input.audio", {}],
        ["audio.cut", { mode: "remove" }],
        ["output.save-file", {}, "file"],
      ]),
    form: {
      input: { node: 0, kind: "file", label: "Your sound", accept: "audio/*" },
      fields: [
        { node: 1, param: "mode", label: "This part" },
        { node: 1, param: "start", label: "From (1:05 or 65)" },
        { node: 1, param: "end", label: "To (0 = the end)" },
      ],
      action: "Cut",
      topic: "sound",
    },
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
    form: {
      input: { node: 0, kind: "file", label: "Your video", accept: "video/*" },
      fields: [
        { node: 1, param: "size", label: "Longest side (pixels)" },
        { node: 2, param: "fps", label: "Frames per second" },
      ],
      action: "Make GIF",
      topic: "video",
    },
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
    form: {
      input: { node: 0, kind: "link", label: "Link to the video" },
      fields: [
        { node: 1, param: "size", label: "Longest side (pixels)" },
        { node: 2, param: "fps", label: "Frames per second" },
      ],
      action: "Make GIF",
      topic: "link",
    },
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
    form: {
      input: { node: 0, kind: "file", label: "Your photo", accept: "image/*" },
      fields: [
        { node: 1, param: "format", label: "Format" },
        { node: 1, param: "quality", label: "Quality" },
        { node: 1, param: "maxKB", label: "Largest size (KB, 0 = no limit)" },
      ],
      action: "Compress",
      topic: "image",
    },
  },
  {
    id: "compress-photos",
    title: "Compress many photos",
    description: "Drop in a pile of photos and save each as a JPEG under 500 KB, into one folder.",
    build: () =>
      chain([
        ["input.images", {}],
        ["media.encode", { format: "jpeg", quality: 80, maxKB: 500 }],
        ["output.save-file", {}],
      ]),
    form: {
      input: { node: 0, kind: "files", label: "Your photos", accept: "image/*" },
      fields: [
        { node: 1, param: "format", label: "Format" },
        { node: 1, param: "quality", label: "Quality" },
        { node: 1, param: "maxKB", label: "Largest size (KB, 0 = no limit)" },
      ],
      action: "Compress",
      topic: "image",
    },
  },
  {
    id: "watermark-photos",
    title: "Watermark photos",
    description: "Drop in photos, type your name, and save each with it in the corner.",
    build: () =>
      chain([
        ["input.images", {}],
        ["image.overlay", {}],
        ["media.encode", { format: "jpeg", quality: 88 }],
        ["output.save-file", {}],
      ]),
    form: {
      input: { node: 0, kind: "files", label: "Your photos", accept: "image/*" },
      fields: [
        { node: 1, param: "text", label: "Your text" },
        { node: 1, param: "position", label: "Where" },
        { node: 1, param: "size", label: "Text size (%)" },
        { node: 1, param: "color", label: "Colour" },
      ],
      preview: 1,
      action: "Watermark",
      topic: "image",
    },
  },
  {
    id: "compress-folder",
    title: "Compress a folder of photos",
    description: "Pick a folder once and save each photo in it as a JPEG under 500 KB. Run it again later and only the new photos are done.",
    build: () =>
      chain([
        ["input.folder", { onlyNew: true }],
        ["media.encode", { format: "jpeg", quality: 80, maxKB: 500 }],
        ["output.save-file", { exists: "skip" }],
      ]),
    form: {
      input: { node: 0, kind: "folder", label: "Your folder of photos" },
      fields: [
        { node: 1, param: "quality", label: "Quality" },
        { node: 1, param: "maxKB", label: "Largest size (KB, 0 = no limit)" },
        { node: 0, param: "onlyNew", label: "Only photos not done before" },
        { node: 0, param: "subfolders", label: "Include sub-folders" },
      ],
      action: "Compress",
      topic: "image",
    },
  },
  {
    id: "watermark-folder",
    title: "Watermark a folder of photos",
    description: "Pick a folder once, type your name, and save each photo with it in the corner. Run it again later and only the new photos are done.",
    build: () =>
      chain([
        ["input.folder", { onlyNew: true }],
        ["image.overlay", {}],
        ["media.encode", { format: "jpeg", quality: 88 }],
        ["output.save-file", { exists: "skip" }],
      ]),
    form: {
      input: { node: 0, kind: "folder", label: "Your folder of photos" },
      fields: [
        { node: 1, param: "text", label: "Your text" },
        { node: 1, param: "position", label: "Where" },
        { node: 1, param: "size", label: "Text size (%)" },
        { node: 0, param: "onlyNew", label: "Only photos not done before" },
      ],
      preview: 1,
      action: "Watermark",
      topic: "image",
    },
  },
  {
    id: "remove-background",
    title: "Remove the background",
    description: "Drop in a photo and save the subject as a PNG with a transparent background. Works offline after the first run.",
    build: () =>
      chain([
        ["input.file", {}],
        ["image.removebg", {}],
        ["output.save-file", { name: "no-background" }, "file"],
      ]),
    form: {
      input: { node: 0, kind: "file", label: "Your photo", accept: "image/*" },
      fields: [
        { node: 1, param: "model", label: "Quality" },
        { node: 1, param: "fill", label: "Background" },
        { node: 1, param: "color", label: "Colour" },
      ],
      action: "Remove the background",
      topic: "image",
    },
  },
  {
    id: "remove-background-photos",
    title: "Remove the background from many photos",
    description: "Drop in a pile of photos and save each cut-out as a transparent PNG, into one folder.",
    build: () =>
      chain([
        ["input.images", {}],
        ["image.removebg", {}],
        ["output.save-file", {}, "file"],
      ]),
    form: {
      input: { node: 0, kind: "files", label: "Your photos", accept: "image/*" },
      fields: [
        { node: 1, param: "model", label: "Quality" },
        { node: 1, param: "fill", label: "Background" },
        { node: 1, param: "color", label: "Colour" },
      ],
      action: "Remove the backgrounds",
      topic: "image",
    },
  },
  {
    id: "dither",
    title: "Dither an image",
    description: "Drop in an image, pick a look, save a PNG.",
    build: starterGraph,
    form: {
      input: { node: 0, kind: "file", label: "Your image", accept: "image/*" },
      fields: [
        { node: 1, param: "recipe", label: "Look" },
        { node: 1, param: "size", label: "Size" },
      ],
      action: "Dither",
      topic: "image",
    },
  },
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
    form: {
      input: { node: 0, kind: "file", label: "Your video", accept: "video/*" },
      fields: [
        { node: 1, param: "size", label: "Longest side (pixels)" },
        { node: 3, param: "quality", label: "Quality" },
      ],
      action: "Convert",
      topic: "video",
    },
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
    form: {
      input: { node: 0, kind: "files", label: "Your photos", accept: "image/*" },
      fields: [{ node: 1, param: "quality", label: "Photo quality" }],
      action: "Make PDF",
      topic: "pdf",
    },
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
    form: {
      input: { node: 0, kind: "file", label: "Your PDF", accept: "application/pdf,.pdf" },
      fields: [
        { node: 1, param: "watermark", label: "Watermark text" },
        { node: 1, param: "numbers", label: "Number the pages" },
        { node: 2, param: "password", label: "Password to open it" },
      ],
      action: "Protect",
      topic: "pdf",
    },
  },
  {
    id: "qr-code",
    title: "QR code for a link",
    description: "Type a link (or Wi-Fi details) and save a QR code as a PNG. The SVG output makes a scalable .svg.",
    build: () =>
      chain([
        ["input.qr", {}],
        ["output.save-file", { name: "qr-code" }, "file"],
      ]),
    form: {
      input: { node: 0, kind: "text", label: "Link or text" },
      blurb: "Type a link or some text and save a QR code as a PNG.",
      fields: [{ node: 0, param: "size", label: "Size (pixels)" }],
      action: "Make QR code",
      topic: "link",
    },
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
    form: {
      input: { node: 0, kind: "text", label: "Your text" },
      fields: [{ node: 1, param: "keepExisting", label: "Keep diacritics already there" }],
      action: "Add diacritics",
      topic: "text",
    },
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
    form: {
      input: { node: 0, kind: "camera", label: "Your camera" },
      blurb: "Record yourself through a dither effect and save an MP4. Record starts, Stop ends.",
      fields: [
        { node: 1, param: "recipe", label: "Look" },
        { node: 0, param: "sound", label: "Record sound" },
      ],
      action: "Record",
      topic: "camera",
    },
  },
];

/** The workflows this app can run: a browser tab can't read folders on the computer. */
export const workflowsFor = (desktop: boolean) => WORKFLOWS.filter((w) => desktop || w.form.input.kind !== "folder");

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
