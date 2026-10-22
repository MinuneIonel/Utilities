/**
 * Builds an SVG with one path per palette color, made of horizontal runs.
 * Each output pixel becomes a `scale`-sized square.
 */
export function toSvg(indices: Uint8Array, w: number, h: number, palette: string[], scale = 1, skipColor?: number): string {
  const paths: string[][] = palette.map(() => []);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = indices[y * w + x];
      let run = 1;
      while (x + run < w && indices[y * w + x + run] === c) run++;
      if (c !== skipColor) paths[c].push(`M${x} ${y}h${run}v1h${-run}z`);
      x += run;
    }
  }
  const body = paths
    .map((d, i) => (d.length ? `<path fill="${palette[i]}" d="${d.join("")}"/>` : ""))
    .join("\n");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}" ` +
    `viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">\n${body}\n</svg>\n`
  );
}
