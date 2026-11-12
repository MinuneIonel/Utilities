// Shares one stream of items (a video's frames) between several readers, so the work
// behind it (decoding, every frame node before it) runs once instead of once per reader.
// Dependency-free so plain Node tests can import it.

/** How many items a reader may fall behind the fastest one before the stream waits for it. */
export const TEE_MAX = 4;

/** `opts` say how to read the source (e.g. smaller frames for playback). */
export type Source<T, O = unknown> = (signal?: AbortSignal, opts?: O) => AsyncIterable<T>;

interface Reader<T> {
  queue: T[];
  left: boolean;
}

const cancelled = (signal: AbortSignal) => (signal.reason instanceof Error ? signal.reason : new Error("Cancelled"));

/**
 * One pass over a source and the readers sharing it. Nothing runs in the background:
 * a reader with nothing queued pulls the next item for everyone, unless another reader
 * already has `max` items waiting, in which case it waits for that reader to catch up.
 */
class Hub<T> {
  private readers = new Set<Reader<T>>();
  private it?: AsyncIterator<T>;
  private pulling = false;
  private done = false;
  private failed = false;
  private error: unknown;
  private closed = false;
  private wakers = new Set<() => void>();
  /** Whether an item has gone out yet: until then, a new reader still sees the whole stream. */
  delivered = false;

  private source: Source<T>;
  private max: number;
  /** What the pass was asked for: only readers asking the same share it. */
  readonly opts: unknown;

  constructor(source: Source<T>, max: number, opts?: unknown) {
    this.source = source;
    this.max = max;
    this.opts = opts;
  }

  get joinable() {
    return !this.delivered && !this.done && !this.closed;
  }

  add(): Reader<T> {
    const r: Reader<T> = { queue: [], left: false };
    this.readers.add(r);
    return r;
  }

  async next(r: Reader<T>, signal?: AbortSignal): Promise<IteratorResult<T, undefined>> {
    for (;;) {
      if (r.left) return { done: true, value: undefined };
      if (r.queue.length) {
        const value = r.queue.shift()!;
        this.wake();
        return { done: false, value };
      }
      if (this.failed) {
        await this.leave(r);
        throw this.error;
      }
      if (this.done) {
        await this.leave(r);
        return { done: true, value: undefined };
      }
      if (signal?.aborted) {
        await this.leave(r);
        throw cancelled(signal);
      }
      if (!this.pulling && ![...this.readers].some((o) => o !== r && o.queue.length >= this.max)) {
        await this.pull(signal);
        continue;
      }
      try {
        await this.changed(signal);
      } catch (err) {
        await this.leave(r);
        throw err;
      }
    }
  }

  /** A reader that stops early: the others go on; when none is left, the source is closed. */
  async leave(r: Reader<T>): Promise<void> {
    if (r.left) return;
    r.left = true;
    r.queue.length = 0;
    this.readers.delete(r);
    this.wake();
    if (!this.readers.size && !this.pulling) await this.close();
  }

  private async pull(signal?: AbortSignal) {
    this.pulling = true;
    try {
      this.it ??= this.source(signal)[Symbol.asyncIterator]();
      const step = await this.it.next();
      if (step.done) this.done = true;
      else {
        this.delivered = true;
        for (const o of this.readers) o.queue.push(step.value);
      }
    } catch (err) {
      this.failed = true;
      this.error = err;
      this.done = true;
    } finally {
      this.pulling = false;
      this.wake();
    }
    if (!this.readers.size) await this.close();
  }

  private async close() {
    if (this.closed) return;
    this.closed = true;
    const finished = this.done;
    this.done = true;
    if (this.it && !finished) {
      try {
        await this.it.return?.();
      } catch {
        // The source failing while it shuts down doesn't matter to readers that already left.
      }
    }
  }

  private changed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.wakers.delete(done);
        reject(cancelled(signal!));
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.wakers.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wake() {
    const ws = [...this.wakers];
    this.wakers.clear();
    for (const w of ws) w();
  }
}

function readerIterator<T>(start: () => { hub: Hub<T>; reader: Reader<T> } | AsyncIterator<T>, signal?: AbortSignal): AsyncIterableIterator<T> {
  let joined: { hub: Hub<T>; reader: Reader<T> } | AsyncIterator<T> | undefined;
  let ended = false;
  const isHub = (j: typeof joined): j is { hub: Hub<T>; reader: Reader<T> } => !!j && "hub" in j;
  return {
    async next() {
      if (ended) return { done: true, value: undefined };
      // Joins on the first pull, so an iterator that is made but never read holds nothing up.
      joined ??= start();
      return isHub(joined) ? joined.hub.next(joined.reader, signal) : joined.next();
    },
    async return() {
      ended = true;
      if (isHub(joined)) await joined.hub.leave(joined.reader);
      else await joined?.return?.();
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/**
 * Shared by timing: readers that start before the first item has gone out share one pass
 * over the source (e.g. two outputs of a frame node read side by side). A reader that starts
 * later starts a new pass, which is right, only slower. So does a reader asking with other
 * `opts`, compared by identity (one playback hands the same object all the way up).
 */
export function share<T, O = unknown>(source: Source<T, O>, max = TEE_MAX): Source<T, O> {
  let hub: Hub<T> | undefined;
  return (signal, opts) => ({
    [Symbol.asyncIterator]: () =>
      readerIterator(() => {
        if (!hub?.joinable || hub.opts !== opts) hub = new Hub((s) => source(s, opts), max, opts);
        return { hub, reader: hub.add() };
      }, signal),
  });
}

export interface TeeSlot<T> {
  /** The first call reads the shared pass; any later call (a retry) starts a pass of its own. */
  iterate(signal?: AbortSignal): AsyncIterable<T>;
  /**
   * Leaves the shared pass if this slot never started reading (its reader was a cache hit,
   * was missing another input, or failed), so the others don't wait for it.
   */
  release(): void;
}

/**
 * Shared by registration: `consumers` slots are reserved up front, so it doesn't matter who
 * starts first. Every slot must either be read or released, or the rest stall once they are
 * `max` items ahead of it.
 */
export function tee<T>(source: Source<T>, consumers: number, max = TEE_MAX): TeeSlot<T>[] {
  const hub = new Hub(source, max);
  return Array.from({ length: consumers }, () => {
    const reader = hub.add();
    let claimed = false;
    let released = false;
    return {
      iterate: (signal) => ({
        [Symbol.asyncIterator]: () =>
          readerIterator(() => {
            if (claimed || released) return source(signal)[Symbol.asyncIterator]();
            claimed = true;
            return { hub, reader };
          }, signal),
      }),
      release() {
        if (claimed || released) return;
        released = true;
        void hub.leave(reader);
      },
    };
  });
}
