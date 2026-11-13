// Download node: a link from YouTube, Vimeo, SoundCloud and the many other
// sites yt-dlp supports, fetched by the desktop app.
import type { DiskMedia, FileValue, Graph, GraphNode, NodeDef, Params, RunContext, Value, VideoValue } from "../runtime/types";
import { DownloadJobs, STOPPED } from "./download-jobs";
import { lastError, nativeTools, scratchFiles } from "./native";
import { ENTRY_TEMPLATE, entryFileName, hasOneVideo, isPlaylistLink, parsePlaylist, pickEntries, playlistFolder, type Playlist, type PlaylistEntry } from "./playlist";
import { bytesOfDisk, diskMedia } from "./source";
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
  // yt-dlp converts with Toolbox's ffmpeg, so each video of a playlist comes out as an MP3 file to save.
  if (quality === "mp3") return ["-f", "ba", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
  const h = /^\d+$/.test(quality) ? `[height<=${quality}]` : "";
  return ["-f", `bv*${h}[vcodec^=avc1]+ba[ext=m4a]/bv*${h}+ba/b${h}/b`, "--merge-output-format", "mp4"];
}

// Downloads are kept for the session (in the scratch folder), so editing other nodes never fetches again.
const downloads = new DownloadJobs<DiskMedia>();
/** Playlists' lists of videos, read once per link for the session too. */
const playlists = new DownloadJobs<Playlist>();
/** The playlists read so far, by link, so pruning knows which video each playlist node shows. */
const knownPlaylists = new Map<string, Playlist>();

const keyOf = (url: string, quality: string) => `${quality} ${url}`;

/** Whether the node downloads a whole playlist: a playlist link, unless the link is also one video and "Just this video" is picked. */
function wantsPlaylist(p: Params): boolean {
  const url = String(p.url ?? "").trim();
  return isPlaylistLink(url) && !(hasOneVideo(url) && p.playlist === "one");
}

/** The playlist's videos the node downloads, and the one its Video and Audio outputs show. */
function chosen(list: Playlist, p: Params): { picked: PlaylistEntry[]; shown: number } {
  const picked = pickEntries(list.entries, String(p.which ?? ""));
  const shown = Math.min(picked.length, Math.max(1, Math.round(Number(p.item) || 1))) - 1;
  return { picked, shown };
}

/** The fetches a node asks for while previewing: its link, or its playlist's list and the video it shows. */
function wantedKeys(n: GraphNode): string[] {
  const url = String(n.params.url ?? "").trim();
  const quality = String(n.params.quality || "1080");
  if (!wantsPlaylist(n.params)) return [keyOf(url, quality)];
  const keys = [url];
  const list = knownPlaylists.get(url);
  if (list) {
    try {
      const { picked, shown } = chosen(list, n.params);
      keys.push(keyOf(picked[shown].url, quality));
    } catch {
      // "Which videos" picks nothing: no video is wanted.
    }
  }
  return keys;
}

/** Stops every download still running (the Stop download button, while a pasted link downloads). */
export function stopDownloads() {
  downloads.stop();
  playlists.stop();
}

/**
 * A new preview is coming: preview downloads no node asks for any more (the link was changed
 * or the node deleted) stop now, instead of finishing in the background before the new one starts.
 */
export function pruneDownloads(graph: Graph) {
  const wanted = new Set(graph.nodes.filter((n) => n.type === "input.download").flatMap(wantedKeys));
  downloads.prune(wanted);
  playlists.prune(wanted);
}

/**
 * Lists a playlist's videos without downloading them (yt-dlp --flat-playlist), once per link.
 * The list goes to a file rather than the log, which only keeps its last few thousand characters.
 */
function listOnce(url: string, ctx: RunContext): Promise<Playlist> {
  return playlists.get(url, ctx.mode, ctx.signal, async (signal) => {
    const tools = nativeTools();
    if (!tools?.ytdlp) throw new Error("Downloading needs the desktop app");
    ctx.progress?.(0, "Reading the playlist");
    const r = await tools.run(
      "yt-dlp",
      ["--yes-playlist", "--flat-playlist", "--skip-download", "--ignore-errors", "--print-to-file", ENTRY_TEMPLATE, "playlist.txt", "--", url],
      {},
      { signal },
    );
    if (signal.aborted) throw new Error("Cancelled");
    const out = r.files["playlist.txt"];
    const list = parsePlaylist(out ? new TextDecoder().decode(out) : "");
    if (!list.entries.length) {
      if (r.code !== 0) throw new Error(`yt-dlp: ${lastError(r.log)}`);
      throw new Error(list.unavailable ? "None of the playlist's videos can be watched (private or deleted)" : "The playlist is empty");
    }
    knownPlaylists.set(url, list);
    return list;
  });
}

/**
 * Downloads a link once. The file stays in the scratch folder, where yt-dlp wrote it, for the rest
 * of the session: the video is read from there a range at a time, and Save copies it from there.
 */
function fetchOnce(url: string, quality: string, ctx: RunContext, label = "Downloading"): Promise<DiskMedia> {
  return downloads.get(keyOf(url, quality), ctx.mode, ctx.signal, async (signal) => {
    const tools = nativeTools();
    if (!tools?.ytdlp) throw new Error("Downloading needs the desktop app");
    const r = await tools.run(
      "yt-dlp",
      ["--no-playlist", "--newline", "--no-mtime", ...formatFor(quality), "-o", "%(title).80B [%(id)s].%(ext)s", "--", url],
      {},
      { onProgress: (f, l) => ctx.progress?.(f, l ?? label), signal, keep: true },
    );
    const [name, kept] = Object.entries(r.files)[0] ?? [];
    if (signal.aborted) {
      if (kept) scratchFiles()?.free([kept.path]);
      throw new Error("Cancelled");
    }
    if (r.code !== 0 || !name || !kept) throw new Error(`yt-dlp: ${lastError(r.log)}`);
    scratchFiles()?.hold(kept.path);
    const ext = name.split(".").pop()!.toLowerCase();
    return diskMedia(kept.path, kept.size, name, MIME[ext] ?? "application/octet-stream");
  });
}

export const soundOnly = (quality: unknown) => quality === "audio" || quality === "mp3";

const plural = (n: number, one: string) => `${n.toLocaleString("en")} ${one}${n === 1 ? "" : "s"}`;

/** The downloads as they came, for Save: one file per video, in a folder named after the playlist. */
function fileList(files: FileValue[], about: string): VideoValue {
  return {
    kind: "video",
    of: "file",
    width: 0,
    height: 0,
    duration: files.length,
    fps: 1,
    poster: files[0],
    about,
    async *frames() {
      for (let i = 0; i < files.length; i++) yield { value: files[i], timestamp: i, duration: 1, name: files[i].name };
    },
  };
}

const asFile = (file: DiskMedia, name = file.name): FileValue => ({ kind: "file", name, mime: file.type || "application/octet-stream", data: bytesOfDisk(file) });

/** What the Video and Audio outputs carry: one downloaded video (or sound). */
async function mediaOutputs(file: DiskMedia, quality: string, params: Params, ctx: RunContext, about?: string): Promise<Record<string, Value>> {
  if (soundOnly(quality)) return { audio: await soundOf(file) };
  const video = await (await videoCodec()).videoFromFile(file, params, ctx);
  if (about) video.about = about;
  if (!video.audioSource) return { video };
  return { video, audio: await soundOf(file, video.duration) };
}

/**
 * A whole playlist. A preview reads the list and downloads only the video it shows; Render
 * downloads every picked video, one after the other. A video that won't download (blocked in
 * this country, removed since the list was read) is left out instead of stopping the rest.
 */
async function runPlaylist(url: string, quality: string, params: Params, ctx: RunContext): Promise<Record<string, Value>> {
  const list = await listOnce(url, ctx);
  const { picked, shown } = chosen(list, params);
  const folder = playlistFolder(list.title);
  const last = picked[picked.length - 1].index;
  const named = (e: PlaylistEntry, f: DiskMedia) => asFile(f, entryFileName(folder, e.index, last, f.name));
  const name = list.title || "the playlist";
  if (ctx.mode === "preview") {
    const file = await fetchOnce(picked[shown].url, quality, ctx, `Video ${shown + 1} of ${picked.length}: downloading`);
    const about = `Video ${shown + 1} of ${plural(picked.length, "video")} · ${name}`;
    return { ...(await mediaOutputs(file, quality, params, ctx, about)), file: fileList([named(picked[shown], file)], about) };
  }
  const files: FileValue[] = [];
  const failed: string[] = [];
  let shownFile: DiskMedia | undefined;
  for (let i = 0; i < picked.length; i++) {
    if (ctx.signal?.aborted) throw new Error("Cancelled");
    const e = picked[i];
    const step = (f: number, label?: string) => ctx.progress?.((i + Math.min(1, Math.max(0, f))) / picked.length, `Video ${i + 1} of ${picked.length}: ${(label ?? "downloading").toLowerCase()}`);
    try {
      const file = await fetchOnce(e.url, quality, { ...ctx, progress: step });
      files.push(named(e, file));
      if (i === shown) shownFile = file;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (ctx.signal?.aborted || why === "Cancelled" || why === STOPPED) throw err;
      failed.push(`${e.index}. ${e.title}: ${why}`);
    }
  }
  if (!files.length) throw new Error(`None of the videos downloaded. ${failed[0] ?? ""}`.trim());
  const skipped = failed.length + list.unavailable;
  const about = `${plural(files.length, "video")} from ${name}${skipped ? ` · ${skipped} skipped` : ""}`;
  for (const f of failed) console.warn(`Toolbox: playlist video left out: ${f}`);
  const media = shownFile ? await mediaOutputs(shownFile, quality, params, ctx, about) : {};
  return { ...media, file: fileList(files, about) };
}

export const download: NodeDef = {
  type: "input.download",
  title: "Download from link",
  category: "input",
  description:
    "Paste a link from YouTube, Vimeo, SoundCloud, Instagram and many more sites. Downloads with yt-dlp in the desktop app, once per link. File is the download as it came, for Save file. A playlist link downloads every video on Render: File is then one file per video, in a folder named after the playlist, and Video and Audio show the video picked under Show video.",
  inputs: [],
  outputs: [
    { key: "video", label: "Video", type: "video" },
    { key: "audio", label: "Audio", type: "audio" },
    { key: "file", label: "File", type: "file" },
  ],
  params: [
    { key: "url", label: "Link", kind: "text", commit: true, placeholder: "https://…" },
    {
      key: "playlist",
      label: "This link is in a playlist",
      kind: "select",
      options: [
        { value: "all", label: "Download the whole playlist" },
        { value: "one", label: "Just this video" },
      ],
    },
    { key: "which", label: "Which videos", kind: "text", commit: true, placeholder: "All, or 1-10, 15, 20-" },
    { key: "item", label: "Show video", kind: "number", min: 1, max: 5000, step: 1 },
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
        { value: "mp3", label: "Sound only, as MP3" },
      ],
    },
    { key: "at", label: "Preview at %", kind: "number", min: 0, max: 100, step: 0.5 },
  ],
  defaults: () => ({ url: "", playlist: "all", which: "", item: 1, quality: "1080", at: 10 }),
  visible: (key, p) => {
    if (key === "at") return !soundOnly(p.quality);
    if (key === "playlist") return isPlaylistLink(String(p.url ?? "")) && hasOneVideo(String(p.url ?? ""));
    if (key === "which" || key === "item") return wantsPlaylist(p);
    return true;
  },
  kind: "frame",
  cacheKey: (_p, ctx) => ctx.mode,
  previewParams: ["at"],
  async run(_inputs, params, ctx): Promise<Record<string, Value>> {
    const url = String(params.url ?? "").trim();
    if (!url) throw new Error("Paste a link in the inspector");
    if (!/^https?:\/\//i.test(url)) throw new Error("Links start with http:// or https://");
    const quality = String(params.quality || "1080");
    if (wantsPlaylist(params)) return runPlaylist(url, quality, params, ctx);
    const file = await fetchOnce(url, quality, ctx);
    // The download as it came, still on disk: Save copies it from there.
    return { ...(await mediaOutputs(file, quality, params, ctx)), file: asFile(file) };
  },
};
