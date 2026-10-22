import { brailleChars, charsetChars, EDGE_CHARS } from "./engine/charsets";
import type { Grid } from "./engine/convert";
import { fontCss, type Settings } from "./engine/settings";

export interface Layout {
  /** Every character a code can point at. */
  glyphs: string[];
  /** Length of the brightness ramp (ramp mode); edge characters follow it in `glyphs`. */
  levels: number;
  cellW: number;
  cellH: number;
  font: string;
  /** True for glyphs that leave no ink, so drawing can skip them. */
  blank: boolean[];
}

const ATLAS_COLS = 16;

/** Draws character grids onto a canvas from a pre-rendered glyph atlas. */
export class Renderer {
  private atlas = document.createElement("canvas");
  private colorCanvas = document.createElement("canvas");
  private key = "";
  private cached: Layout | null = null;
  private inkCache = new Map<string, number>();

  layout(s: Settings, scale = 1): Layout {
    const size = s.fontSize * scale;
    const font = fontCss(s, size);
    let glyphs: string[];
    let levels: number;
    if (s.mode === "braille") {
      glyphs = brailleChars();
      levels = 2;
    } else {
      let ramp = charsetChars(s.charset, s.custom);
      if (s.sortByInk) {
        const ink = new Map(ramp.map((ch) => [ch, this.ink(ch, s)]));
        ramp = [...ramp].sort((a, b) => ink.get(a)! - ink.get(b)!);
      }
      glyphs = [...ramp, ...EDGE_CHARS];
      levels = ramp.length;
    }
    const key = `${font}|${s.lineHeight}|${glyphs.join("")}`;
    if (key === this.key && this.cached) return this.cached;

    const g = this.atlas.getContext("2d")!;
    g.font = font;
    const cellW = Math.max(1, Math.round(g.measureText("M").width));
    const cellH = Math.max(1, Math.round(size * s.lineHeight));
    const rows = Math.ceil(glyphs.length / ATLAS_COLS);
    this.atlas.width = cellW * ATLAS_COLS;
    this.atlas.height = cellH * rows;
    g.font = font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    glyphs.forEach((ch, i) => {
      const x = (i % ATLAS_COLS) * cellW;
      const y = Math.floor(i / ATLAS_COLS) * cellH;
      g.save();
      g.beginPath();
      g.rect(x, y, cellW, cellH);
      g.clip();
      g.fillText(ch, x + cellW / 2, y + cellH / 2);
      g.restore();
    });
    const blank = glyphs.map((ch) => ch.trim() === "" || ch === "⠀");
    this.cached = { glyphs, levels, cellW, cellH, font, blank };
    this.key = key;
    return this.cached;
  }

  /** Fraction of a glyph's cell covered by ink, used to sort custom ramps. */
  private ink(ch: string, s: Settings): number {
    const font = fontCss(s, 32);
    const k = `${font}|${ch}`;
    const hit = this.inkCache.get(k);
    if (hit !== undefined) return hit;
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 40;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.font = font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(ch, 16, 20);
    const d = g.getImageData(0, 0, 32, 40).data;
    let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    const v = sum / (255 * 32 * 40);
    this.inkCache.set(k, v);
    return v;
  }

  draw(target: HTMLCanvasElement, grid: Grid, s: Settings, L: Layout) {
    const W = grid.cols * L.cellW;
    const H = grid.rows * L.cellH;
    if (target.width !== W || target.height !== H) {
      target.width = W;
      target.height = H;
    }
    const g = target.getContext("2d")!;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    const { cellW, cellH, blank } = L;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const code = grid.codes[r * grid.cols + c];
        if (blank[code]) continue;
        g.drawImage(
          this.atlas,
          (code % ATLAS_COLS) * cellW, Math.floor(code / ATLAS_COLS) * cellH, cellW, cellH,
          c * cellW, r * cellH, cellW, cellH,
        );
      }
    }
    // Tint the white glyphs, then slide the background underneath.
    g.globalCompositeOperation = "source-in";
    if (s.colorMode === "color") {
      const cc = this.colorCanvas;
      cc.width = grid.cols;
      cc.height = grid.rows;
      const img = new ImageData(grid.cols, grid.rows);
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        img.data[i * 4] = grid.colors[i * 3];
        img.data[i * 4 + 1] = grid.colors[i * 3 + 1];
        img.data[i * 4 + 2] = grid.colors[i * 3 + 2];
        img.data[i * 4 + 3] = 255;
      }
      cc.getContext("2d")!.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(cc, 0, 0, W, H);
    } else {
      g.fillStyle = s.fg;
      g.fillRect(0, 0, W, H);
    }
    if (s.bg !== "transparent") {
      g.globalCompositeOperation = "destination-over";
      g.fillStyle = s.bg;
      g.fillRect(0, 0, W, H);
    }
    g.globalCompositeOperation = "source-over";
  }
}

const luma = (hex: string) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};

/** True when ink is darker than the background, so dark pixels should get more ink. */
export function inkIsDark(s: Settings): boolean {
  const bg = s.bg === "transparent" ? 0 : luma(s.bg);
  const ink = s.colorMode === "color" ? 0.5 : luma(s.fg);
  return bg > ink;
}
