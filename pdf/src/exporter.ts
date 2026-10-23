// Turns the app state into finished files: build, then the optional
// whole-file passes (compress, split, password) in the order they need.

import { zipSync } from "fflate";
import fontUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { build, compact, everyN, fromRaster, parseGroups, protect, split, type Bytes } from "./engine";
import { rasterize } from "./render";
import { needsUnicode, state, toPlan, type PageItem } from "./state";

let font: Promise<Bytes> | undefined;
const loadFont = () =>
  (font ??= fetch(fontUrl)
    .then((r) => {
      if (!r.ok) throw new Error("Could not load the Unicode font");
      return r.arrayBuffer();
    })
    .then((b) => new Uint8Array(b)));

type Progress = (msg: string) => void;

/** The edited document, before password protection. */
async function assemble(pages: PageItem[], progress: Progress): Promise<Bytes> {
  const { sources, plan } = toPlan(pages);
  if (needsUnicode(plan)) {
    progress("Loading font…");
    plan.font = await loadFont();
  }
  progress("Building PDF…");
  let bytes = await build(sources, plan);
  const c = state.settings.compress;
  if (c.mode === "lossless") {
    progress("Compressing…");
    bytes = await compact(bytes);
  } else if (c.mode === "raster") {
    const raster = await rasterize(bytes, c.dpi, c.quality, (i, n) =>
      progress(`Compressing page ${i} / ${n}…`),
    );
    const smaller = await fromRaster(raster, plan.metadata);
    // Text-only pages can come out bigger as pictures; keep whichever wins.
    if (smaller.length < bytes.length) bytes = smaller;
  }
  return bytes;
}

function lock(bytes: Bytes): Promise<Bytes> {
  const p = state.settings.protection;
  if (!p.enabled) return Promise.resolve(bytes);
  if (!p.userPassword && !p.ownerPassword)
    throw new Error("Enter a password, or turn password protection off");
  return protect(bytes, p);
}

export async function exportPdf(pages: PageItem[], progress: Progress): Promise<Bytes> {
  return lock(await assemble(pages, progress));
}

export async function exportSplit(progress: Progress): Promise<{ name: string; bytes: Bytes }> {
  const whole = await assemble(state.pages, progress);
  const count = state.pages.length;
  const s = state.settings.split;
  const groups = s.mode === "every" ? everyN(s.n, count) : parseGroups(s.ranges, count);
  if (groups.length === 0) throw new Error("Enter page ranges to split by, e.g. 1-3; 4-");
  progress("Splitting…");
  const parts = await split(whole, groups);
  const base = baseName();
  const width = String(parts.length).length;
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < parts.length; i++) {
    files[`${base}-${String(i + 1).padStart(width, "0")}.pdf`] = await lock(parts[i]);
  }
  return { name: `${base}-split.zip`, bytes: zipSync(files, { level: 0 }) };
}

export function baseName(): string {
  const title = state.settings.metadata.title?.trim();
  const first = state.files[0]?.name.replace(/\.[^.]+$/, "");
  return (title || first || "document").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
}
