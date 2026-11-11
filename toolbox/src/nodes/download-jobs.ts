// Bookkeeping for Download nodes' fetches, apart from yt-dlp so it can be tested on its own:
// one fetch per link for the session, stoppable while it runs, and dropped when its link changes.

export const STOPPED = "Download stopped. Render to download it.";

interface Job<T> {
  result: Promise<T>;
  abort: AbortController;
  /** Started by a live preview (pasting a link), rather than by Render. */
  preview: boolean;
  done: boolean;
}

export class DownloadJobs<T> {
  private jobs = new Map<string, Job<T>>();
  /** Fetches the user stopped. Previews don't start them again; Render does. */
  private stopped = new Set<string>();

  /**
   * The fetch for `key`, started with `start` the first time it's asked for. `signal` is Render's
   * Cancel, which stops it too. A failed or stopped fetch is forgotten, so asking again retries.
   */
  get(key: string, mode: "preview" | "render", signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // Render is asking for it on purpose, so a stopped download starts again.
    if (mode === "render") this.stopped.delete(key);
    if (this.stopped.has(key)) return Promise.reject(new Error(STOPPED));
    const running = this.jobs.get(key);
    if (running) {
      if (!running.done && mode === "render" && running.preview) {
        // Render now waits on a fetch a preview started: it's Render's to cancel, and no longer a preview's to drop.
        running.preview = false;
        signal?.addEventListener("abort", () => running.abort.abort(), { once: true });
      }
      return running.result;
    }
    const abort = new AbortController();
    const onCancel = () => abort.abort();
    signal?.addEventListener("abort", onCancel, { once: true });
    const why = () => new Error(this.stopped.has(key) ? STOPPED : "Cancelled");
    const result = (async () => {
      try {
        const r = await start(abort.signal).catch((e: unknown) => {
          throw abort.signal.aborted ? why() : e;
        });
        if (abort.signal.aborted) throw why();
        return r;
      } finally {
        signal?.removeEventListener("abort", onCancel);
      }
    })();
    const job: Job<T> = { result, abort, preview: mode === "preview", done: false };
    this.jobs.set(key, job);
    result.then(
      () => (job.done = true),
      () => this.jobs.get(key) === job && this.jobs.delete(key),
    );
    return result;
  }

  /** Stops every fetch still running (the Stop download button). */
  stop() {
    for (const [key, job] of this.jobs) {
      if (job.done) continue;
      this.stopped.add(key);
      job.abort.abort();
    }
  }

  /** Stops preview fetches that no node asks for any more (its link changed, or it was deleted). */
  prune(wanted: ReadonlySet<string>) {
    for (const [key, job] of this.jobs) {
      if (job.done || !job.preview || wanted.has(key)) continue;
      job.abort.abort();
      this.jobs.delete(key);
    }
  }
}
