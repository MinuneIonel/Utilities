import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { foldersInGraph, isInside, KIND_EXTS, listFolder, matchesPattern, naturalCompare, runFileName, wanted } from "../electron/folder-list.js";
// @ts-expect-error plain JS module from the main process
import { consentText } from "../electron/local-files.js";
// @ts-expect-error plain JS module from the main process
import { subFolder } from "../electron/save-policy.js";
import { doneKey, folderName, folderSummary, listingDigest, newOnly, nothingToDo, splitSub, type FolderEntry } from "../src/folder-input.ts";

const abs = (...p: string[]) => path.resolve("/", ...p);

test("patterns: * is any run of characters, ? one, case doesn't matter, empty matches all", () => {
  assert.ok(matchesPattern("IMG_*", "img_0001.jpg"));
  assert.ok(!matchesPattern("IMG_*", "DSC_0001.jpg"));
  assert.ok(matchesPattern("photo-??.png", "photo-12.png"));
  assert.ok(!matchesPattern("photo-??.png", "photo-123.png"));
  assert.ok(matchesPattern("a+b (1).*", "a+b (1).jpg"), "regex characters are plain");
  assert.ok(matchesPattern("", "anything"));
  assert.ok(matchesPattern("  ", "anything"));
});

test("filters: hidden files and other kinds are left out", () => {
  assert.ok(wanted("a.JPG", KIND_EXTS.images, ""));
  assert.ok(wanted("b.heic", KIND_EXTS.images, ""));
  assert.ok(!wanted(".hidden.jpg", KIND_EXTS.images, ""));
  assert.ok(!wanted("notes.txt", KIND_EXTS.images, ""));
  assert.ok(!wanted("IMG_1.png", KIND_EXTS.images, "DSC*"));
});

test("names sort as a person would", () => {
  assert.deepEqual(["IMG_10.jpg", "IMG_2.jpg", "img_1.jpg"].sort(naturalCompare), ["img_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
});

test("lists a folder: sorted, filtered, sub-folders only when asked, no links, capped", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "toolbox-folder-test-"));
  try {
    for (const n of ["b10.jpg", "b2.png", "a.txt", ".dot.jpg"]) writeFileSync(path.join(dir, n), "x");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "c.jpg"), "xyz");
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".git", "d.jpg"), "x");
    const outside = mkdtempSync(path.join(os.tmpdir(), "toolbox-folder-out-"));
    writeFileSync(path.join(outside, "e.jpg"), "x");
    try {
      symlinkSync(path.join(outside, "e.jpg"), path.join(dir, "link.jpg"));
      symlinkSync(outside, path.join(dir, "linkdir"), "dir");
    } catch {
      /* no links on this system */
    }
    const flat = await listFolder(dir, { exts: KIND_EXTS.images });
    assert.deepEqual(flat.entries.map((e: FolderEntry) => e.name), ["b2.png", "b10.jpg"]);
    assert.equal(flat.more, false);
    assert.equal(flat.entries[0].path, path.join(dir, "b2.png"));
    assert.equal(flat.entries[0].size, 1);
    assert.ok(flat.entries[0].mtimeMs > 0);
    const deep = await listFolder(dir, { exts: KIND_EXTS.images, recursive: true });
    assert.deepEqual(deep.entries.map((e: FolderEntry) => e.name), ["b2.png", "b10.jpg", "sub/c.jpg"]);
    const some = await listFolder(dir, { exts: KIND_EXTS.images, pattern: "b1*" });
    assert.deepEqual(some.entries.map((e: FolderEntry) => e.name), ["b10.jpg"]);
    const capped = await listFolder(dir, { exts: KIND_EXTS.images, recursive: true, cap: 2 });
    assert.equal(capped.entries.length, 2);
    assert.equal(capped.more, true);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inside a folder means below it, never the folder itself or beside it", () => {
  assert.ok(isInside(abs("pics"), abs("pics", "a.jpg")));
  assert.ok(isInside(abs("pics"), abs("pics", "sub", "a.jpg")));
  assert.ok(!isInside(abs("pics"), abs("pics")));
  assert.ok(!isInside(abs("pics"), abs("pics2", "a.jpg")));
  assert.ok(!isInside(abs("pics"), abs("pics", "..", "secret.txt")));
});

test("a graph's folders: only Folder of files nodes, absolute paths, once each", () => {
  const g = {
    nodes: [
      { type: "input.folder", params: { folder: abs("pics") } },
      { type: "input.folder", params: { folder: abs("pics") } },
      { type: "input.folder", params: { folder: "relative" } },
      { type: "output.save-file", params: { folder: abs("out") } },
      { type: "input.folder" },
    ],
  };
  assert.deepEqual(foldersInGraph(JSON.stringify(g)), [abs("pics")]);
  assert.deepEqual(foldersInGraph("{nope"), []);
});

test("the question names folders too", () => {
  assert.match(consentText([abs("a.png")]).message, /uses a file on this computer/);
  assert.match(consentText([], 8, [abs("pics")]).message, /uses a folder on this computer/);
  assert.match(consentText([abs("a.png"), abs("b.png")], 8, [abs("pics")]).message, /uses 2 files and a folder on this computer/);
  assert.match(consentText([], 8, [abs("pics")]).detail, /pics/);
});

test("a Save sub-folder stays inside the Save folder", () => {
  const out = abs("out");
  assert.equal(subFolder(out, ""), out);
  assert.equal(subFolder(out, undefined), out);
  assert.equal(subFolder(out, "2024/beach"), path.join(out, "2024", "beach"));
  for (const bad of ["..", "../evil", "a/../../evil", "./a", abs("etc"), "C:\\evil"]) assert.throws(() => subFolder(out, bad), /stay inside/, bad);
});

test("each node's record has its own file", () => {
  assert.notEqual(runFileName("a#n1"), runFileName("a#n2"));
  assert.match(runFileName("/x/y.toolbox#n1"), /^[0-9a-f]{24}\.json$/);
});

const entry = (name: string, mtimeMs = 1, size = 10): FolderEntry => ({ path: abs("pics", name), name, size, mtimeMs });

test("only new files: never done, or changed since", () => {
  const list = [entry("a.jpg", 5), entry("b.jpg", 6), entry("c.jpg", 7)];
  assert.deepEqual(newOnly(list, undefined), list);
  assert.deepEqual(newOnly(list, { [abs("pics", "a.jpg")]: 5, [abs("pics", "b.jpg")]: 1 }).map((e) => e.name), ["b.jpg", "c.jpg"]);
});

test("the digest changes when a file is added, removed or changed", () => {
  const list = [entry("a.jpg"), entry("b.jpg")];
  const d = listingDigest(list);
  assert.equal(listingDigest([entry("a.jpg"), entry("b.jpg")]), d);
  assert.notEqual(listingDigest([...list, entry("c.jpg")]), d);
  assert.notEqual(listingDigest([list[0]]), d);
  assert.notEqual(listingDigest([list[0], entry("b.jpg", 2)]), d);
  assert.notEqual(listingDigest([list[0], entry("b.jpg", 1, 11)]), d);
});

test("what the card says", () => {
  assert.equal(folderName(abs("Users", "me", "Holiday") + path.sep), "Holiday");
  assert.equal(folderSummary(abs("Holiday"), 128, 128, false), "128 images in Holiday");
  assert.equal(folderSummary(abs("Holiday"), 1, 1, false), "1 image in Holiday");
  assert.equal(folderSummary(abs("Holiday"), 140, 12, true), "12 new of 140 in Holiday");
  assert.match(nothingToDo(abs("Holiday"), 140, true, ""), /Nothing new in Holiday/);
  assert.match(nothingToDo(abs("Holiday"), 0, false, "IMG_*"), /match IMG_\*/);
  assert.match(nothingToDo(abs("Holiday"), 0, true, ""), /No images in Holiday yet/);
  // Videos, sounds and PDFs.
  assert.equal(folderSummary(abs("Clips"), 3, 3, false, false, "videos"), "3 videos in Clips");
  assert.equal(folderSummary(abs("Docs"), 1, 1, false, false, "pdfs"), "1 PDF in Docs");
  assert.match(nothingToDo(abs("Docs"), 0, false, "", "pdfs"), /No PDFs in Docs yet/);
  assert.match(nothingToDo(abs("Podcasts"), 4, true, "", "sounds"), /4 sounds done before/);
});

test("each kind of folder lists its own files", () => {
  assert.ok(wanted("clip.MOV", KIND_EXTS.videos, ""));
  assert.ok(!wanted("clip.mov", KIND_EXTS.sounds, ""));
  assert.ok(wanted("song.flac", KIND_EXTS.sounds, ""));
  assert.ok(wanted("invoice.pdf", KIND_EXTS.pdfs, ""));
  assert.ok(!wanted("photo.jpg", KIND_EXTS.pdfs, ""));
});

test("a batch file's sub-folder travels apart from its name", () => {
  assert.deepEqual(splitSub("a.jpg"), { sub: "", base: "a.jpg" });
  assert.deepEqual(splitSub("2024/beach/a.jpg"), { sub: "2024/beach", base: "a.jpg" });
  assert.equal(doneKey("/x/y.toolbox", "n1"), "/x/y.toolbox#n1");
});
