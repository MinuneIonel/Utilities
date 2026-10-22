// Page range strings like "1-3, 5, 8-" (1-based, inclusive) to page indexes.

/** Parse one range list into zero-based page indexes, in the order given. */
export function parseRanges(input: string, pageCount: number): number[] {
  const out: number[] = [];
  for (const raw of input.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`Bad page range "${part}"`);
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      throw new Error(`Page range "${part}" is outside 1-${pageCount}`);
    }
    const step = from <= to ? 1 : -1;
    for (let p = from; p !== to + step; p += step) out.push(p - 1);
  }
  return out;
}

/** Groups separated by ";" each become one output file, e.g. "1-3; 4-". */
export function parseGroups(input: string, pageCount: number): number[][] {
  return input
    .split(";")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => parseRanges(g, pageCount));
}

/** Chunks of n consecutive pages. */
export function everyN(n: number, pageCount: number): number[][] {
  const size = Math.max(1, Math.floor(n));
  const out: number[][] = [];
  for (let i = 0; i < pageCount; i += size) {
    out.push(Array.from({ length: Math.min(size, pageCount - i) }, (_, k) => i + k));
  }
  return out;
}
