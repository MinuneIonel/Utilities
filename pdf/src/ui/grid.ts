// The page grid: thumbnails of the output document, in order. Click to
// select (Shift for a range, Ctrl/Cmd to toggle), drag to reorder,
// double-click to edit.

import { paintDecorations, paintOverlays } from "../paint";
import { renderImage, renderPdfPage } from "../render";
import { changed, checkpoint, fileById, pageSize, state, type PageItem } from "../state";

const cache = new Map<string, Promise<HTMLCanvasElement>>();

/** Render a page (without overlays) at about `width` CSS pixels, cached. */
export function pageCanvas(item: PageItem, width: number): Promise<HTMLCanvasElement> {
  const bucket = width <= 200 ? 200 : width <= 400 ? 400 : Math.ceil(width / 400) * 400;
  const key = `${item.file}:${item.page}:${item.rotate}:${bucket}`;
  let hit = cache.get(key);
  if (!hit) {
    const file = fileById(item.file)!;
    hit = file.bitmap
      ? Promise.resolve(renderImage(file.bitmap, item.rotate, bucket))
      : renderPdfPage(file.handle!, item.page, item.rotate, bucket);
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

export function forgetFile(fileId: string) {
  for (const key of cache.keys()) if (key.startsWith(fileId + ":")) cache.delete(key);
}

interface GridOptions {
  onEdit: (id: string) => void;
}

export function mountGrid(list: HTMLOListElement, opts: GridOptions) {
  const tiles = new Map<string, { el: HTMLLIElement; canvas: HTMLCanvasElement; key: string }>();
  let anchor: string | null = null;
  let dragIds: string[] = [];

  function render() {
    const seen = new Set<string>();
    state.pages.forEach((item, i) => {
      seen.add(item.id);
      let tile = tiles.get(item.id);
      if (!tile) {
        tile = createTile(item.id);
        tiles.set(item.id, tile);
      }
      const { el } = tile;
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
      el.classList.toggle("selected", state.selected.has(item.id));
      const file = fileById(item.file)!;
      const label = el.querySelector(".label")!;
      label.textContent = `${i + 1}`;
      label.setAttribute("title", `${file.name}, page ${item.page + 1}`);
      el.querySelector(".from")!.textContent =
        state.files.length > 1 || file.info.pageCount > 1
          ? `${shortName(file.name)} · p${item.page + 1}`
          : "";
      paintTile(item, tile, i);
    });
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.el.remove();
        tiles.delete(id);
      }
    }
  }

  function paintTile(item: PageItem, tile: { canvas: HTMLCanvasElement; key: string }, index: number) {
    const { watermark, numbers } = state.settings;
    const total = state.pages.length;
    const decor = [watermark.enabled && watermark, numbers.enabled && [numbers, index, total]];
    const key = JSON.stringify([item.file, item.page, item.rotate, item.overlays, decor]);
    if (tile.key === key) return;
    tile.key = key;
    pageCanvas(item, 200).then((src) => {
      if (tile.key !== key) return;
      const { canvas } = tile;
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(src, 0, 0);
      const pxPerPt = src.width / pageSize(item).width;
      paintOverlays(ctx, item.overlays, pxPerPt);
      paintDecorations(ctx, index, total, pxPerPt);
    });
  }

  function createTile(id: string) {
    const el = document.createElement("li");
    el.className = "tile";
    el.draggable = true;
    el.dataset.id = id;
    el.innerHTML = `
      <div class="thumb"><canvas></canvas></div>
      <div class="tile-actions">
        <button class="icon" data-act="left" title="Rotate left">↺</button>
        <button class="icon" data-act="right" title="Rotate right">↻</button>
        <button class="icon" data-act="edit" title="Edit">✎</button>
        <button class="icon" data-act="delete" title="Delete">✕</button>
      </div>
      <div class="meta"><span class="label"></span><span class="from"></span></div>`;
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) {
        e.stopPropagation();
        if (act === "edit") return opts.onEdit(id);
        if (act === "delete") return deletePages([id]);
        return rotatePages([id], act === "left" ? -90 : 90);
      }
      select(id, e);
    });
    el.addEventListener("dblclick", () => opts.onEdit(id));
    el.addEventListener("dragstart", (e) => {
      if (!state.selected.has(id)) {
        state.selected.clear();
        state.selected.add(id);
        changed();
      }
      dragIds = state.pages.filter((p) => state.selected.has(p.id)).map((p) => p.id);
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/x-page", id);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      clearMarks();
      dragIds = [];
    });
    el.addEventListener("dragover", (e) => {
      if (!dragIds.length) return;
      e.preventDefault();
      clearMarks();
      el.classList.add(after(e, el) ? "drop-after" : "drop-before");
    });
    el.addEventListener("drop", (e) => {
      if (!dragIds.length) return;
      e.preventDefault();
      e.stopPropagation();
      movePages(dragIds, id, after(e, el));
    });
    return { el, canvas: el.querySelector("canvas")!, key: "" };
  }

  function after(e: DragEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  }

  function clearMarks() {
    list
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((n) => n.classList.remove("drop-before", "drop-after"));
  }

  function select(id: string, e: MouseEvent) {
    if (e.shiftKey && anchor) {
      const ids = state.pages.map((p) => p.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      if (!(e.metaKey || e.ctrlKey)) state.selected.clear();
      ids.slice(a, b + 1).forEach((x) => state.selected.add(x));
    } else if (e.metaKey || e.ctrlKey) {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      anchor = id;
    } else {
      state.selected.clear();
      state.selected.add(id);
      anchor = id;
    }
    changed();
  }

  list.parentElement!.addEventListener("click", (e) => {
    if (e.target === list || e.target === list.parentElement) {
      state.selected.clear();
      changed();
    }
  });

  return { render };
}

function shortName(name: string) {
  const base = name.replace(/\.[^.]+$/, "");
  return base.length > 16 ? base.slice(0, 15) + "…" : base;
}

// ---------------------------------------------------------------- page operations

export function rotatePages(ids: string[], by: 90 | -90) {
  if (!ids.length) return;
  checkpoint();
  for (const p of state.pages) {
    if (!ids.includes(p.id)) continue;
    p.rotate = ((((p.rotate + by) % 360) + 360) % 360) as PageItem["rotate"];
    // Overlays are stored in visual space, so turn them with the page.
    p.overlays = p.overlays.map((o) => rotateOverlay(o, by));
  }
  changed();
}

function rotateOverlay<T extends PageItem["overlays"][number]>(o: T, by: 90 | -90): T {
  const pt = (u: number, v: number): [number, number] => (by === 90 ? [1 - v, u] : [v, 1 - u]);
  if (o.type === "ink") return { ...o, points: o.points.map(([u, v]) => pt(u, v)) };
  if (o.type === "text") {
    const [x, y] = pt(o.x, o.y);
    return { ...o, x: Math.min(x, 0.95), y: Math.min(y, 0.95) };
  }
  const b = o.box;
  // Rotate the box's corners and keep the upright bounding box.
  const [x1, y1] = pt(b.x, b.y);
  const [x2, y2] = pt(b.x + b.w, b.y + b.h);
  return {
    ...o,
    box: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
  };
}

export function deletePages(ids: string[]) {
  if (!ids.length) return;
  checkpoint();
  state.pages = state.pages.filter((p) => !ids.includes(p.id));
  ids.forEach((id) => state.selected.delete(id));
  changed();
}

export function duplicatePages(ids: string[], uid: (p: string) => string) {
  if (!ids.length) return;
  checkpoint();
  const out: PageItem[] = [];
  const fresh: string[] = [];
  for (const p of state.pages) {
    out.push(p);
    if (ids.includes(p.id)) {
      const copy = { ...structuredClone(p), id: uid("p") };
      out.push(copy);
      fresh.push(copy.id);
    }
  }
  state.pages = out;
  state.selected = new Set(fresh);
  changed();
}

function movePages(ids: string[], target: string, after: boolean) {
  if (ids.includes(target)) return;
  checkpoint();
  const moving = state.pages.filter((p) => ids.includes(p.id));
  const rest = state.pages.filter((p) => !ids.includes(p.id));
  const at = rest.findIndex((p) => p.id === target) + (after ? 1 : 0);
  rest.splice(at, 0, ...moving);
  state.pages = rest;
  changed();
}
