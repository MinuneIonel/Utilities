import assert from "node:assert/strict";
import { test } from "node:test";
import { audioFormatOf, clipNames, clipRanges, formatMarks, formatParts, formatTime, parseMarks, parseParts, parseTime } from "../src/nodes/clips.ts";

test("reads seconds and minutes:seconds", () => {
  assert.equal(parseTime("75"), 75);
  assert.equal(parseTime("1:15"), 75);
  assert.equal(parseTime("1:15.5"), 75.5);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.ok(Number.isNaN(parseTime("abc")));
  assert.ok(Number.isNaN(parseTime("1:2:3:4")));
});

test("every n seconds, with a shorter last clip", () => {
  assert.deepEqual(clipRanges(70, "every", { every: 30 }), [
    { start: 0, end: 30 },
    { start: 30, end: 60 },
    { start: 60, end: 70 },
  ]);
  // A sliver at the end joins the last clip instead of being its own.
  assert.deepEqual(clipRanges(60.02, "every", { every: 30 }), [
    { start: 0, end: 30 },
    { start: 30, end: 60.02 },
  ]);
});

test("equal parts", () => {
  assert.deepEqual(clipRanges(9, "count", { count: 3 }), [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ]);
});

test("cuts at listed times, in any order, ignoring ones outside", () => {
  assert.deepEqual(clipRanges(100, "at", { at: "1:00, 0:30; 200, 0" }), [
    { start: 0, end: 30 },
    { start: 30, end: 60 },
    { start: 60, end: 100 },
  ]);
  assert.deepEqual(clipRanges(10, "at", { at: "" }), [{ start: 0, end: 10 }]);
});

test("keeps listed parts, up to the end", () => {
  assert.deepEqual(clipRanges(120, "parts", { parts: "0:10-0:25, 1:00 - 1:30\n1:50-end, 1:55-" }), [
    { start: 10, end: 25 },
    { start: 60, end: 90 },
    { start: 110, end: 120 },
    { start: 115, end: 120 },
  ]);
  assert.deepEqual(clipRanges(20, "parts", { parts: "5-90" }), [{ start: 5, end: 20 }]);
});

test("explains bad settings", () => {
  assert.throws(() => clipRanges(0, "every", { every: 10 }), /length isn't known/);
  assert.throws(() => clipRanges(10, "every", { every: 0 }), /how long/);
  assert.throws(() => clipRanges(10_000, "every", { every: 1 }), /more than 500/);
  assert.throws(() => clipRanges(10, "parts", { parts: "" }), /List the parts/);
  assert.throws(() => clipRanges(10, "parts", { parts: "5-3" }), /ends before/);
  assert.throws(() => clipRanges(10, "parts", { parts: "12-15" }), /starts after/);
  assert.throws(() => clipRanges(10, "at", { at: "soon" }), /isn't a time/);
});

test("names sort in order", () => {
  assert.deepEqual(clipNames("talk", 3, "mp4"), ["talk-1.mp4", "talk-2.mp4", "talk-3.mp4"]);
  assert.equal(clipNames("talk", 12, "mp3")[0], "talk-01.mp3");
});

test("keeps a sound's own format", () => {
  assert.equal(audioFormatOf("song.flac"), "flac");
  assert.equal(audioFormatOf("voice.WAV"), "wav");
  assert.equal(audioFormatOf("clip.webm"), "opus");
  assert.equal(audioFormatOf("podcast.aac"), "m4a");
  assert.equal(audioFormatOf("noext"), "m4a");
});

test("writes times as m:ss.d, which read back", () => {
  assert.equal(formatTime(0), "0:00.0");
  assert.equal(formatTime(65.5), "1:05.5");
  assert.equal(formatTime(5), "0:05.0");
  assert.equal(formatTime(3723.25), "1:02:03.25");
  assert.equal(formatTime(1 / 30), "0:00.03");
  assert.equal(formatTime(-3), "0:00.0");
  for (const t of [0, 0.1, 1.5, 59.9, 60, 65.5, 599.95, 3599.9, 3600, 7322.4, 36000]) assert.equal(parseTime(formatTime(t)), t, formatTime(t));
  assert.equal(parseTime("1:05.5"), 65.5);
});

test("cut times round-trip through Cut at text", () => {
  const text = formatMarks([75, 30, 30, 2.5]);
  assert.equal(text, "0:02.5, 0:30.0, 1:15.0");
  assert.deepEqual(parseMarks(text), [2.5, 30, 75]);
  assert.deepEqual(parseMarks("2, nonsense, 0:04.5"), [2, 4.5]);
  assert.equal(formatMarks([]), "");
  // What the timeline writes, Split cuts at.
  assert.deepEqual(clipRanges(6, "at", { at: formatMarks([2, 4.5]) }).map((r) => r.end), [2, 4.5, 6]);
});

test("parts round-trip through Parts text", () => {
  const parts = [
    { start: 10, end: 25 },
    { start: 60, end: 90.5 },
  ];
  const text = formatParts(parts);
  assert.equal(text, "0:10.0-0:25.0, 1:00.0-1:30.5");
  assert.deepEqual(parseParts(text, 100), parts);
  assert.deepEqual(clipRanges(100, "parts", { parts: text }), parts);
  assert.deepEqual(parseParts("0:10-end, junk, 5 to 6", 40), [
    { start: 10, end: 40 },
    { start: 5, end: 6 },
  ]);
});
