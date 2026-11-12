import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultCache, evaluate } from "../src/runtime/evaluate.ts";
import { AckWindow, LATE_MS, MAX_UNACKED, MIN_RATE, PlayClock, STARVE_MS, clockText, needsResync, nextAction, rateFor, soundRate } from "../src/runtime/pacing.ts";
import { share } from "../src/runtime/tee.ts";
import type { Converter, FrameOptions, Graph, NodeDef, RunContext, Value, VideoValue } from "../src/runtime/types.ts";

// A fake video of 10 text frames at 10 fps that records the options each pass was started with,
// and honours `from` and `skipTo` the way a video file does.
function fakeSource(frames = 10) {
  const passes: (FrameOptions | undefined)[] = [];
  const video = (): VideoValue => ({
    kind: "video", of: "text", width: 100, height: 100, duration: frames / 10, fps: 10,
    poster: { kind: "text", text: "poster" },
    async *frames(_signal, opts) {
      passes.push(opts);
      for (let i = Math.round((opts?.from ?? 0) * 10); i < frames; i++) {
        await Promise.resolve();
        if (opts?.skipTo && i / 10 < opts.skipTo()) continue;
        yield { value: { kind: "text", text: `f${i}@${opts?.maxSide ?? "full"}` }, timestamp: i / 10, duration: 0.1 };
      }
    },
  });
  return { passes, video };
}

function defsFor(src: ReturnType<typeof fakeSource>, other = fakeSource()): Map<string, NodeDef> {
  const defs: NodeDef[] = [
    {
      type: "vid", title: "Video", category: "input", description: "", inputs: [], params: [],
      outputs: [{ key: "video", label: "Video", type: "video" }], defaults: () => ({}), kind: "frame",
      run: async () => ({ video: src.video() }),
    },
    {
      type: "vid2", title: "Video 2", category: "input", description: "", inputs: [], params: [],
      outputs: [{ key: "video", label: "Video", type: "video" }], defaults: () => ({}), kind: "frame",
      run: async () => ({ video: other.video() }),
    },
    {
      type: "upper", title: "Upper", category: "text", description: "", params: [],
      inputs: [{ key: "text", label: "Text", type: "text" }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({}), kind: "frame",
      run: async (i) => ({ text: { kind: "text", text: (i.text as { text: string }).text.toUpperCase() } }),
    },
    {
      type: "join", title: "Join", category: "text", description: "", params: [],
      inputs: [{ key: "x", label: "X", type: "text" }, { key: "y", label: "Y", type: "text" }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({}), kind: "frame",
      run: async (i) => ({ text: { kind: "text", text: `${(i.x as { text: string }).text}+${(i.y as { text: string }).text}` } }),
    },
    {
      // Reads every frame on Render, like Encode video; `play` reads with playback options instead.
      type: "read", title: "Read", category: "output", description: "", params: [],
      inputs: [{ key: "video", label: "Video", type: "text", sequence: true }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({ play: false }), kind: "job",
      async run(i, p) {
        const seen: string[] = [];
        const opts = p.play ? { maxSide: 7 } : undefined;
        for await (const f of (i.video as VideoValue).frames(undefined, opts)) seen.push((f.value as { text: string }).text);
        return { text: { kind: "text", text: seen.join(",") } };
      },
    },
    {
      // A sequence input of another type: the video reaches it through a converter, frame by frame.
      type: "lengths", title: "Lengths", category: "output", description: "", params: [],
      inputs: [{ key: "video", label: "Video", type: "grid", sequence: true }],
      outputs: [{ key: "text", label: "Text", type: "text" }], defaults: () => ({}), kind: "job",
      async run(i) {
        const seen: string[] = [];
        for await (const f of (i.video as VideoValue).frames(undefined, { maxSide: 5, from: 0.8 })) seen.push((f.value as { text: string }).text);
        return { text: { kind: "text", text: seen.join(",") } };
      },
    },
  ];
  return new Map(defs.map((d) => [d.type, d]));
}

const node = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params, position: { x: 0, y: 0 } });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}-${target}-${targetHandle}`, source, sourceHandle, target, targetHandle });
const preview: RunContext = { mode: "preview", assets: new Map() };
const renderCtx: RunContext = { mode: "render", assets: new Map() };

async function texts(v: Value | undefined, opts?: FrameOptions): Promise<string[]> {
  assert.equal(v?.kind, "video");
  const out: string[] = [];
  for await (const f of (v as VideoValue).frames(undefined, opts)) out.push((f.value as { text: string }).text);
  return out;
}

test("playback options reach the source through a frame node", async () => {
  const src = fakeSource();
  const g: Graph = { version: 1, nodes: [node("v", "vid"), node("u", "upper")], edges: [wire("v", "video", "u", "text")] };
  const r = await evaluate(g, { registry: defsFor(src), ctx: preview, cache: new ResultCache() });
  const opts: FrameOptions = { maxSide: 960, from: 0.5 };
  assert.deepEqual(await texts(r.get("u")!.outputs.text, opts), ["F5@960", "F6@960", "F7@960", "F8@960", "F9@960"]);
  assert.equal(src.passes.length, 1);
  assert.equal(src.passes[0], opts, "the same options object, so the outputs of one playback share a pass");
  // Without options: every frame, full size.
  assert.equal((await texts(r.get("u")!.outputs.text)).length, 10);
  assert.equal(src.passes[1], undefined);
});

test("a source skips frames the play clock has passed, and the frame node never sees them", async () => {
  const src = fakeSource();
  const g: Graph = { version: 1, nodes: [node("v", "vid"), node("u", "upper")], edges: [wire("v", "video", "u", "text")] };
  const r = await evaluate(g, { registry: defsFor(src), ctx: preview, cache: new ResultCache() });
  const got = await texts(r.get("u")!.outputs.text, { skipTo: () => 0.35 });
  assert.deepEqual(got, ["F4@FULL", "F5@FULL", "F6@FULL", "F7@FULL", "F8@FULL", "F9@FULL"]);
});

test("two videos zipped by one frame node get the size and start, but not skipping", async () => {
  const a = fakeSource();
  const b = fakeSource();
  const g: Graph = {
    version: 1,
    nodes: [node("a", "vid"), node("b", "vid2"), node("j", "join")],
    edges: [wire("a", "video", "j", "x"), wire("b", "video", "j", "y")],
  };
  const r = await evaluate(g, { registry: defsFor(a, b), ctx: preview, cache: new ResultCache() });
  const got = await texts(r.get("j")!.outputs.text, { maxSide: 400, from: 0.8, skipTo: () => 0.85 });
  // Each would skip on its own clock and pair the wrong frames: so neither skips.
  assert.deepEqual(got, ["f8@400+f8@400", "f9@400+f9@400"]);
  for (const p of [a.passes[0], b.passes[0]]) {
    assert.equal(p?.maxSide, 400);
    assert.equal(p?.from, 0.8);
    assert.equal(p?.skipTo, undefined);
  }
});

test("a reader with playback options reads around a shared pass, and doesn't hold up the others", async () => {
  const src = fakeSource();
  const g: Graph = {
    version: 1,
    nodes: [node("v", "vid"), node("u", "upper"), node("r1", "read"), node("r2", "read", { play: true })],
    edges: [wire("v", "video", "u", "text"), wire("u", "text", "r1", "video"), wire("u", "text", "r2", "video")],
  };
  const timeout = new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("a reader is stuck")), 3000));
  const r = await Promise.race([evaluate(g, { registry: defsFor(src), ctx: renderCtx, cache: new ResultCache() }), timeout]);
  const text = (id: string) => (r.get(id)!.outputs.text as { text: string }).text;
  assert.equal(text("r1"), Array.from({ length: 10 }, (_x, i) => `F${i}@FULL`).join(","));
  assert.equal(text("r2"), Array.from({ length: 10 }, (_x, i) => `F${i}@7`).join(","));
  assert.equal(src.passes.length, 2);
  assert.ok(src.passes.some((p) => p?.maxSide === 7));
  assert.ok(src.passes.some((p) => p === undefined));
});

test("playback options go through a converted video", async () => {
  const src = fakeSource();
  const toGrid: Converter = { from: "text", to: "grid", label: "grid", convert: async (v) => ({ ...(v as { text: string }), text: `[${(v as { text: string }).text}]` }) as Value };
  const g: Graph = { version: 1, nodes: [node("v", "vid"), node("l", "lengths")], edges: [wire("v", "video", "l", "video")] };
  const r = await evaluate(g, { registry: defsFor(src), ctx: renderCtx, cache: new ResultCache(), converters: [toGrid] });
  assert.equal((r.get("l")!.outputs.text as { text: string }).text, "[f8@5],[f9@5]");
  assert.equal(src.passes[0]?.maxSide, 5);
});

test("share: readers asking with the same options share a pass, other options get their own", async () => {
  let starts = 0;
  const seen: unknown[] = [];
  const source = share<number, { n: number }>(async function* (_signal, opts) {
    starts++;
    seen.push(opts);
    for (let i = 0; i < 3; i++) yield i * (opts?.n ?? 1);
  });
  const a = { n: 2 };
  const read = async (o?: { n: number }) => {
    const out: number[] = [];
    for await (const x of source(undefined, o)) out.push(x);
    return out;
  };
  const [x, y] = await Promise.all([read(a), read(a)]);
  assert.deepEqual([x, y], [[0, 2, 4], [0, 2, 4]]);
  assert.equal(starts, 1);
  const [p, q] = await Promise.all([read(a), read({ n: 3 })]);
  assert.deepEqual([p, q], [[0, 2, 4], [0, 3, 6]]);
  assert.equal(starts, 3);
});

test("pacing: wait for early frames, show due ones, skip late ones unless nothing has shown for a while", () => {
  assert.equal(nextAction(1000, 1040), "wait");
  assert.equal(nextAction(1000, 1000), "show");
  assert.equal(nextAction(1000, 1000 - LATE_MS), "show");
  assert.equal(nextAction(1000, 1000 - LATE_MS - 1), "skip");
  assert.equal(nextAction(1000, 500, LATE_MS, STARVE_MS - 1), "skip");
  assert.equal(nextAction(1000, 500, LATE_MS, STARVE_MS), "show");
});

test("pacing: real time while enough frames get shown, slower (in steps) when the graph can't keep up", () => {
  assert.equal(rateFor(60, 30), 1);
  assert.equal(rateFor(12, 30), 1, "12 frames a second of a 30 fps video is choppy but real time");
  assert.equal(rateFor(6, 30), 0.6);
  assert.equal(rateFor(0.2, 30), MIN_RATE);
  // A 1 fps slideshow only needs 1 frame a second.
  assert.equal(rateFor(1.5, 1), 1);
  // No flicker: a little faster or slower doesn't change the speed, a lot does.
  assert.equal(rateFor(7.5, 30, 0.6), 0.6);
  assert.equal(rateFor(8.1, 30, 0.6), 0.8);
  assert.equal(rateFor(10.5, 30, 0.9), 0.9, "only just fast enough: stays slower rather than flicker");
  assert.equal(rateFor(11.2, 30, 0.9), 1);
  assert.equal(rateFor(9.1, 30, 1), 1);
  assert.equal(rateFor(8.9, 30, 1), 0.8);
});

test("play clock: starts at the first frame, slows down honestly, and never jumps", () => {
  const c = new PlayClock(2, 30);
  assert.equal(c.at(0), 2);
  assert.equal(c.skipTo(0), -Infinity, "nothing is skipped before the first frame");
  c.start(1000, 2);
  assert.equal(c.at(1500), 2.5);
  assert.ok(Math.abs(c.until(1500, 2.6) - 100) < 1e-6);
  // Frames take 200 ms to make (5 a second): 0.5x, and the clock carries on from where it was.
  c.shown(2000, 200);
  assert.equal(c.rate, 0.5);
  // One slow frame doesn't change the speed.
  const d = new PlayClock(0, 30);
  d.start(0, 0);
  for (let i = 1; i <= 20; i++) d.shown(i * 50, 50);
  d.shown(1100, 300);
  assert.equal(d.rate, 1);
  assert.equal(c.at(2000), 3);
  assert.equal(c.at(3000), 3.5);
  // Skips what would be late by the time a frame is made (200 ms at half speed is 0.1 s of video).
  assert.ok(Math.abs(c.skipTo(3000) - (3.5 + 0.1 - LATE_MS / 1000)) < 1e-9);
  // Looping carries the speed on.
  assert.equal(new PlayClock(0, 30, c).rate, 0.5);
});

test("backpressure: never more than two frames wait for the window", async () => {
  const acks = new AckWindow();
  assert.equal(acks.max, MAX_UNACKED);
  assert.equal(MAX_UNACKED, 2);
  const onScreen: number[] = [];
  let most = 0;
  // A window that draws a frame every 3 ms.
  const drawn: number[] = [];
  const window = setInterval(() => {
    const f = onScreen.shift();
    if (f === undefined) return;
    drawn.push(f);
    acks.acked();
  }, 3);
  try {
    for (let i = 0; i < 20; i++) {
      await acks.ready();
      onScreen.push(i);
      acks.sent();
      most = Math.max(most, acks.inFlight, onScreen.length);
    }
    while (drawn.length < 20) await new Promise((r) => setTimeout(r, 3));
  } finally {
    clearInterval(window);
  }
  assert.equal(most, 2);
  assert.deepEqual(drawn, Array.from({ length: 20 }, (_x, i) => i));
});

test("backpressure: stopping releases a worker waiting for the window", async () => {
  const acks = new AckWindow();
  acks.sent();
  acks.sent();
  const stop = new AbortController();
  const waiting = acks.ready(stop.signal);
  stop.abort();
  await assert.rejects(waiting, /Stopped/);
});

test("sound drift and the time display", () => {
  assert.equal(needsResync(10.05, 10), false);
  assert.equal(needsResync(10.2, 10), true);
  assert.equal(needsResync(9.8, 10), true);
  // Behind: a little faster; ahead: a little slower; in step: real time.
  assert.ok(Math.abs(soundRate(9.95, 10) - 1.05) < 1e-9);
  assert.ok(Math.abs(soundRate(10.05, 10) - 0.95) < 1e-9);
  assert.equal(soundRate(9.5, 10), 1.1);
  assert.equal(soundRate(10.02, 10), 1);
  assert.equal(clockText(3.9), "0:03");
  assert.equal(clockText(63.4), "1:03");
  assert.equal(clockText(3723), "1:02:03");
});
