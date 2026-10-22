// Interactive crop box over the preview. Works in source pixels; the layer is scaled to the
// displayed media, so pointer positions are converted with the current scale.

import { clamp, type Rect } from "../engine/types";

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export class CropBox {
  private srcW = 1;
  private srcH = 1;
  private rect: Rect = { x: 0, y: 0, width: 1, height: 1 };
  /** Width / height, or null for free. */
  aspect: number | null = null;
  onChange: (r: Rect) => void = () => {};

  constructor(private layer: HTMLElement, private box: HTMLElement) {
    box.addEventListener("pointerdown", (e) => this.start(e));
    new ResizeObserver(() => this.draw()).observe(layer);
  }

  setSource(w: number, h: number, rect?: Rect) {
    this.srcW = w;
    this.srcH = h;
    this.rect = rect ? { ...rect } : { x: 0, y: 0, width: w, height: h };
    this.draw();
  }

  get value(): Rect {
    return { ...this.rect };
  }

  set(r: Rect, notify = false) {
    const width = clamp(Math.round(r.width), 1, this.srcW);
    const height = clamp(Math.round(r.height), 1, this.srcH);
    this.rect = {
      x: clamp(Math.round(r.x), 0, this.srcW - width),
      y: clamp(Math.round(r.y), 0, this.srcH - height),
      width,
      height,
    };
    this.draw();
    if (notify) this.onChange(this.value);
  }

  /** Re-fits the current box to the aspect ratio, keeping its center. */
  applyAspect(aspect: number | null) {
    this.aspect = aspect;
    if (!aspect) return;
    const r = this.rect;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let w = r.width;
    let h = w / aspect;
    if (h > this.srcH) {
      h = this.srcH;
      w = h * aspect;
    }
    if (w > this.srcW) {
      w = this.srcW;
      h = w / aspect;
    }
    // Grow to use as much of the frame as possible when the old box was the full frame.
    if (r.width === this.srcW || r.height === this.srcH) {
      w = Math.min(this.srcW, this.srcH * aspect);
      h = w / aspect;
    }
    this.set({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, true);
  }

  isFull(): boolean {
    const r = this.rect;
    return r.x === 0 && r.y === 0 && r.width === this.srcW && r.height === this.srcH;
  }

  private scale(): number {
    return this.layer.clientWidth / this.srcW || 1;
  }

  draw() {
    const s = this.scale();
    const r = this.rect;
    Object.assign(this.box.style, {
      left: `${r.x * s}px`,
      top: `${r.y * s}px`,
      width: `${r.width * s}px`,
      height: `${r.height * s}px`,
    });
    this.box.classList.toggle("full", this.isFull());
  }

  private start(e: PointerEvent) {
    e.preventDefault();
    const handle = ((e.target as HTMLElement).dataset.h as Handle) ?? "move";
    const s = this.scale();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r0 = { ...this.rect };
    this.box.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      if (handle === "move") {
        this.set({ ...r0, x: r0.x + dx, y: r0.y + dy }, true);
        return;
      }
      let left = r0.x;
      let top = r0.y;
      let right = r0.x + r0.width;
      let bottom = r0.y + r0.height;
      if (handle.includes("w")) left = clamp(left + dx, 0, right - 1);
      if (handle.includes("e")) right = clamp(right + dx, left + 1, this.srcW);
      if (handle.includes("n")) top = clamp(top + dy, 0, bottom - 1);
      if (handle.includes("s")) bottom = clamp(bottom + dy, top + 1, this.srcH);
      if (this.aspect) {
        const a = this.aspect;
        let w = right - left;
        let h = bottom - top;
        // Edge handles drive one side; corners follow whichever side moved more.
        if (handle === "n" || handle === "s") w = h * a;
        else if (handle === "e" || handle === "w") h = w / a;
        else if (Math.abs(dx) > Math.abs(dy) * a) h = w / a;
        else w = h * a;
        // Keep inside the frame.
        const maxW = handle.includes("w") ? right : handle.includes("e") ? this.srcW - left : Math.min(r0.x + r0.width / 2, this.srcW - r0.x - r0.width / 2) * 2;
        const maxH = handle.includes("n") ? bottom : handle.includes("s") ? this.srcH - top : Math.min(r0.y + r0.height / 2, this.srcH - r0.y - r0.height / 2) * 2;
        if (w > maxW) {
          w = maxW;
          h = w / a;
        }
        if (h > maxH) {
          h = maxH;
          w = h * a;
        }
        if (handle.includes("w")) left = right - w;
        else if (handle.includes("e")) right = left + w;
        else {
          const cx = r0.x + r0.width / 2;
          left = cx - w / 2;
          right = cx + w / 2;
        }
        if (handle.includes("n")) top = bottom - h;
        else if (handle.includes("s")) bottom = top + h;
        else {
          const cy = r0.y + r0.height / 2;
          top = cy - h / 2;
          bottom = cy + h / 2;
        }
      }
      this.set({ x: left, y: top, width: right - left, height: bottom - top }, true);
    };
    const up = () => {
      this.box.removeEventListener("pointermove", move);
      this.box.removeEventListener("pointerup", up);
      this.box.removeEventListener("pointercancel", up);
    };
    this.box.addEventListener("pointermove", move);
    this.box.addEventListener("pointerup", up);
    this.box.addEventListener("pointercancel", up);
  }
}
