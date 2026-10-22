// The page editor: one page, large, with overlay tools. Overlays are stored
// in visual page space (fractions of the displayed page), the same space the
// engine draws in, so what you place here is where it lands in the PDF.

import type { Box, Color, Overlay } from "../engine";
import { ASCENT } from "../paint";
import { changed, checkpoint, cssColor, fromHex, pageSize, state, toHex, type PageItem } from "../state";
import { pageCanvas } from "./grid";

export type Tool = "select" | "text" | "highlight" | "whiteout" | "box" | "draw";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = "http://www.w3.org/2000/svg";

interface Defaults {
  color: Color;
  size: number;
  opacity: number;
}

const defaults: Record<Tool, Defaults> = {
  select: { color: [0, 0, 0], size: 14, opacity: 1 },
  text: { color: [0, 0, 0], size: 14, opacity: 1 },
  highlight: { color: [1, 0.9, 0.1], size: 0, opacity: 0.45 },
  whiteout: { color: [1, 1, 1], size: 0, opacity: 1 },
  box: { color: [0.9, 0.1, 0.1], size: 2, opacity: 1 },
  draw: { color: [0.1, 0.2, 0.75], size: 2, opacity: 1 },
};

interface EditorOptions {
  /** Ask for an image file; resolves to its index in state.images. */
  pickImage: () => Promise<number | null>;
  onClose: () => void;
}

export function mountEditor(opts: EditorOptions) {
  const root = $<HTMLElement>("editor");
  const stage = $<HTMLElement>("stage");
  const sheet = $<HTMLElement>("sheet");
  const canvas = $<HTMLCanvasElement>("sheet-canvas");
  const layer = $<HTMLElement>("layer");
  const label = $<HTMLElement>("ed-label");
  const propColor = $<HTMLInputElement>("prop-color");
  const propSize = $<HTMLInputElement>("prop-size");
  const propSizeWrap = $<HTMLElement>("prop-size-wrap");
  const propOpacity = $<HTMLInputElement>("prop-opacity");
  const propDelete = $<HTMLButtonElement>("prop-delete");

  let pageId: string | null = null;
  let tool: Tool = "select";
  let selected: number | null = null;
  let editing: HTMLElement | null = null;
  let renderToken = 0;

  const item = () => state.pages.find((p) => p.id === pageId) ?? null;
  const isOpen = () => pageId !== null;

  // ---------------------------------------------------------------- open / layout

  function open(id: string) {
    pageId = id;
    selected = null;
    root.hidden = false;
    setTool("select");
    layout();
  }

  function close() {
    finishEditing();
    pageId = null;
    root.hidden = true;
    opts.onClose();
  }

  function step(by: number) {
    const i = state.pages.findIndex((p) => p.id === pageId);
    const next = state.pages[i + by];
    if (!next) return;
    finishEditing();
    pageId = next.id;
    selected = null;
    layout();
  }

  function layout() {
    const it = item();
    if (!it) return close();
    const size = pageSize(it);
    const pad = 48;
    const scale = Math.min((stage.clientWidth - pad) / size.width, (stage.clientHeight - pad) / size.height);
    const w = Math.max(100, Math.floor(size.width * scale));
    const h = Math.round((w * size.height) / size.width);
    sheet.style.width = `${w}px`;
    sheet.style.height = `${h}px`;
    const index = state.pages.indexOf(it);
    label.textContent = `${index + 1} / ${state.pages.length}`;
    const token = ++renderToken;
    pageCanvas(it, w).then((src) => {
      if (token !== renderToken) return;
      canvas.width = src.width;
      canvas.height = src.height;
      canvas.getContext("2d")!.drawImage(src, 0, 0);
    });
    draw();
  }

  /** CSS pixels per PDF point at the current zoom. */
  const pxPerPt = () => sheet.clientWidth / pageSize(item()!).width;

  // ---------------------------------------------------------------- overlay DOM

  function draw() {
    const it = item();
    if (!it || editing) return;
    layer.replaceChildren(...it.overlays.map((o, i) => overlayEl(o, i)));
    syncProps();
  }

  function overlayEl(o: Overlay, i: number): Element {
    const sel = i === selected;
    if (o.type === "ink") {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 1 1");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.classList.add("ov", "ink");
      svg.classList.toggle("selected", sel);
      svg.dataset.i = String(i);
      const line = document.createElementNS(SVG, "polyline");
      line.setAttribute("points", o.points.map((p) => p.join(",")).join(" "));
      line.setAttribute("stroke", cssColor(o.color));
      // viewBox units are the whole page, so keep the width in screen pixels.
      line.setAttribute("vector-effect", "non-scaling-stroke");
      line.setAttribute("stroke-width", String(o.width * pxPerPt()));
      line.setAttribute("stroke-opacity", String(o.opacity ?? 1));
      svg.append(line);
      return svg;
    }
    const el = document.createElement(o.type === "image" ? "img" : "div");
    el.className = `ov ${o.type}`;
    el.classList.toggle("selected", sel);
    el.dataset.i = String(i);
    el.style.opacity = String(o.opacity ?? 1);
    if (o.type === "text") {
      el.textContent = o.text;
      el.style.left = pct(o.x);
      el.style.top = pct(o.y);
      el.style.fontSize = `${o.size * pxPerPt()}px`;
      // CSS puts the first baseline about 1em down; the engine puts it at the
      // font's ascender. Shift so both agree.
      el.style.marginTop = `${ASCENT - 1.005}em`;
      el.style.color = cssColor(o.color);
      return el;
    }
    placeBox(el, o.box);
    if (o.type === "image") {
      (el as HTMLImageElement).src = imageUrl(o.image);
      (el as HTMLImageElement).draggable = false;
    } else {
      el.style.background = o.fill ? cssColor(o.fill) : "transparent";
      el.style.border = o.stroke
        ? `${(o.strokeWidth ?? 1) * pxPerPt()}px solid ${cssColor(o.stroke)}`
        : "none";
      if (o.blend === "multiply") el.style.mixBlendMode = "multiply";
    }
    if (sel) {
      const handle = document.createElement("span");
      handle.className = "handle";
      const wrap = document.createElement("div");
      wrap.className = "ov-frame";
      placeBox(wrap, o.box);
      wrap.dataset.i = String(i);
      wrap.append(handle);
      const frag = document.createDocumentFragment();
      frag.append(el, wrap);
      return frag as unknown as Element;
    }
    return el;
  }

  const urls = new Map<number, string>();
  function imageUrl(i: number) {
    let url = urls.get(i);
    if (!url) {
      const img = state.images[i];
      url = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
      urls.set(i, url);
    }
    return url;
  }

  // ---------------------------------------------------------------- pointer input

  const point = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = sheet.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };

  function drag(onMove: (u: number, v: number, e: PointerEvent) => void, onUp?: () => void) {
    const move = (e: PointerEvent) => {
      const [u, v] = point(e);
      onMove(u, v, e);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      onUp?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  layer.addEventListener("pointerdown", (e) => {
    const it = item();
    if (!it || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (editing && editing.contains(target)) return;
    finishEditing();
    const [u, v] = point(e);
    const hit = target.closest<HTMLElement | SVGElement>("[data-i]");
    e.preventDefault();

    if (target.classList.contains("handle") && selected !== null) return resize(it, selected);
    // Select moves anything; Text moves existing text; other tools draw over.
    if (
      hit &&
      (tool === "select" || (tool === "text" && it.overlays[Number(hit.dataset.i)]?.type === "text"))
    ) {
      return move(it, Number(hit.dataset.i), u, v);
    }

    const d = defaults[tool];
    if (tool === "select") {
      selected = null;
      return draw();
    }
    checkpoint();
    if (tool === "text") {
      it.overlays.push({
        type: "text",
        x: u,
        y: v,
        text: "",
        size: d.size,
        color: d.color,
        opacity: d.opacity,
      });
      selected = it.overlays.length - 1;
      draw();
      return startEditing(selected);
    }
    if (tool === "draw") {
      const ink: Overlay = {
        type: "ink",
        points: [[u, v]],
        color: d.color,
        width: d.size,
        opacity: d.opacity,
      };
      it.overlays.push(ink);
      selected = it.overlays.length - 1;
      return drag(
        (x, y) => {
          ink.points.push([x, y]);
          draw();
        },
        () => {
          if (ink.points.length < 2) remove(it.overlays.indexOf(ink));
          changed();
        },
      );
    }
    const rect: Overlay = { type: "rect", box: { x: u, y: v, w: 0, h: 0 }, opacity: d.opacity };
    if (tool === "highlight") Object.assign(rect, { fill: d.color, blend: "multiply" });
    if (tool === "whiteout") Object.assign(rect, { fill: d.color });
    if (tool === "box") Object.assign(rect, { stroke: d.color, strokeWidth: d.size });
    it.overlays.push(rect);
    selected = it.overlays.length - 1;
    drag(
      (x, y) => {
        rect.box = { x: Math.min(u, x), y: Math.min(v, y), w: Math.abs(x - u), h: Math.abs(y - v) };
        draw();
      },
      () => {
        if (rect.box.w < 0.004 || rect.box.h < 0.004) remove(it.overlays.indexOf(rect));
        changed();
      },
    );
  });

  layer.addEventListener("dblclick", (e) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>(".ov.text");
    if (hit) startEditing(Number(hit.dataset.i));
  });

  function move(it: PageItem, i: number, u0: number, v0: number) {
    selected = i;
    draw();
    const start = structuredClone(it.overlays[i]);
    let moved = false;
    drag(
      (u, v) => {
        if (!moved) checkpoint();
        moved = true;
        it.overlays[i] = shifted(start, u - u0, v - v0);
        draw();
      },
      () => moved && changed(),
    );
  }

  function resize(it: PageItem, i: number) {
    const o = it.overlays[i];
    if (o.type !== "rect" && o.type !== "image") return;
    checkpoint();
    const start = { ...o.box };
    const aspect = start.w / start.h;
    drag(
      (u, v, e) => {
        let w = Math.max(0.01, u - start.x);
        let h = Math.max(0.01, v - start.y);
        // Images keep their shape unless Shift is held.
        if (o.type === "image" && !e.shiftKey) h = w / aspect;
        o.box = { ...start, w, h };
        draw();
      },
      () => changed(),
    );
  }

  // ---------------------------------------------------------------- text editing

  function startEditing(i: number) {
    const el = layer.querySelector<HTMLElement>(`.ov.text[data-i="${i}"]`);
    const o = item()?.overlays[i];
    if (!el || o?.type !== "text") return;
    checkpoint();
    selected = i;
    editing = el;
    el.contentEditable = "plaintext-only";
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
    el.classList.add("editing");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el.oninput = () => {
      o.text = el.innerText.replace(/\n$/, "");
      changed();
    };
    el.onblur = () => finishEditing();
  }

  function finishEditing() {
    if (!editing) return;
    const el = editing;
    editing = null;
    el.onblur = el.oninput = null;
    const it = item();
    const i = Number(el.dataset.i);
    const o = it?.overlays[i];
    if (it && o?.type === "text" && !o.text.trim()) {
      remove(i);
      changed();
    }
    draw();
  }

  // ---------------------------------------------------------------- tools & props

  function setTool(t: Tool) {
    tool = t;
    document.querySelectorAll<HTMLButtonElement>("#tools [data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === t);
    });
    layer.dataset.tool = t;
    if (t !== "select") selected = null;
    draw();
  }

  /** Show the selected overlay's style, or the current tool's defaults. */
  function syncProps() {
    const o = selected !== null ? item()?.overlays[selected] : undefined;
    const d = defaults[tool];
    const color = o ? overlayColor(o) : d.color;
    propColor.value = toHex(color);
    const size = o ? overlaySize(o) : tool === "highlight" || tool === "whiteout" ? undefined : d.size;
    propSizeWrap.hidden = size === undefined;
    if (size !== undefined) propSize.value = String(size);
    propOpacity.value = String(Math.round((o ? (o.opacity ?? 1) : d.opacity) * 100));
    propDelete.disabled = !o;
  }

  function editProp(apply: (o: Overlay) => void, setDefault: (d: Defaults) => void) {
    const it = item();
    const o = selected !== null ? it?.overlays[selected] : undefined;
    if (o) {
      checkpoint();
      apply(o);
      changed();
      if (editing) {
        // Restyle the live text box without rebuilding it.
        if (o.type === "text") {
          editing.style.color = cssColor(o.color);
          editing.style.fontSize = `${o.size * pxPerPt()}px`;
          editing.style.opacity = String(o.opacity ?? 1);
        }
      } else draw();
    }
    const kind: Tool = !o ? tool : toolFor(o);
    setDefault(defaults[kind]);
  }

  propColor.addEventListener("input", () => {
    const c = fromHex(propColor.value);
    editProp(
      (o) => {
        if (o.type === "text" || o.type === "ink") o.color = c;
        else if (o.type === "rect") {
          if (o.stroke) o.stroke = c;
          else o.fill = c;
        }
      },
      (d) => (d.color = c),
    );
  });
  propSize.addEventListener("input", () => {
    const n = Number(propSize.value);
    if (!(n > 0)) return;
    editProp(
      (o) => {
        if (o.type === "text") o.size = n;
        else if (o.type === "ink") o.width = n;
        else if (o.type === "rect" && o.stroke) o.strokeWidth = n;
      },
      (d) => (d.size = n),
    );
  });
  propOpacity.addEventListener("input", () => {
    const a = Number(propOpacity.value) / 100;
    editProp(
      (o) => (o.opacity = a),
      (d) => (d.opacity = a),
    );
  });
  propDelete.addEventListener("click", () => deleteSelected());

  function deleteSelected() {
    const it = item();
    if (!it || selected === null) return;
    checkpoint();
    remove(selected);
    changed();
    draw();
  }

  function remove(i: number) {
    const it = item();
    if (!it || i < 0) return;
    it.overlays.splice(i, 1);
    selected = null;
  }

  async function placeImage() {
    const it = item();
    if (!it) return;
    const index = await opts.pickImage();
    if (index === null) return;
    const bmp = state.images[index].bitmap;
    const size = pageSize(it);
    let w = 0.4;
    let h = (w * size.width * bmp.height) / bmp.width / size.height;
    if (h > 0.6) {
      w *= 0.6 / h;
      h = 0.6;
    }
    checkpoint();
    it.overlays.push({ type: "image", image: index, box: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } });
    setTool("select");
    selected = it.overlays.length - 1;
    changed();
    draw();
  }

  document.querySelectorAll<HTMLButtonElement>("#tools [data-tool]").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
  });
  $("tool-image").addEventListener("click", () => placeImage());
  $("ed-prev").addEventListener("click", () => step(-1));
  $("ed-next").addEventListener("click", () => step(1));
  $("ed-done").addEventListener("click", () => close());
  new ResizeObserver(() => isOpen() && layout()).observe(stage);

  /** Returns true when the key was used. */
  function onKey(e: KeyboardEvent): boolean {
    if (!isOpen()) return false;
    if (editing) {
      if (e.key === "Escape") {
        editing.blur();
        return true;
      }
      return false;
    }
    const keys: Record<string, Tool> = {
      v: "select",
      t: "text",
      h: "highlight",
      w: "whiteout",
      r: "box",
      d: "draw",
    };
    if (e.key === "Escape") {
      if (selected !== null) {
        selected = null;
        draw();
      } else close();
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
      deleteSelected();
      return true;
    }
    if (e.key === "PageDown") return (step(1), true);
    if (e.key === "PageUp") return (step(-1), true);
    const t = keys[e.key.toLowerCase()];
    if (t && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setTool(t);
      return true;
    }
    return false;
  }

  return {
    open,
    close,
    isOpen,
    onKey,
    /** Re-read state after undo/redo or page changes. */
    refresh: () => isOpen() && layout(),
  };
}

// ---------------------------------------------------------------- helpers

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => `${n * 100}%`;

function placeBox(el: HTMLElement, b: Box) {
  el.style.left = pct(b.x);
  el.style.top = pct(b.y);
  el.style.width = pct(b.w);
  el.style.height = pct(b.h);
}

function shifted(o: Overlay, du: number, dv: number): Overlay {
  if (o.type === "text") return { ...o, x: clamp(o.x + du), y: clamp(o.y + dv) };
  if (o.type === "ink")
    return { ...o, points: o.points.map(([u, v]) => [u + du, v + dv] as [number, number]) };
  return { ...o, box: { ...o.box, x: o.box.x + du, y: o.box.y + dv } };
}

function overlayColor(o: Overlay): Color {
  if (o.type === "text" || o.type === "ink") return o.color;
  if (o.type === "rect") return o.stroke ?? o.fill ?? [0, 0, 0];
  return [0, 0, 0];
}

function overlaySize(o: Overlay): number | undefined {
  if (o.type === "text") return o.size;
  if (o.type === "ink") return o.width;
  if (o.type === "rect" && o.stroke) return o.strokeWidth ?? 1;
  return undefined;
}

function toolFor(o: Overlay): Tool {
  if (o.type === "text") return "text";
  if (o.type === "ink") return "draw";
  if (o.type === "rect") return o.stroke ? "box" : o.blend === "multiply" ? "highlight" : "whiteout";
  return "select";
}
