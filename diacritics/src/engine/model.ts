// The trained model: candidate forms per folded word, context weights, and a letter-level
// guesser for words not in the lexicon. Built by training/train.py into public/model.dat.

export interface Model {
  /** Folded word → candidate forms (lower case). Absent: ask the letter guesser. */
  forms: Map<string, string[]>;
  /** Folded word → log P(form | word) from corpus counts, for words with several forms. */
  prior: Map<string, Float64Array>;
  /** key + "\t" + feature → weight per candidate, aligned with forms.get(key). */
  own: Map<string, Float32Array>;
  /** feature → (last letter of candidate → weight), shared by all words. */
  shared: Map<string, Map<string, number>>;
  /** letter + context window → restored letter. */
  chars: Map<string, string>;
  temperature: number;
  stats: { words: number; ambiguous: number; weights: number };
}

const VARIANTS: Record<string, true> = { a: true, i: true, s: true, t: true };

/** Same nested windows as training/train.py: grow right, then left, alternating. */
function windows(k: string, j: number, out: string[]): void {
  out.length = 0;
  let a = j;
  let b = j + 1;
  for (let step = 0; step < 9; step++) {
    if (step % 2 === 0) b++;
    else a--;
    a = Math.max(a, 0);
    b = Math.min(b, k.length);
    out.push(k.slice(a, j) + "_" + k.slice(j + 1, b));
  }
}

/** Restore a word the lexicon doesn't know, letter by letter. */
export function guess(model: Model, key: string): string {
  if (/[\uD800-\uDFFF]/.test(key)) return key;
  const k = "^" + key + "$";
  const out = [...k];
  const ws: string[] = [];
  for (let j = 1; j < k.length - 1; j++) {
    const ch = k[j];
    if (!VARIANTS[ch]) continue;
    let d = model.chars.get(ch) ?? ch;
    windows(k, j, ws);
    for (const w of ws) {
      const hit = model.chars.get(ch + w);
      if (hit !== undefined) d = hit;
    }
    out[j] = d;
  }
  return out.slice(1, -1).join("");
}

export function parseModel(text: string): Model {
  const lines = text.split("\n");
  if (!lines[0].startsWith("diacritics-model 1")) throw new Error("Not a diacritics model");
  const model: Model = {
    forms: new Map(),
    prior: new Map(),
    own: new Map(),
    shared: new Map(),
    chars: new Map(),
    temperature: 1,
    stats: { words: 0, ambiguous: 0, weights: 0 },
  };
  const keys: string[] = [];
  let section = "";
  let scale = 1;
  let priorWeight = 1;
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line) continue;
    if (line[0] === "[") {
      section = line;
      continue;
    }
    switch (section) {
      case "[meta]": {
        const [name, value] = line.split(" ");
        if (name === "temperature") model.temperature = Number(value);
        if (name === "scale") scale = Number(value);
        if (name === "prior") priorWeight = Number(value);
        break;
      }
      case "[forms]": {
        // one line per word: "form" or "form:count form:count ..." (most frequent first)
        const parts = line.split(" ");
        const forms = parts.map((p) => p.split(":")[0]);
        const key = foldPlain(forms[0]);
        keys.push(key);
        model.forms.set(key, forms);
        if (forms.length > 1) {
          model.stats.ambiguous++;
          // add-half smoothing, as in train.py
          const counts = parts.map((p) => Number(p.split(":")[1] ?? 0));
          const total = counts.reduce((a, b) => a + b, 0) + 0.5 * counts.length;
          model.prior.set(key, Float64Array.from(counts, (c) => priorWeight * Math.log((c + 0.5) / total)));
        }
        break;
      }
      case "[own]": {
        // keyIndex<TAB>feature<TAB>w,w,w   (weights are integers, divide by scale)
        const t1 = line.indexOf("\t");
        const t2 = line.indexOf("\t", t1 + 1);
        const key = keys[parseInt(line.slice(0, t1), 36)];
        const ws = line.slice(t2 + 1).split(",");
        const arr = new Float32Array(ws.length);
        for (let j = 0; j < ws.length; j++) arr[j] = ws[j] ? Number(ws[j]) / scale : 0;
        model.own.set(key + "\t" + line.slice(t1 + 1, t2), arr);
        model.stats.weights += ws.length;
        break;
      }
      case "[shared]": {
        // feature<TAB>letter:w letter:w
        const tab = line.indexOf("\t");
        const m = new Map<string, number>();
        for (const pair of line.slice(tab + 1).split(" ")) {
          const c = pair.indexOf(":");
          m.set(pair.slice(0, c), Number(pair.slice(c + 1)) / scale);
        }
        model.shared.set(line.slice(0, tab), m);
        break;
      }
      case "[chars]": {
        const tab = line.indexOf("\t");
        model.chars.set(line.slice(0, tab), line.slice(tab + 1));
        break;
      }
    }
  }
  model.stats.words = model.forms.size;
  return model;
}

function foldPlain(w: string): string {
  return w.replace(/[ăâ]/g, "a").replace(/î/g, "i").replace(/ș/g, "s").replace(/ț/g, "t");
}
