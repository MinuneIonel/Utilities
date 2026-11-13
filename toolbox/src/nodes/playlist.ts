// Playlists for the Download node: which links are playlists, reading yt-dlp's list of a
// playlist's videos, and picking some of them. Kept apart from yt-dlp so it can be tested on its own.

/** One video of a playlist, as yt-dlp lists it without downloading anything. */
export interface PlaylistEntry {
  /** Its place in the playlist, from 1. */
  index: number;
  id: string;
  url: string;
  title: string;
}

export interface Playlist {
  title: string;
  entries: PlaylistEntry[];
  /** Videos left out because the site says they can't be watched (private, deleted). */
  unavailable: number;
}

/**
 * What yt-dlp prints for each video (with --flat-playlist --print-to-file): fields split by tabs,
 * so a title (which never holds a tab once yt-dlp has replaced them) can't break the line apart.
 */
export const ENTRY_TEMPLATE = "%(playlist_index)s\t%(id)s\t%(url,webpage_url)s\t%(playlist_title,playlist)s\t%(title)s";

/** Titles YouTube gives the videos of a playlist that nobody can watch any more. */
const GONE = /^\[(private|deleted|unavailable) video\]$/i;

/**
 * Whether a link is a playlist rather than one video: YouTube's playlist pages and video links
 * that carry a playlist (list=), SoundCloud sets, Bandcamp albums, Vimeo showcases and albums.
 * A YouTube Mix (list=RD…) is endless and made up on the fly, so a video in one is just that video.
 */
export function isPlaylistLink(link: string): boolean {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtube.com" || host === "youtu.be") {
    const list = u.searchParams.get("list");
    if (!list) return false;
    return u.pathname === "/playlist" || !/^RD/.test(list);
  }
  if (host === "soundcloud.com") return /^\/[^/]+\/sets\/[^/]+/.test(u.pathname);
  if (host.endsWith("bandcamp.com")) return /^\/album\//.test(u.pathname);
  if (host === "vimeo.com") return /^\/(showcase|album)\/\d+/.test(u.pathname);
  return false;
}

/** Whether a playlist link also points at one of its videos (a YouTube watch?v=…&list=… link). */
export function hasOneVideo(link: string): boolean {
  try {
    const u = new URL(link.trim());
    return u.searchParams.has("v") || /youtu\.be$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Reads the lines yt-dlp printed with ENTRY_TEMPLATE. */
export function parsePlaylist(text: string): Playlist {
  const entries: PlaylistEntry[] = [];
  let title = "";
  let unavailable = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [index, id, url, list, ...rest] = line.split("\t");
    const name = rest.join(" ").trim();
    if (!title && list && list !== "NA") title = list.trim();
    if (!id || id === "NA" || GONE.test(name)) {
      unavailable++;
      continue;
    }
    const href = url && url !== "NA" ? url : "";
    if (!/^https?:\/\//i.test(href)) {
      unavailable++;
      continue;
    }
    const n = Number(index);
    entries.push({ index: Number.isFinite(n) && n > 0 ? n : entries.length + 1, id, url: href, title: name && name !== "NA" ? name : id });
  }
  return { title, entries, unavailable };
}

/**
 * The videos to download, from "Which videos": empty for all of them, or places in the playlist
 * like "1-10, 15, 20-". Places past the end are ignored; a list that picks nothing is an error.
 */
export function pickEntries(entries: PlaylistEntry[], which: string): PlaylistEntry[] {
  const spec = which.trim();
  if (!spec || /^all$/i.test(spec)) return entries;
  const wanted = new Set<number>();
  const last = entries.reduce((m, e) => Math.max(m, e.index), 0);
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(part) ?? /^(\d+)()$/.exec(part);
    if (!m || (!m[1] && !m[2])) throw new Error(`"${part}" isn't a video number or a range like 1-10`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = part.includes("-") || part.includes("–") ? (m[2] ? Number(m[2]) : last) : from;
    if (to < from) throw new Error(`${part} goes backwards: write the smaller number first`);
    for (let i = from; i <= Math.min(to, last); i++) wanted.add(i);
  }
  const picked = entries.filter((e) => wanted.has(e.index));
  if (!picked.length) throw new Error(`The playlist has ${entries.length} video${entries.length === 1 ? "" : "s"}: none of them is in "${spec}"`);
  return picked;
}

/** A playlist's title as a folder name. */
export function playlistFolder(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80).trim();
  return clean || "Playlist";
}

/** A downloaded video's name in the playlist's folder, numbered so the files sort in playlist order. */
export function entryFileName(folder: string, index: number, count: number, file: string): string {
  const width = Math.max(2, String(count).length);
  return `${folder}/${String(index).padStart(width, "0")} ${file}`;
}
