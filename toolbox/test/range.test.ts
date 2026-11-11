import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { parseRange, serveRange } from "../electron/range.js";

test("reads a byte range", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange(" Bytes = 5 - 9 ", 1000), { start: 5, end: 9 });
});

test("a range past the end is cut to the file", () => {
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("no range, several ranges or nonsense mean the whole file", () => {
  for (const h of [undefined, null, "", "bytes=", "bytes=-", "items=0-1", "bytes=0-1,5-9", "bytes=9-5", "bytes=a-b"]) assert.equal(parseRange(h, 1000), null, String(h));
});

test("a range that starts past the end can't be met", () => {
  assert.equal(parseRange("bytes=1000-", 1000), false);
  assert.equal(parseRange("bytes=1000-2000", 1000), false);
  assert.equal(parseRange("bytes=-0", 1000), false);
  assert.equal(parseRange("bytes=0-", 0), false);
});

const file = () => {
  const p = path.join(mkdtempSync(path.join(os.tmpdir(), "toolbox-range-")), "clip.mp4");
  writeFileSync(p, Buffer.from("0123456789"));
  return p;
};

test("answers 206 with just the asked-for bytes", async () => {
  const res: Response = await serveRange(file(), "bytes=2-5");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(res.headers.get("content-length"), "4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(await res.text(), "2345");
});

test("answers 200 with everything when no range is asked for, and 416 past the end", async () => {
  const p = file();
  const all: Response = await serveRange(p, null);
  assert.equal(all.status, 200);
  assert.equal(await all.text(), "0123456789");
  const none: Response = await serveRange(p, "bytes=50-");
  assert.equal(none.status, 416);
  assert.equal(none.headers.get("content-range"), "bytes */10");
});
