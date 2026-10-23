// Paint overlays onto a canvas, for thumbnails. Mirrors what the engine draws.

import type { Overlay } from "./engine";
import { cssColor, state } from "./state";

/** Helvetica's ascender, which is where the engine puts the first baseline. */
export const ASCENT = 0.718;
const FONT = "Helvetica, Arial, sans-serif";

/**
 * `pxPerPt` converts the overlay's point sizes to canvas pixels; boxes use the
 * canvas size directly since they are stored as fractions of the page.
 */
export function paintOverlays(ctx: CanvasRenderingContext2D, overlays: Overlay[], pxPerPt: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  for (const o of overlays) {
    ctx.save();
    ctx.globalAlpha = o.opacity ?? 1;
    if (o.type === "text") {
      const size = o.size * pxPerPt;
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = cssColor(o.color);
      ctx.textBaseline = "alphabetic";
      o.text
        .split("\n")
        .forEach((line, i) => ctx.fillText(line, o.x * W, o.y * H + size * (ASCENT + i * 1.2)));
    } else if (o.type === "ink") {
      ctx.strokeStyle = cssColor(o.color);
      ctx.lineWidth = o.width * pxPerPt;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      o.points.forEach(([u, v], i) => (i ? ctx.lineTo(u * W, v * H) : ctx.moveTo(u * W, v * H)));
      ctx.stroke();
    } else if (o.type === "image") {
      const img = state.images[o.image];
      if (img) ctx.drawImage(img.bitmap, o.box.x * W, o.box.y * H, o.box.w * W, o.box.h * H);
    } else {
      const { x, y, w, h } = o.box;
      if (o.blend === "multiply") ctx.globalCompositeOperation = "multiply";
      if (o.fill) {
        ctx.fillStyle = cssColor(o.fill);
        ctx.fillRect(x * W, y * H, w * W, h * H);
      }
      if (o.stroke) {
        ctx.strokeStyle = cssColor(o.stroke);
        ctx.lineWidth = (o.strokeWidth ?? 1) * pxPerPt;
        ctx.strokeRect(x * W, y * H, w * W, h * H);
      }
    }
    ctx.restore();
  }
}

/** Watermark and page number, as the engine will add them on export. */
export function paintDecorations(
  ctx: CanvasRenderingContext2D,
  index: number,
  total: number,
  pxPerPt: number,
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const { watermark: wm, numbers: pn } = state.settings;
  ctx.save();
  if (wm.enabled && wm.text.trim()) {
    const size = wm.size * pxPerPt;
    ctx.font = `${size}px ${FONT}`;
    ctx.fillStyle = cssColor(wm.color, wm.opacity);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.translate(W / 2, H / 2);
    ctx.rotate((-wm.angle * Math.PI) / 180);
    ctx.fillText(wm.text, 0, (size * ASCENT) / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (pn.enabled) {
    const text = pn.format
      .replaceAll("{n}", String(pn.start + index))
      .replaceAll("{total}", String(pn.start + total - 1));
    const size = pn.size * pxPerPt;
    const margin = 28 * pxPerPt;
    const [vert, horiz] = pn.position.split("-");
    ctx.font = `${size}px ${FONT}`;
    ctx.fillStyle = cssColor(pn.color);
    ctx.textAlign = horiz === "center" ? "center" : horiz === "left" ? "left" : "right";
    const x = horiz === "left" ? margin : horiz === "right" ? W - margin : W / 2;
    const y = vert === "top" ? margin + size : H - margin;
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}
