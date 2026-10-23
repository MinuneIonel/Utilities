export interface Charset {
  id: string;
  name: string;
  /** Characters from least ink to most ink. */
  chars: string;
}

export const CHARSETS: Charset[] = [
  { id: "classic", name: "Classic", chars: " .:-=+*#%@" },
  { id: "detailed", name: "Detailed (70)", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { id: "minimal", name: "Minimal", chars: " .:oO@" },
  { id: "blocks", name: "Blocks", chars: " ░▒▓█" },
  { id: "dots", name: "Dots", chars: " ·∙•●" },
  { id: "lines", name: "Lines", chars: " ._-=≡" },
  { id: "digits", name: "Digits", chars: " 1742356908" },
  { id: "katakana", name: "Katakana", chars: " ｰｨｼﾂｯｸﾐﾃﾈﾓﾗﾒﾊﾎｦﾖﾔﾏｻﾅﾁﾀｹﾑ" },
  { id: "custom", name: "Custom…", chars: "" },
];

/** Characters used in edge mode, indexed by orientation: horizontal, falling, vertical, rising. */
export const EDGE_CHARS = ["-", "\\", "|", "/"];

/** Braille cells are 2 dots wide and 4 tall; this is the bit for each dot, row-major. */
export const BRAILLE_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];

export function charsetChars(id: string, custom: string): string[] {
  const src = id === "custom" ? custom : CHARSETS.find((c) => c.id === id)?.chars ?? CHARSETS[0].chars;
  // Array.from splits by code point, so astral characters stay whole; duplicates add nothing.
  const chars = [...new Set(Array.from(src))];
  return chars.length >= 2 ? chars : [" ", "#"];
}

export function brailleChars(): string[] {
  return Array.from({ length: 256 }, (_, i) => String.fromCharCode(0x2800 + i));
}
