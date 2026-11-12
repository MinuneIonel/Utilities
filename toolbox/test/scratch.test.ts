import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { createScratch } from "../electron/scratch.js";

const root = () => mkdtempSync(path.join(os.tmpdir(), "toolbox-scratch-test-"));

test("only files directly in the folder count as scratch files", () => {
  const s = createScratch(root(), { pid: 1 });
  assert.equal(s.inside(path.join(s.dir, "1-out.mp4")), true);
  assert.equal(s.inside(s.dir), false);
  assert.equal(s.inside(path.join(s.dir, "sub", "x")), false);
  assert.equal(s.inside(path.join(s.dir, "..", "elsewhere.mp4")), false);
  assert.equal(s.inside(`${s.dir}-evil/x`), false, "a folder whose name merely starts the same");
  assert.equal(s.inside("1-out.mp4"), false);
  assert.equal(s.inside(42), false);
});

test("chunks written out of order land at their positions", async () => {
  const s = createScratch(root(), { pid: 2 });
  const p = await s.open("a", "out/../video.mp4");
  assert.equal(path.dirname(p), s.dir, "a name can't leave the folder");
  await s.write("a", new TextEncoder().encode("world"), 6);
  await s.write("a", new TextEncoder().encode("hello "), 0);
  const done = await s.close("a");
  assert.deepEqual(done, { path: p, size: 11 });
  assert.equal(readFileSync(p, "utf8"), "hello world");
  await assert.rejects(s.write("a", new Uint8Array(1), 0), /isn't open/);
});

test("adopts a tool's output, and removes only scratch files", async () => {
  const r = root();
  const s = createScratch(r, { pid: 3 });
  const job = path.join(r, "job-out.mov");
  writeFileSync(job, "abc");
  const kept = await s.adopt(job, "out.mov");
  assert.equal(kept.size, 3);
  assert.equal(existsSync(job), false, "moved, not copied");
  const outside = path.join(r, "keep-me.txt");
  writeFileSync(outside, "mine");
  await s.remove([kept.path, outside, path.join(s.dir, "..", "keep-me.txt")]);
  assert.equal(existsSync(kept.path), false);
  assert.equal(existsSync(outside), true);
});

test("clears its folder on quit, and old folders from other runs at start", () => {
  const r = root();
  const stale = path.join(r, "toolbox-scratch-111");
  const fresh = path.join(r, "toolbox-scratch-222");
  const other = path.join(r, "something-else");
  for (const d of [stale, fresh, other]) mkdirSync(d);
  const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
  utimesSync(stale, old, old);
  utimesSync(other, old, old);
  const s = createScratch(r, { pid: 333 });
  assert.equal(existsSync(stale), false, "a day-old folder from a crashed run goes");
  assert.equal(existsSync(fresh), true, "another Toolbox running now keeps its folder");
  assert.equal(existsSync(other), true);
  writeFileSync(path.join(s.dir, "1-x"), "x");
  s.clear();
  assert.equal(existsSync(s.dir), false);
});
