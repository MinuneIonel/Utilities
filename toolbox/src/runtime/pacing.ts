// Playback pacing: when to show a frame and when to skip it, how fast playback can honestly go
// when the graph is slower than the video, how many frames may wait for the window, and when the
// sound has drifted off the picture. Dependency-free so plain Node tests can import it.

/** A frame more than this late (ms) is skipped rather than shown. */
export const LATE_MS = 80;
/** With nothing shown for this long (ms), a late frame is shown anyway: a slow graph still shows something. */
export const STARVE_MS = 250;
/** Frames the worker may send before the window says it has drawn them. */
export const MAX_UNACKED = 2;
/** Fewer frames than this per second of video looks like a slideshow: playback slows down instead. */
export const MIN_FPS = 10;
/** Sound further off the picture than this (seconds) is moved back in line. */
export const DRIFT_MAX = 0.12;
/** The slowest playback goes. */
export const MIN_RATE = 0.1;

/**
 * What to do with a frame that starts at `frameMs` on the play clock, which reads `clockMs` now:
 * wait for its time, show it, or skip it when it's more than `late` ms behind. A late frame is
 * shown anyway when nothing has been shown for STARVE_MS (`sinceShownMs`).
 */
export function nextAction(clockMs: number, frameMs: number, late = LATE_MS, sinceShownMs = 0): "show" | "skip" | "wait" {
  if (frameMs > clockMs) return "wait";
  if (clockMs - frameMs > late && sinceShownMs < STARVE_MS) return "skip";
  return "show";
}

/**
 * How fast to play, given how many frames a second the graph makes (`throughput`) and the video's
 * frame rate: real time while at least MIN_FPS frames per second of video get shown, slower below
 * that, in steps of 0.1. It slows down readily but only speeds up again with some room to spare,
 * so it doesn't flicker between two speeds.
 */
export function rateFor(throughput: number, fps: number, current = 1): number {
  const need = Math.min(fps > 0 ? fps : 30, MIN_FPS);
  // Above 1 when there's time to spare.
  const ratio = throughput / need;
  const step = (x: number) => Math.min(1, Math.max(MIN_RATE, Math.floor(x * 10 + 1e-9) / 10));
  if (ratio < current - 0.1) return step(ratio);
  if (ratio >= current + 0.2) return step(ratio);
  return current;
}

/**
 * The play clock: video seconds against wall time (ms, e.g. performance.now()). It starts at the
 * first frame shown, so the time taken to get going doesn't count as lateness, and runs at `rate`.
 */
export class PlayClock {
  rate: number;
  /** How long a shown frame takes to make, smoothed (ms). */
  costMs: number | undefined;
  private base: number;
  private baseWall: number | undefined;
  private fps: number;

  /** `prev`: the clock of the pass before (playback looping), whose speed carries on. */
  constructor(from: number, fps: number, prev?: PlayClock) {
    this.base = from;
    this.fps = fps;
    this.rate = prev?.rate ?? 1;
    this.costMs = prev?.costMs;
  }

  get started() {
    return this.baseWall !== undefined;
  }

  start(now: number, t: number) {
    this.base = t;
    this.baseWall = now;
  }

  /** Video seconds at wall time `now`; before the start, where playback starts. */
  at(now: number): number {
    return this.baseWall === undefined ? this.base : this.base + ((now - this.baseWall) / 1000) * this.rate;
  }

  /**
   * Frames that start before this (seconds) would be too late by the time they were made, so a
   * source may leave them out. Nothing is skipped before the start.
   */
  skipTo(now: number): number {
    if (this.baseWall === undefined) return -Infinity;
    return this.at(now + (this.costMs ?? 0)) - LATE_MS / 1000;
  }

  /** Wall-clock ms until video time `t` comes. */
  until(now: number, t: number): number {
    return Math.max(0, ((t - this.at(now)) * 1000) / this.rate);
  }

  /** After a frame is shown: `workMs` is how long it took to make, not counting waiting for its time. */
  shown(now: number, workMs: number) {
    // Smoothed over about ten frames, so one slow frame doesn't change the speed.
    this.costMs = this.costMs === undefined ? workMs : this.costMs * 0.9 + workMs * 0.1;
    const rate = rateFor(1000 / Math.max(1, this.costMs), this.fps, this.rate);
    if (rate === this.rate) return;
    // Rebased, so the clock doesn't jump when its speed changes.
    this.base = this.at(now);
    this.baseWall = now;
    this.rate = rate;
  }
}

/** Frames sent but not yet drawn by the window: the worker waits once MAX_UNACKED are out. */
export class AckWindow {
  inFlight = 0;
  readonly max: number;
  private waiting: (() => void)[] = [];

  constructor(max = MAX_UNACKED) {
    this.max = max;
  }

  sent() {
    this.inFlight++;
  }

  acked() {
    if (this.inFlight > 0) this.inFlight--;
    if (this.inFlight < this.max) this.waiting.shift()?.();
  }

  /** Resolves once fewer than `max` frames are out; rejects when `signal` aborts. */
  ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Stopped"));
    if (this.inFlight < this.max) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        this.waiting = this.waiting.filter((w) => w !== go);
        reject(new Error("Stopped"));
      };
      this.waiting.push(go);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
}

/** Whether sound at `audioTime` is far enough off `expected` (both seconds) to move it back in line. */
export const needsResync = (audioTime: number, expected: number, max = DRIFT_MAX) => Math.abs(audioTime - expected) > max;

/** Sound closer to the picture than this (seconds) is left alone. */
export const DRIFT_OK = 0.03;

/**
 * How fast the sound should play to catch up with the picture: a little faster when it's behind,
 * a little slower when ahead (at most 10%, which is hard to hear), 1 once it's back in step.
 * A jump (needsResync) would only add the time sound takes to start again.
 */
export function soundRate(audioTime: number, expected: number): number {
  const drift = audioTime - expected;
  if (Math.abs(drift) <= DRIFT_OK) return 1;
  return Math.min(1.1, Math.max(0.9, 1 - drift));
}

/** 63.4 s as "1:03". */
export function clockText(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
