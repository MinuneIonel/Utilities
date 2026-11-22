// Pure helpers behind the inspector's number settings: the slider's range for what the node has
// seen, proportional (log) sliders, labels split from their hints. No DOM, so Node tests can import it.
import type { NodeFacts, NumberFit, NumberParam, Params } from "../runtime/types";

/** "Bitrate kbps (0 = default)" → "Bitrate kbps" with the hint "0 = default". */
export function labelParts(label: string): { main: string; hint?: string } {
  const m = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(label);
  return m ? { main: m[1], hint: m[2] } : { main: label };
}

/** Positions on a proportional slider: the range input runs 0..LOG_STOPS. */
export const LOG_STOPS = 1000;

const decimals = (step: number) => {
  const s = String(step);
  return s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
};

/** Snapped to the step grid (from `min`), clamped, without float noise. */
export function snap(v: number, min: number, max: number, step: number): number {
  const grid = step > 0 ? step : 1;
  const n = Math.min(max, Math.max(min, min + Math.round((v - min) / grid) * grid));
  return Number(n.toFixed(decimals(grid)));
}

/** The lowest value a proportional slider can show above zero: its min, or one step when that's 0 or less. */
const logFloor = (min: number, step: number) => (min > 0 ? min : Math.max(step, 1e-6));

/** Where a value sits on a proportional slider (0..LOG_STOPS). A min of 0 or less is the first stop. */
export function toLog(value: number, min: number, max: number, step: number): number {
  const a = logFloor(min, step);
  if (max <= a) return value > min ? LOG_STOPS : 0;
  if (value <= min || value < a) return 0;
  return Math.round((LOG_STOPS * Math.log(Math.min(value, max) / a)) / Math.log(max / a));
}

/** The value at a proportional slider's position: two significant digits, on the step grid. */
export function fromLog(pos: number, min: number, max: number, step: number): number {
  const a = logFloor(min, step);
  if (pos <= 0) return min;
  if (pos >= LOG_STOPS) return max;
  const raw = a * Math.pow(max / a, pos / LOG_STOPS);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return snap(Math.round(raw / mag) * mag, a, max, step);
}

/** What the slider spans now: the fit for what the node has seen, widened to hold the current value. */
export interface SliderRange {
  min: number;
  max: number;
  fit?: NumberFit;
}

export function sliderRange(def: NumberParam, value: number, facts: NodeFacts | undefined, params: Params | undefined): SliderRange {
  let fit: NumberFit | undefined;
  try {
    fit = facts && def.fit ? def.fit(facts, params ?? {}) : undefined;
  } catch {
    fit = undefined;
  }
  let min = Math.max(def.min, fit?.min ?? def.min);
  let max = Math.min(def.max, fit?.max ?? def.max);
  if (!(max > min)) ({ min, max } = def);
  // A value typed past the fitted range keeps the slider honest: it reaches to the value.
  if (Number.isFinite(value)) {
    min = Math.min(min, Math.max(def.min, value));
    max = Math.max(max, Math.min(def.max, value));
  }
  return { min, max, fit };
}

/** A pick setting's 1-based value, kept to the items there are. */
export function pickIndex(value: unknown, count: number): number {
  const n = Math.floor(Number(value) || 1);
  return Math.min(Math.max(1, count), Math.max(1, n));
}

/**
 * A % of the way through `duration`, in seconds, and back. A typed time isn't snapped to the slider's
 * step (0.5 % of an hour is 18 s): it lands where it was typed, to a thousandth of a %.
 */
export const pctToSeconds = (pct: number, duration: number) => (Math.min(100, Math.max(0, pct)) / 100) * duration;
export function secondsToPct(seconds: number, duration: number, def: Pick<NumberParam, "min" | "max">): number {
  if (!(duration > 0)) return def.min;
  return Number(Math.min(def.max, Math.max(def.min, (seconds / duration) * 100)).toFixed(3));
}
