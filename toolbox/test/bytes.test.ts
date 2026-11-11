import assert from "node:assert/strict";
import { test } from "node:test";
import { asBytes, diskPaths, fromBytes, fromDisk, READ_LIMIT, ScratchRefs, scratchUrl, sizeOf } from "../src/nodes/bytes.ts";
import { ResultCache } from "../src/runtime/evaluate.ts";
import type { FileValue, Value } from "../src/runtime/types.ts";

const file = (name: string, data: FileValue["data"]): FileValue => ({ kind: "file", name, mime: "video/mp4", data });

test("sizes files in memory and on disk alike", () => {
  assert.equal(sizeOf(fromBytes(new Uint8Array(5))), 5);
  assert.equal(sizeOf(fromDisk("/tmp/toolbox-scratch-1/1-out.mp4", 3_000_000_000)), 3_000_000_000);
});

test("bytes in memory come back as they are", async () => {
  const b = new Uint8Array([1, 2, 3]);
  assert.equal(await asBytes(fromBytes(b)), b);
});

test("a disk file too big for memory is refused, not read", async () => {
  await assert.rejects(asBytes(fromDisk("/tmp/toolbox-scratch-1/1-big.mov", READ_LIMIT + 1)), /too big/);
});

test("scratch files are served by name, whatever the folder", () => {
  assert.equal(scratchUrl("/tmp/toolbox-scratch-9/3-my video.mp4"), "app://toolbox/@scratch/3-my%20video.mp4");
  assert.equal(scratchUrl("C:\\Temp\\toolbox-scratch-9\\4-a.mov"), "app://toolbox/@scratch/4-a.mov");
});

test("finds every disk file a value holds, batches included", () => {
  const a = file("a.mp4", fromDisk("/s/1-a.mp4", 10));
  const b = file("b.mp4", fromDisk("/s/2-b.mp4", 10));
  const m = file("m.png", fromBytes(new Uint8Array(1)));
  assert.deepEqual([...diskPaths({ ...a, batch: [a, b, m] })], ["/s/1-a.mp4", "/s/2-b.mp4"]);
  assert.deepEqual([...diskPaths(m)], []);
  assert.deepEqual([...diskPaths({ kind: "text", text: "/s/1-a.mp4" })], []);
});

test("a scratch file is freed once its last holder lets go", () => {
  const freed: string[][] = [];
  const refs = new ScratchRefs((p) => freed.push(p));
  refs.retain(["/s/a", "/s/b"]);
  refs.retain(["/s/a"]);
  refs.release(["/s/a", "/s/b"]);
  assert.deepEqual(freed, [["/s/b"]]);
  refs.release(["/s/a"]);
  assert.deepEqual(freed, [["/s/b"], ["/s/a"]]);
  refs.release(["/s/a"]);
  assert.equal(freed.length, 2, "letting go twice frees nothing more");
});

test("the cache frees a job's file when a newer render replaces it, but not while a Save node's result still holds it", () => {
  const freed: string[] = [];
  const cache = new ResultCache();
  cache.onFree = (p) => freed.push(...p);
  const one = { file: file("out.mp4", fromDisk("/s/1-out.mp4", 100)) };
  cache.set("encode-1", one);
  cache.lastRender.set("encode", { key: "encode-1", outputs: one });
  // The Save node passes the same file on under another name.
  const saved = { file: { ...one.file, name: "renamed.mp4" } };
  cache.set("save-1", saved);
  cache.lastRender.set("save", { key: "save-1", outputs: saved });

  const two = { file: file("out.mp4", fromDisk("/s/2-out.mp4", 100)) };
  cache.lastRender.set("encode", { key: "encode-2", outputs: two });
  assert.deepEqual(freed, [], "still cached, and the Save node still holds it");
  assert.equal(cache.refs.count("/s/1-out.mp4"), 3);
  cache.lastRender.set("save", { key: "save-2", outputs: { file: { ...two.file } } });
  cache.lastRender.delete("encode");
  assert.equal(cache.refs.count("/s/1-out.mp4"), 2, "the cached results still hold it");
  assert.equal(cache.refs.count("/s/2-out.mp4"), 1);
});

test("disk files take no room in the cache, and an evicted result frees its file", () => {
  const freed: string[] = [];
  const cache = new ResultCache(10);
  cache.onFree = (p) => freed.push(...p);
  const big: Record<string, Value> = { file: file("big.mov", fromDisk("/s/1-big.mov", 5_000_000_000)) };
  cache.set("a", big);
  cache.set("b", { t: { kind: "text", text: "abc" } }); // 6 bytes
  assert.equal(cache.size, 2, "a 5 GB file on disk doesn't push anything out");
  assert.deepEqual(freed, []);
  cache.set("c", { t: { kind: "text", text: "defgh" } }); // 10 more: the oldest go
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(freed, ["/s/1-big.mov"]);
});
