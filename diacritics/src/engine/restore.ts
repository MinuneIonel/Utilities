import { features, fold, hasDiacritics, matchCase, normalize, tokenize } from "./text.ts";
import { guess, type Model } from "./model.ts";
import { neuralScores, neuralStream } from "./neural.ts";

export interface Alternative {
  form: string;
  /** Share of the model's belief, 0..1. */
  p: number;
}

export interface RestoredWord {
  start: number;
  end: number;
  input: string;
  output: string;
  changed: boolean;
  /** Candidates best first; one entry when the word is not ambiguous. */
  alternatives: Alternative[];
  /** How the word was decided: context model, lexicon lookup, the letter model (words it restores
   * correctly are left out of the lexicon to keep the model small, so this includes most rare
   * dictionary words as well as unknown ones), kept because it already had diacritics, or
   * overridden by the user. "unknown" means the letter model left the word unchanged. */
  source: "context" | "dictionary" | "guess" | "kept" | "override" | "unknown";
}

export interface RestoreOptions {
  /** Words typed with some diacritics keep them (candidates must agree). Default true. */
  keepExisting?: boolean;
  /** Forced forms by word index (from clicking an alternative). Ignored if the word changed. */
  overrides?: Map<number, string>;
}

export interface RestoreResult {
  text: string;
  words: RestoredWord[];
}

/** Text in, text out: the pipeline stage. */
export function restoreText(text: string, model: Model, options?: RestoreOptions): string {
  return restore(text, model, options).text;
}

export function restore(input: string, model: Model, options: RestoreOptions = {}): RestoreResult {
  const keepExisting = options.keepExisting ?? true;
  const text = normalize(input);
  const words = tokenize(text);
  const stream = model.neural ? neuralStream(text, words) : null;
  const out: RestoredWord[] = [];
  let result = "";
  let pos = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.text.toLowerCase();
    let alternatives = decide(model, words, i, stream);
    let source: RestoredWord["source"] = alternatives.length > 1 ? "context" : "dictionary";
    if (alternatives.length === 0) {
      const g = guess(model, w.key);
      alternatives = [{ form: g, p: 1 }];
      source = g === w.key ? "unknown" : "guess";
    }

    if (keepExisting && hasDiacritics(lower)) {
      const agree = alternatives.filter((a) => agreesWith(lower, a.form));
      if (agree.length) {
        const total = agree.reduce((s, a) => s + a.p, 0);
        alternatives = agree.map((a) => ({ form: a.form, p: a.p / total }));
      } else {
        alternatives = [{ form: lower, p: 1 }, ...alternatives.filter((a) => a.form !== lower)];
      }
      source = "kept";
    }

    const forced = options.overrides?.get(i);
    let form = alternatives[0].form;
    if (forced && fold(forced) === w.key) {
      form = forced;
      source = "override";
      if (!alternatives.some((a) => a.form === forced)) alternatives.push({ form: forced, p: 0 });
    }

    const output = matchCase(w.text, form);
    out.push({ start: w.start, end: w.end, input: w.text, output, changed: output !== w.text, alternatives, source });
    result += text.slice(pos, w.start) + output;
    pos = w.end;
  }
  result += text.slice(pos);
  return { text: result, words: out };
}

/** Diacritics already in the typed word must appear in the candidate. */
function agreesWith(typed: string, form: string): boolean {
  const a = [...typed];
  const b = [...form];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== fold(a[i]) && a[i] !== b[i]) return false;
  return true;
}

function decide(
  model: Model,
  words: ReturnType<typeof tokenize>,
  i: number,
  stream: ReturnType<typeof neuralStream> | null,
): Alternative[] {
  const key = words[i].key;
  const forms = model.forms.get(key);
  if (!forms) return [];
  if (forms.length === 1) return [{ form: forms[0], p: 1 }];

  const { own, shared } = features(words, i);
  const scores = Float64Array.from(model.prior.get(key) ?? new Float64Array(forms.length));
  for (const f of own) {
    const ws = model.own.get(key + "\t" + f);
    if (ws) for (let j = 0; j < forms.length; j++) scores[j] += ws[j];
  }
  for (const f of shared) {
    const bySig = model.shared.get(f);
    if (!bySig) continue;
    for (let j = 0; j < forms.length; j++) scores[j] += bySig.get(signature(forms[j])) ?? 0;
  }
  // perceptron log-probabilities, calibrated by the temperature
  let max = Math.max(...scores);
  let total = scores.reduce((a, s) => a + Math.exp((s - max) * model.temperature), 0);
  for (let j = 0; j < forms.length; j++) scores[j] = (scores[j] - max) * model.temperature - Math.log(total);
  // plus the neural helper's, for words the perceptron is unsure about
  let scale = 1;
  const net = model.neural;
  if (net && stream && Math.exp(Math.max(...scores)) < net.gate) {
    const nn = neuralScores(net, stream.tokens, stream.positions[i], key, forms);
    for (let j = 0; j < forms.length; j++) scores[j] += net.weight * nn[j];
    scale = net.temperature;
  }
  max = Math.max(...scores);
  const exps = Array.from(scores, (s) => Math.exp((s - max) * scale));
  total = exps.reduce((a, b) => a + b, 0);
  return forms
    .map((form, j) => ({ form, p: exps[j] / total, s: scores[j] }))
    .sort((a, b) => b.s - a.s)
    .map(({ form, p }) => ({ form, p }));
}

export function signature(form: string): string {
  return form.slice(-1);
}
