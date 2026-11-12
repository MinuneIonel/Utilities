// Serves a file on disk to the window with HTTP Range support, so a video in the scratch folder
// (or one the person dropped) is read a piece at a time instead of whole.
// No Electron here, so the tests can run it in plain Node.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Reads a `Range: bytes=…` header against a file of `size` bytes.
 * Returns `{ start, end }` (inclusive) for one satisfiable range, `null` when the whole file should
 * be sent (no header, several ranges, or a header that doesn't parse), and `false` when the range
 * lies past the end of the file (answered with 416).
 * @param {string | null | undefined} header
 * @param {number} size
 */
export function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last N bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return false;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== "" && Number(m[2]) < start) return null; // backwards: not a valid range, so it's ignored
  if (start >= size) return false;
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

const TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** The type to answer with for a file name. */
export const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";

/**
 * A Response for the file at `p`: 200 with everything, 206 with the requested range, or 416.
 * The caller decides whether the window may read `p` at all.
 * @param {string} p
 * @param {string | null | undefined} rangeHeader
 */
export async function serveRange(p, rangeHeader) {
  const { size } = await stat(p);
  const r = parseRange(rangeHeader, size);
  const base = { "Accept-Ranges": "bytes", "Content-Type": typeOf(p) };
  if (r === false) return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  const { start, end } = r ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  const body = length === 0 ? null : /** @type {ReadableStream} */ (Readable.toWeb(createReadStream(p, { start, end })));
  const headers = { ...base, "Content-Length": String(length) };
  if (!r) return new Response(body, { status: 200, headers });
  return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
}
