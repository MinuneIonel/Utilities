// Neural helper: a small window network that re-scores words with several possible forms.
// It reads the 6 tokens on each side (folded words and punctuation markers), and scores each
// candidate form. Its log-probabilities are added to the perceptron's, weighted by `weight`.
// Built by training/train_neural.py into public/neural.dat.

import type { Word } from "./text.ts";

export interface Neural {
  window: number;
  /** Weight of the network's log-probabilities next to the perceptron's. */
  weight: number;
  /** Only words the perceptron is less sure about than this go through the network. */
  gate: number;
  /** Turns the combined score into the percentages shown in the app. */
  temperature: number;
  maxCandidates: number;
  vocab: Map<string, number>;
  suffixes: Map<string, number>;
  forms: Map<string, number>;
  signatures: Map<string, number>;
  endings: Map<string, number>;
  dims: { word: number; suffix: number; hidden: number; out: number };
  E: Float32Array;
  ES: Float32Array;
  W1: Float32Array;
  b1: Float32Array;
  W2: Float32Array;
  b2: Float32Array;
  F: Float32Array;
  G: Float32Array;
  Hn: Float32Array;
  bf: Float32Array;
  bg: Float32Array;
}

interface Header {
  window: number;
  weight: number;
  gate: number;
  temperature: number;
  maxCandidates: number;
  dims: Neural["dims"];
  vocab: string[];
  suffixes: string[];
  forms: string[];
  signatures: string[];
  endings: string[];
  tensors: { name: string; length: number; scale: number }[];
}

/** File layout: 4-byte little-endian header length, JSON header, then int8 tensors in header order. */
export function parseNeural(buf: ArrayBuffer): Neural {
  const view = new DataView(buf);
  const headerLength = view.getUint32(0, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength)));
  const index = (list: string[]) => new Map(list.map((s, i) => [s, i]));
  const tensors: Record<string, Float32Array> = {};
  let offset = 4 + headerLength;
  for (const t of header.tensors) {
    const q = new Int8Array(buf, offset, t.length);
    const out = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) out[i] = q[i] * t.scale;
    tensors[t.name] = out;
    offset += t.length;
  }
  return {
    window: header.window,
    weight: header.weight,
    gate: header.gate,
    temperature: header.temperature,
    maxCandidates: header.maxCandidates,
    dims: header.dims,
    vocab: index(header.vocab),
    suffixes: index(header.suffixes),
    forms: index(header.forms),
    signatures: index(header.signatures),
    endings: index(header.endings),
    E: tensors.E, ES: tensors.ES, W1: tensors.W1, b1: tensors.b1, W2: tensors.W2, b2: tensors.b2,
    F: tensors.F, G: tensors.G, Hn: tensors.Hn, bf: tensors.bf, bg: tensors.bg,
  };
}

/** The token stream the network reads: ^, folded words with punctuation markers between, $.
 * Returns the stream and the position of each word in it. */
export function neuralStream(text: string, words: Word[]): { tokens: string[]; positions: number[] } {
  const tokens = ["^"];
  const positions: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i > 0) {
      const g = gapMarker(text.slice(words[i - 1].end, words[i].start));
      if (g) tokens.push(g);
    }
    positions.push(tokens.length);
    tokens.push(words[i].key);
  }
  tokens.push("$");
  return { tokens, positions };
}

const DIGIT = /\p{Nd}/u;
function gapMarker(gap: string): string | null {
  if (DIGIT.test(gap)) return "#";
  const s = gap.trim();
  if (!s) return null;
  if (gap === "-") return "-";
  if (/[.!?…]/.test(s)) return ".";
  return ",";
}

/** Characters where the form differs from the folded word, as "ă1 ț3" (letter + distance from the end), last two. */
function signature(key: string, form: string): string {
  const k = [...key];
  const f = [...form];
  const diffs: string[] = [];
  for (let j = 0; j < f.length; j++) if (f[j] !== k[j]) diffs.push(f[j] + (f.length - j));
  return diffs.slice(-2).join(" ") || "=";
}

/** Log-probabilities of each form. The network scores the most frequent `maxCandidates` forms;
 * any rarer ones get the lowest of those scores. */
export function neuralScores(net: Neural, tokens: string[], pos: number, key: string, allForms: string[]): Float64Array {
  const forms = allForms.slice(0, net.maxCandidates);
  const { word: DE, suffix: DS, hidden: H, out: DC } = net.dims;
  const W = net.window;
  const D = (2 * W + 1) * (DE + DS);
  const x = new Float32Array(D);
  for (let j = -W; j <= W; j++) {
    const p = pos + j;
    const t = p >= 0 && p < tokens.length ? tokens[p] : "<pad>";
    const v = t === "<pad>" ? 0 : (net.vocab.get(t) ?? 0);
    const s = net.suffixes.get(t.slice(-3)) ?? 0;
    const o = (j + W) * (DE + DS);
    x.set(net.E.subarray(v * DE, v * DE + DE), o);
    x.set(net.ES.subarray(s * DS, s * DS + DS), o + DE);
  }
  const h = new Float32Array(H);
  h.set(net.b1);
  for (let i = 0; i < D; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const row = i * H;
    for (let k = 0; k < H; k++) h[k] += xi * net.W1[row + k];
  }
  for (let k = 0; k < H; k++) h[k] = Math.tanh(h[k]);
  const ctx = new Float32Array(DC);
  ctx.set(net.b2);
  for (let k = 0; k < H; k++) {
    const hk = h[k];
    const row = k * DC;
    for (let c = 0; c < DC; c++) ctx[c] += hk * net.W2[row + c];
  }
  const scores = new Float64Array(forms.length);
  for (let n = 0; n < forms.length; n++) {
    const f = net.forms.get(forms[n]) ?? 0;
    const g = net.signatures.get(signature(key, forms[n])) ?? 0;
    const e = net.endings.get(forms[n].slice(-2)) ?? 0;
    let s = net.bf[f] + net.bg[g];
    for (let c = 0; c < DC; c++) s += ctx[c] * (net.F[f * DC + c] + net.G[g * DC + c] + net.Hn[e * DC + c]);
    scores[n] = s;
  }
  const max = Math.max(...scores);
  let total = 0;
  for (const s of scores) total += Math.exp(s - max);
  const log = Math.log(total) + max;
  const min = Math.min(...scores);
  return Float64Array.from(allForms, (_, n) => (n < forms.length ? scores[n] : min) - log);
}
