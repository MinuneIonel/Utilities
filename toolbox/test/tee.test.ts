import assert from "node:assert/strict";
import { test } from "node:test";
import { TEE_MAX, share, tee } from "../src/runtime/tee.ts";

/** A source of 0..n-1 that counts how often it was started, how far it got and whether it was closed. */
function counter(n: number, failAt = -1) {
  const s = { starts: 0, made: 0, closed: 0, signals: [] as (AbortSignal | undefined)[] };
  const source = (signal?: AbortSignal) =>
    (async function* () {
      s.starts++;
      s.signals.push(signal);
      try {
        for (let i = 0; i < n; i++) {
          await Promise.resolve();
          if (i === failAt) throw new Error("decode failed");
          s.made++;
          yield i;
        }
      } finally {
        s.closed++;
      }
    })();
  return { s, source };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test("tee: every reader gets every item in order, from one pass", async () => {
  const { s, source } = counter(10);
  const [a, b, c] = tee(source, 3);
  const got = await Promise.all([all(a.iterate()), all(b.iterate()), all(c.iterate())]);
  const want = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(got, [want, want, want]);
  assert.equal(s.starts, 1);
  assert.equal(s.closed, 1);
});

test("tee: the source never runs more than TEE_MAX items ahead of the slowest reader", async () => {
  const { s, source } = counter(20);
  const [fast, slow] = tee(source, 2);
  const fastDone = all(fast.iterate());
  await settle();
  assert.equal(s.made, TEE_MAX);
  const it = slow.iterate()[Symbol.asyncIterator]();
  assert.deepEqual(await it.next(), { done: false, value: 0 });
  await settle();
  assert.equal(s.made, TEE_MAX + 1);
  const rest: number[] = [];
  for (let r = await it.next(); !r.done; r = await it.next()) {
    rest.push(r.value);
    assert.ok(s.made - (rest.length + 1) <= TEE_MAX, `made ${s.made} with the slow reader at ${rest.length + 1}`);
  }
  assert.equal(rest.length, 19);
  assert.equal((await fastDone).length, 20);
  assert.equal(s.starts, 1);
});

test("tee: a reader that stops early leaves; the others go on, and the source closes once", async () => {
  const { s, source } = counter(10);
  const [a, b] = tee(source, 2);
  const early = (async () => {
    const out: number[] = [];
    for await (const x of a.iterate()) {
      out.push(x);
      if (out.length === 2) break;
    }
    return out;
  })();
  const [first, second] = await Promise.all([early, all(b.iterate())]);
  assert.deepEqual(first, [0, 1]);
  assert.equal(second.length, 10);
  assert.equal(s.starts, 1);
  assert.equal(s.closed, 1);
});

test("tee: when every reader stops early, the source is closed", async () => {
  const { s, source } = counter(100);
  const [a, b] = tee(source, 2);
  const take = async (slot: typeof a, n: number) => {
    for await (const x of slot.iterate()) if (x >= n) break;
  };
  await Promise.all([take(a, 1), take(b, 3)]);
  assert.equal(s.closed, 1);
  assert.ok(s.made < 10, `made ${s.made}`);
});

test("tee: an error in the source reaches every reader", async () => {
  const { source } = counter(10, 3);
  const [a, b] = tee(source, 2);
  const results = await Promise.allSettled([all(a.iterate()), all(b.iterate())]);
  for (const r of results) {
    assert.equal(r.status, "rejected");
    assert.match(String((r as PromiseRejectedResult).reason), /decode failed/);
  }
});

test("tee: a reader waiting for a slow one stops when its signal is aborted", async () => {
  const { s, source } = counter(20);
  const [fast] = tee(source, 2);
  const ac = new AbortController();
  const run = all(fast.iterate(ac.signal));
  await settle();
  assert.equal(s.made, TEE_MAX);
  ac.abort();
  await assert.rejects(run, /Cancelled|abort/i);
  // The source got the signal of the reader that started it, so a decoder can stop too.
  assert.equal(s.signals[0], ac.signal);
});

test("tee: a released slot that never read doesn't hold the others up", async () => {
  const { s, source } = counter(12);
  const [a, b] = tee(source, 2);
  const run = all(a.iterate());
  await settle();
  b.release();
  assert.equal((await run).length, 12);
  assert.equal(s.starts, 1);
  // Reading a released slot later (a lazy reader) still works: it starts its own pass.
  assert.equal((await all(b.iterate())).length, 12);
  assert.equal(s.starts, 2);
});

test("tee: release after reading changes nothing, and a second read (a retry) starts its own pass", async () => {
  const { s, source } = counter(5);
  const [a, b] = tee(source, 2);
  await Promise.all([all(a.iterate()), all(b.iterate())]);
  a.release();
  assert.equal(s.starts, 1);
  assert.deepEqual(await all(a.iterate()), [0, 1, 2, 3, 4]);
  assert.equal(s.starts, 2);
});

test("share: readers that start together share a pass; a late one starts its own", async () => {
  const { s, source } = counter(8);
  const frames = share(source);
  // Side by side, as a frame node reads two inputs in step.
  const its = [frames()[Symbol.asyncIterator](), frames()[Symbol.asyncIterator]()];
  const got: number[][] = [[], []];
  for (;;) {
    const steps = await Promise.all(its.map((it) => it.next()));
    if (steps.some((x) => x.done)) break;
    steps.forEach((x, i) => got[i].push(x.value as number));
  }
  await Promise.all(its.map((it) => it.return?.()));
  assert.deepEqual(got[0], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(got[1], got[0]);
  assert.equal(s.starts, 1);

  // A reader joining after items went out starts again from the beginning.
  const first = frames()[Symbol.asyncIterator]();
  assert.deepEqual(await first.next(), { done: false, value: 0 });
  assert.deepEqual(await all(frames()), [0, 1, 2, 3, 4, 5, 6, 7]);
  await first.return?.();
  assert.equal(s.starts, 3);
});

test("share: an iterator that is made but never read holds nothing up", async () => {
  const { s, source } = counter(10);
  const frames = share(source);
  frames()[Symbol.asyncIterator]();
  assert.equal((await all(frames())).length, 10);
  assert.equal(s.starts, 1);
});
