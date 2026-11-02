/**
 * Scroll the mouse wheel over a slider (or a number box) to nudge its value, like Blender.
 *
 *   wheel          about 1% of the slider's range per notch (never less than its step)
 *   Shift + wheel  fine: one step per notch
 *   ⌘/Ctrl + wheel coarse: about 10% per notch
 *
 * It only takes over a wheel gesture that *starts* on a slider. Once the panel is scrolling,
 * the rest of that gesture (including trackpad momentum) keeps scrolling the panel even as
 * sliders pass under the pointer, so scrolling a long Properties panel never snags on one.
 *
 * It works on every range/number input in the page, React-controlled or not: it sets the value
 * and fires the same `input` event a drag would, then one `change` when the gesture ends.
 */

export type Nudge = "fine" | "normal" | "coarse";

/** Wheel events further apart than this start a new gesture. */
const GESTURE_GAP_MS = 250;
/** A wheel event at least this big is one mouse notch; smaller ones (trackpads) add up. */
const NOTCH_PX = 50;
/** Trackpad travel per step. */
const TRACKPAD_PX = 30;

/** Pure: the next value after `steps` nudges (positive = up), snapped to the step grid and clamped. */
export function nudgeValue(
  value: number,
  steps: number,
  { min, max, step }: { min: number; max: number; step: number },
  mode: Nudge = "normal",
): number {
  const hasRange = Number.isFinite(min) && Number.isFinite(max) && max > min;
  const grid = step > 0 ? step : hasRange ? (max - min) / 100 : 1;
  const span = hasRange ? max - min : grid * 100;
  const snap = (d: number) => Math.max(grid, Math.round(d / grid) * grid);
  const by = mode === "fine" ? grid : mode === "coarse" ? snap(span / 10) : snap(span / 100);
  const base = Number.isFinite(min) ? min : 0;
  let next = base + Math.round((value + steps * by - base) / grid) * grid;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  // Trim float noise (0.1 + 0.2) to the step's own decimals.
  const decimals = Math.min(10, (String(grid).split(".")[1] ?? "").length + 2);
  return Number(next.toFixed(decimals));
}

function nudgeable(t: EventTarget | null): HTMLInputElement | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest("input");
  if (!el || (el.type !== "range" && el.type !== "number") || el.disabled || el.readOnly) return null;
  return el;
}

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

export function installWheelNudge(root: Document | HTMLElement = document): () => void {
  let last = 0;
  let target: HTMLInputElement | "scroll" | null = null;
  let acc = 0;
  let changeTimer = 0;

  const finish = (el: HTMLInputElement) => {
    clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => el.dispatchEvent(new Event("change", { bubbles: true })), GESTURE_GAP_MS);
  };

  const onWheel = (e: WheelEvent) => {
    const now = performance.now();
    const fresh = now - last > GESTURE_GAP_MS;
    last = now;
    const over = nudgeable(e.target);
    if (fresh) {
      target = over ?? "scroll";
      acc = 0;
    }
    // Pointer left the slider mid-gesture: hand the rest of it back to the panel.
    if (target !== "scroll" && over !== target) target = "scroll";
    if (target === "scroll" || !target) return;

    e.preventDefault();
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    let steps = 0;
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(delta) >= NOTCH_PX) {
      steps = -Math.sign(delta);
      acc = 0;
    } else {
      acc += delta;
      steps = -Math.trunc(acc / TRACKPAD_PX);
      acc -= -steps * TRACKPAD_PX;
    }
    if (!steps) return;

    const el = target;
    const mode: Nudge = e.shiftKey ? "fine" : e.metaKey || e.ctrlKey ? "coarse" : "normal";
    const current = el.value === "" ? Number(el.min || 0) : Number(el.value);
    const step = el.step === "any" ? NaN : Number(el.step || 1);
    const next = nudgeValue(
      current,
      steps,
      { min: el.min === "" ? -Infinity : Number(el.min), max: el.max === "" ? Infinity : Number(el.max), step },
      mode,
    );
    if (next === current) return;
    setNativeValue.call(el, String(next));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    finish(el);
  };

  // Capture + non-passive so we can stop the panel scrolling before it starts.
  root.addEventListener("wheel", onWheel as EventListener, { capture: true, passive: false });
  return () => root.removeEventListener("wheel", onWheel as EventListener, { capture: true });
}
