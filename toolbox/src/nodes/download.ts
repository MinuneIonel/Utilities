// Download node: a link from YouTube, Vimeo, SoundCloud and the many other
// sites yt-dlp supports, fetched by the desktop app.
import type { NodeDef, RunContext, Value } from "../runtime/types";
import { lastError, nativeTools } from "./native";
import { soundOf, videoCodec } from "./video";

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  ogg: "audio/ogg",
};

/** yt-dlp format choices: H.264 + AAC where the site has it, since every Mac decodes those in hardware. */
function formatFor(quality: string): string[] {
  if (quality === "audio") return ["-f", "ba[ext=m4a]/ba"];
  const h = /^\d+$/.test(quality) ? `[height<=${quality}]` : "";
  return ["-f", `bv*${h}[vcodec^=avc1]+ba[ext=m4a]/bv*${h}+ba/b${h}/b`, "--merge-output-format", "mp4"];
}

// Downloads are kept for the session, so editing other nodes never fetches again.
const downloads = new Map<string, Promise<File>>();

function fetchOnce(url: string, quality: string, ctx: RunContext): Promise<File> {
  const key = `${quality} ${url}`;
  let p = downloads.get(key);
  if (!p) {
    p = (async () => {
      const tools = nativeTools();
      if (!tools?.ytdlp) throw new Error("Downloading needs the desktop app");
      const r = await tools.run(
        "yt-dlp",
        ["--no-playlist", "--newline", "--no-mtime", ...formatFor(quality), "-o", "%(title).80B [%(id)s].%(ext)s", "--", url],
        {},
        { onProgress: (f, l) => ctx.progress?.(f, l ?? "Downloading"), signal: ctx.signal },
      );
      const [name, bytes] = Object.entries(r.files)[0] ?? [];
      if (r.code !== 0 || !name || !bytes) throw new Error(`yt-dlp: ${lastError(r.log)}`);
      const ext = name.split(".").pop()!.toLowerCase();
      return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: MIME[ext] ?? "application/octet-stream" });
    })();
    downloads.set(key, p);
    p.catch(() => downloads.delete(key));
  }
  return p;
}

export const download: NodeDef = {
  type: "input.download",
  title: "Download (yt-dlp)",
  category: "input",
  description: "Paste a link from YouTube, Vimeo, SoundCloud, Instagram and many more sites. Downloads with yt-dlp in the desktop app, once per link.",
  inputs: [],
  outputs: [
    { key: "video", label: "Video", type: "video" },
    { key: "audio", label: "Audio", type: "audio" },
  ],
  params: [
    { key: "url", label: "Link", kind: "text", commit: true, placeholder: "https://…" },
    {
      key: "quality",
      label: "Quality",
      kind: "select",
      options: [
        { value: "best", label: "Best" },
        { value: "1080", label: "Up to 1080p" },
        { value: "720", label: "Up to 720p" },
        { value: "480", label: "Up to 480p" },
        { value: "audio", label: "Sound only" },
      ],
    },
    { key: "at", label: "Preview at %", kind: "number", min: 0, max: 100, step: 0.5 },
  ],
  defaults: () => ({ url: "", quality: "1080", at: 10 }),
  visible: (key, p) => key !== "at" || p.quality !== "audio",
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  async run(_inputs, params, ctx): Promise<Record<string, Value>> {
    const url = String(params.url ?? "").trim();
    if (!url) throw new Error("Paste a link in the inspector");
    if (!/^https?:\/\//i.test(url)) throw new Error("Links start with http:// or https://");
    const quality = String(params.quality || "1080");
    const file = await fetchOnce(url, quality, ctx);
    if (quality === "audio") return { audio: await soundOf(file) };
    const video = await (await videoCodec()).videoFromBlob(file, params, ctx);
    if (!video.audioSource) return { video };
    return { video, audio: await soundOf(file, video.duration) };
  },
};
