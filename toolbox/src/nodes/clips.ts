// Where Split into clips cuts, and which format a cut sound keeps. Plain data,
// no I/O, so it is tested in Node.
import { isAudioFormat, type AudioFormat } from "../../../audio/src/engine/formats.ts";
import type { TimeRange } from "./ffmpeg-video";

/** A Save of more clips than this is almost certainly a typo in the settings. */
export const MAX_CLIPS = 500;

/** Seconds from "75", "75.5", "1:15", "1:02:03" or "1:15.5"; NaN when it isn't a time. */
export function parseTime(s: string): number {
  const t = s.trim();
  if (!/^\d+(?:\.\d+)?$|^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(t)) return NaN;
  return t.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

const list = (s: string) => s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

function time(s: string): number {
  const t = parseTime(s);
  if (!Number.isFinite(t)) throw new Error(`"${s}" isn't a time. Write seconds (75) or minutes:seconds (1:15).`);
  return t;
}

export type SplitMode = "every" | "count" | "at" | "parts";

/** The clips to cut from something `duration` seconds long, in its own seconds. */
export function clipRanges(duration: number, mode: SplitMode, opts: { every?: number; count?: number; at?: string; parts?: string }): TimeRange[] {
  if (!(duration > 0)) throw new Error("Its length isn't known, so it can't be split");
  const out: TimeRange[] = [];
  if (mode === "every") {
    const len = Number(opts.every);
    if (!(len > 0)) throw new Error("Set how long each clip is");
    if (duration / len > MAX_CLIPS) throw new Error(`That makes more than ${MAX_CLIPS} clips. Make them longer.`);
    for (let t = 0; t < duration - 0.05; t += len) out.push({ start: t, end: Math.min(duration, t + len) });
    // A sliver under 0.05 s at the end joins the last clip.
    if (out.length) out[out.length - 1].end = duration;
  } else if (mode === "count") {
    const n = Math.floor(Number(opts.count));
    if (!(n >= 1)) throw new Error("Set how many clips");
    if (n > MAX_CLIPS) throw new Error(`At most ${MAX_CLIPS} clips`);
    for (let i = 0; i < n; i++) out.push({ start: (duration * i) / n, end: (duration * (i + 1)) / n });
  } else if (mode === "at") {
    const cuts = [...new Set(list(opts.at ?? "").map(time))].filter((t) => t > 0.05 && t < duration - 0.05).sort((a, b) => a - b);
    if (cuts.length + 1 > MAX_CLIPS) throw new Error(`At most ${MAX_CLIPS} clips`);
    const edges = [0, ...cuts, duration];
    for (let i = 0; i + 1 < edges.length; i++) out.push({ start: edges[i], end: edges[i + 1] });
  } else {
    for (const part of list(opts.parts ?? "")) {
      const m = /^(.*?)\s*(?:-|–|—|to)\s*(.*)$/.exec(part);
      if (!m) throw new Error(`"${part}" isn't a part. Write start-end, like 0:10-0:25.`);
      const start = time(m[1]);
      const end = m[2].trim() === "" || /^end$/i.test(m[2].trim()) ? duration : Math.min(duration, time(m[2]));
      if (start >= duration) throw new Error(`${part} starts after the end (${duration.toFixed(1)} s)`);
      if (!(end > start)) throw new Error(`${part} ends before it starts`);
      out.push({ start, end });
    }
    if (!out.length) throw new Error("List the parts to keep, like 0:10-0:25, 1:00-1:30");
    if (out.length > MAX_CLIPS) throw new Error(`At most ${MAX_CLIPS} clips`);
  }
  return out;
}

/** File names for n clips: name-1 … name-n, zero-padded so they sort in order. */
export function clipNames(base: string, n: number, ext: string): string[] {
  const width = String(n).length;
  return Array.from({ length: n }, (_, i) => `${base}-${String(i + 1).padStart(width, "0")}.${ext}`);
}

/** The audio format closest to a file's own, so cutting a sound doesn't change what it is. */
export function audioFormatOf(name: string): AudioFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (isAudioFormat(ext)) return ext;
  if (ext === "oga") return "ogg";
  if (ext === "webm") return "opus";
  return "m4a";
}
