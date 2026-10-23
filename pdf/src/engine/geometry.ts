// Visual page space (0..1, top-left origin, as displayed after rotation)
// to PDF user space (points, bottom-left origin, unrotated).

import type { Rotation } from "./types";

export interface PageFrame {
  x0: number;
  y0: number;
  /** Unrotated page size in points. */
  width: number;
  height: number;
  rotation: Rotation;
}

export function normRotation(deg: number): Rotation {
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;
}

/** Displayed size in points. */
export function visualSize(f: PageFrame): { width: number; height: number } {
  return f.rotation % 180 === 0 ? { width: f.width, height: f.height } : { width: f.height, height: f.width };
}

export function toPdf(f: PageFrame, u: number, v: number): { x: number; y: number } {
  const { x0, y0, width: W, height: H } = f;
  switch (f.rotation) {
    case 0:
      return { x: x0 + u * W, y: y0 + (1 - v) * H };
    case 90:
      return { x: x0 + v * W, y: y0 + u * H };
    case 180:
      return { x: x0 + (1 - u) * W, y: y0 + v * H };
    case 270:
      return { x: x0 + (1 - v) * W, y: y0 + (1 - u) * H };
  }
}
