import assert from "node:assert/strict";
import { test } from "node:test";
import { entryFileName, hasOneVideo, isPlaylistLink, parsePlaylist, pickEntries, playlistFolder } from "../src/nodes/playlist.ts";

test("playlist links are told apart from single videos", () => {
  assert.equal(isPlaylistLink("https://www.youtube.com/playlist?list=PLabc"), true);
  assert.equal(isPlaylistLink("https://www.youtube.com/watch?v=abc&list=PLabc&index=3"), true);
  assert.equal(isPlaylistLink("https://music.youtube.com/playlist?list=OLAK5uy_x"), true);
  assert.equal(isPlaylistLink("https://youtu.be/abc?list=PLabc"), true);
  assert.equal(isPlaylistLink("https://www.youtube.com/watch?v=abc"), false);
  // A Mix is endless: a video in one is just that video.
  assert.equal(isPlaylistLink("https://www.youtube.com/watch?v=abc&list=RDabc"), false);
  assert.equal(isPlaylistLink("https://soundcloud.com/artist/sets/summer"), true);
  assert.equal(isPlaylistLink("https://soundcloud.com/artist/track"), false);
  assert.equal(isPlaylistLink("https://band.bandcamp.com/album/first"), true);
  assert.equal(isPlaylistLink("https://vimeo.com/showcase/123"), true);
  assert.equal(isPlaylistLink("https://vimeo.com/123"), false);
  assert.equal(isPlaylistLink("not a link"), false);
});

test("a playlist link that also names a video can mean just that video", () => {
  assert.equal(hasOneVideo("https://www.youtube.com/watch?v=abc&list=PLabc"), true);
  assert.equal(hasOneVideo("https://youtu.be/abc?list=PLabc"), true);
  assert.equal(hasOneVideo("https://www.youtube.com/playlist?list=PLabc"), false);
});

test("yt-dlp's list is read, skipping videos nobody can watch", () => {
  const text = [
    "1\taaa\thttps://www.youtube.com/watch?v=aaa\tMy list\tFirst song",
    "2\tbbb\thttps://www.youtube.com/watch?v=bbb\tMy list\t[Private video]",
    "3\tccc\thttps://www.youtube.com/watch?v=ccc\tMy list\tThird\tsong",
    "4\tNA\tNA\tMy list\t[Deleted video]",
    "",
  ].join("\n");
  const list = parsePlaylist(text);
  assert.equal(list.title, "My list");
  assert.equal(list.unavailable, 2);
  assert.deepEqual(
    list.entries.map((e) => [e.index, e.id, e.title]),
    [
      [1, "aaa", "First song"],
      [3, "ccc", "Third song"],
    ],
  );
});

test("Which videos picks places in the playlist", () => {
  const entries = [1, 2, 3, 4, 5, 6].map((index) => ({ index, id: String(index), url: `https://x/${index}`, title: "" }));
  const idx = (s: string) => pickEntries(entries, s).map((e) => e.index);
  assert.deepEqual(idx(""), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(idx("All"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(idx("1-2, 5"), [1, 2, 5]);
  assert.deepEqual(idx("4-"), [4, 5, 6]);
  assert.deepEqual(idx("-2"), [1, 2]);
  assert.deepEqual(idx("5-99"), [5, 6]);
  assert.throws(() => idx("9"), /none of them/);
  assert.throws(() => idx("5-2"), /backwards/);
  assert.throws(() => idx("abc"), /isn't a video number/);
});

test("downloads go in a folder named after the playlist, numbered in order", () => {
  assert.equal(playlistFolder('Best of: 2024 / "live"'), "Best of- 2024 - -live-");
  assert.equal(playlistFolder("..."), "Playlist");
  assert.equal(entryFileName("Mix", 3, 12, "Song [abc].mp4"), "Mix/03 Song [abc].mp4");
  assert.equal(entryFileName("Mix", 7, 150, "Song [abc].mp4"), "Mix/007 Song [abc].mp4");
});
