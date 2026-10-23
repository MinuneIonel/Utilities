// Tokenising and folding. training/train.py mirrors these rules exactly; change both together.

const FOLD: Record<string, string> = {
  ă: "a", â: "a", î: "i", ș: "s", ț: "t", ş: "s", ţ: "t",
  Ă: "A", Â: "A", Î: "I", Ș: "S", Ț: "T", Ş: "S", Ţ: "T",
};
const CEDILLA: Record<string, string> = { ş: "ș", ţ: "ț", Ş: "Ș", Ţ: "Ț" };

const WORD = /\p{L}+/gu;
const DIGIT = /\p{Nd}/u;
const SENTENCE_END = /[.!?…]/;

/** Lower-case and strip Romanian diacritics: "Știință" → "stiinta". Keeps length. */
export function fold(word: string): string {
  let out = "";
  for (const ch of word.toLowerCase()) out += FOLD[ch] ?? ch;
  return out;
}

export function hasDiacritics(word: string): boolean {
  for (const ch of word) if (ch in FOLD) return true;
  return false;
}

/** Turn cedilla ş/ţ (and decomposed forms) into the correct comma-below ș/ț. */
export function normalize(text: string): string {
  return text.normalize("NFC").replace(/[şţŞŢ]/g, (c) => CEDILLA[c]);
}

/** Put the casing of `input` onto `form` (same length, letter for letter). */
export function matchCase(input: string, form: string): string {
  if (input === input.toLowerCase()) return form;
  let out = "";
  const a = [...input];
  const b = [...form];
  for (let i = 0; i < b.length; i++) {
    const c = a[i] ?? "";
    out += c !== c.toLowerCase() ? b[i].toUpperCase() : b[i];
  }
  return out;
}

export interface Word {
  start: number;
  end: number;
  text: string;
  key: string;
  /** What sits to the left / right: a folded word, "w-" / "-w" when joined by a hyphen,
   * or a marker: ^ start, $ end, . sentence end, , other punctuation, # number. */
  left: string;
  right: string;
}

function gapMarker(gap: string): string | null {
  if (DIGIT.test(gap)) return "#";
  const s = gap.trim();
  if (!s) return null;
  if (gap === "-") return "-";
  if (SENTENCE_END.test(s)) return ".";
  return ",";
}

export function tokenize(text: string): Word[] {
  const words: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    words.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], key: fold(m[0]), left: "", right: "" });
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i === 0) w.left = "^";
    else {
      const g = gapMarker(text.slice(words[i - 1].end, w.start));
      w.left = g === null ? words[i - 1].key : g === "-" ? words[i - 1].key + "-" : g;
    }
    if (i === words.length - 1) w.right = "$";
    else {
      const g = gapMarker(text.slice(w.end, words[i + 1].start));
      w.right = g === null ? words[i + 1].key : g === "-" ? "-" + words[i + 1].key : g;
    }
  }
  return words;
}

const MARKERS = new Set(["^", "$", ".", ",", "#"]);

/** Feature names for word i, as used by the trained weights. */
export function features(words: Word[], i: number): { own: string[]; shared: string[] } {
  const w = words[i];
  const l = w.left;
  const r = w.right;
  const l2 = i > 0 && !MARKERS.has(l) ? words[i - 1].left : "_";
  const r2 = i < words.length - 1 && !MARKERS.has(r) ? words[i + 1].right : "_";
  const suf = w.key.slice(-3);
  // endings of the neighbours stand in for their grammar ("declarat că", "o ...ă")
  const ls = l.slice(-3);
  const rs = r.slice(-3);
  return {
    own: [
      "b", "L" + l, "R" + r, "B" + l + "|" + r, "P" + l2 + "|" + l, "N" + r + "|" + r2, "l" + l2, "r" + r2,
      "s" + ls, "t" + rs, "u" + ls + "|" + rs,
    ],
    shared: [
      "b", "L" + l, "R" + r, "B" + l + "|" + r, "X" + suf + "|" + l, "Y" + suf + "|" + r, "Z" + suf,
      "S" + ls + "|" + suf, "T" + suf + "|" + rs,
    ],
  };
}
