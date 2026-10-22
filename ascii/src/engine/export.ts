import type { Grid } from "./convert";
import type { Settings } from "./settings";

export function toText(g: Grid, glyphs: string[]): string {
  const lines: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    let line = "";
    for (let c = 0; c < g.cols; c++) line += glyphs[g.codes[r * g.cols + c]];
    lines.push(line.trimEnd());
  }
  return lines.join("\n") + "\n";
}

interface Run { text: string; rgb: [number, number, number] | null }

/** Splits a row into runs of the same color. Blank cells join whichever run they sit in. */
function runs(g: Grid, glyphs: string[], r: number, colored: boolean): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  for (let c = 0; c < g.cols; c++) {
    const i = r * g.cols + c;
    const ch = glyphs[g.codes[i]];
    const blank = ch.trim() === "" || ch === "⠀";
    const rgb: [number, number, number] | null = colored ? [g.colors[i * 3], g.colors[i * 3 + 1], g.colors[i * 3 + 2]] : null;
    if (cur && (blank || !rgb || !cur.rgb || (cur.rgb[0] === rgb[0] && cur.rgb[1] === rgb[1] && cur.rgb[2] === rgb[2]))) {
      cur.text += ch;
      if (!cur.rgb && !blank) cur.rgb = rgb;
    } else {
      cur = { text: ch, rgb: blank ? null : rgb };
      out.push(cur);
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hex = (rgb: [number, number, number]) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

export function toHtml(g: Grid, glyphs: string[], s: Settings, fontFamily: string): string {
  const colored = s.colorMode === "color";
  const body: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    body.push(
      runs(g, glyphs, r, colored)
        .map((run) => (run.rgb ? `<span style="color:${hex(run.rgb)}">${esc(run.text)}</span>` : esc(run.text)))
        .join(""),
    );
  }
  const bg = s.bg === "transparent" ? "transparent" : s.bg;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(s.name)}</title>
<style>
body{margin:0;background:${bg};display:grid;place-items:center;min-height:100vh}
pre{margin:0;padding:16px;color:${s.fg};font:${s.bold ? "bold " : ""}${s.fontSize}px/${s.lineHeight} ${fontFamily.replace(/"/g, "'")}}
</style></head><body><pre>${body.join("\n")}</pre></body></html>
`;
}

/** Text with 24-bit ANSI color codes, for `cat` in a terminal. */
export function toAnsi(g: Grid, glyphs: string[], s: Settings): string {
  const fg = (rgb: number[]) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const bg = s.bg === "transparent" ? "" : `\x1b[48;2;${parse(s.bg).join(";")}m`;
  const lines: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    let line = bg;
    if (s.colorMode === "color") {
      for (const run of runs(g, glyphs, r, true)) line += (run.rgb ? fg(run.rgb) : "") + run.text;
    } else {
      line += fg(parse(s.fg)) + runs(g, glyphs, r, false).map((x) => x.text).join("");
    }
    lines.push(line + "\x1b[0m");
  }
  return lines.join("\n") + "\n";
}

export function toSvg(g: Grid, glyphs: string[], s: Settings, fontFamily: string, cellW: number, cellH: number): string {
  const W = g.cols * cellW;
  const H = g.rows * cellH;
  const colored = s.colorMode === "color";
  const rows: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    const rr = runs(g, glyphs, r, colored);
    if (rr.every((x) => x.text.trim() === "" || /^⠀*$/.test(x.text))) continue;
    const spans = rr.map((run) => (run.rgb ? `<tspan fill="${hex(run.rgb)}">${esc(run.text)}</tspan>` : esc(run.text))).join("");
    rows.push(`<text y="${((r + 0.5) * cellH).toFixed(2)}" textLength="${W}" lengthAdjust="spacing">${spans}</text>`);
  }
  const bg = s.bg === "transparent" ? "" : `<rect width="100%" height="100%" fill="${s.bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${bg}<g fill="${s.fg}" font-family="${esc(fontFamily).replace(/"/g, "'")}" font-size="${s.fontSize}"${s.bold ? ' font-weight="bold"' : ""} dominant-baseline="central" xml:space="preserve">
${rows.join("\n")}
</g></svg>
`;
}
