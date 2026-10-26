import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain JS module from the main process
import { newer, newestRelease, pickAsset } from "../electron/releases.js";

const asset = (name: string, digest?: string) => ({ name, size: 10, digest, browser_download_url: `https://example.com/${name}` });
const release = (tag: string, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/r/${tag}`,
  draft: false,
  prerelease: false,
  assets: [
    asset("Toolbox-0.3.0-mac-arm64.dmg", "sha256:" + "AB".repeat(32)),
    asset("Toolbox-0.3.0-win-x64.exe"),
    asset("Toolbox-0.3.0-linux-x86_64.AppImage"),
  ],
  ...extra,
});

test("versions compare by number, not as text", () => {
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.2.0", "0.2.0"), false);
  assert.equal(newer("0.2", "0.2.1"), false);
  assert.equal(newer("1.0.0", "0.99.0"), true);
});

test("each system gets its own installer", () => {
  const r = release("toolbox-v0.3.0");
  assert.equal(pickAsset(r, "darwin", "arm64")?.name, "Toolbox-0.3.0-mac-arm64.dmg");
  assert.equal(pickAsset(r, "darwin", "arm64")?.sha256, "ab".repeat(32));
  assert.equal(pickAsset(r, "win32", "x64")?.name, "Toolbox-0.3.0-win-x64.exe");
  assert.equal(pickAsset(r, "win32", "x64")?.sha256, null);
  assert.equal(pickAsset(r, "linux", "x64")?.name, "Toolbox-0.3.0-linux-x86_64.AppImage");
  assert.equal(pickAsset(r, "darwin", "x64"), null); // no Intel Mac build
});

test("the newest published Toolbox release, skipping drafts, prereleases and other apps", () => {
  const list = [
    release("toolbox-v0.4.0", { draft: true }),
    release("toolbox-v0.3.5", { prerelease: true }),
    release("other-v9.0.0"),
    release("toolbox-v0.3.0"),
    release("toolbox-v0.2.0"),
  ];
  const r = newestRelease(list, "0.2.0", "linux", "x64");
  assert.equal(r?.version, "0.3.0");
  assert.equal(r?.asset?.name, "Toolbox-0.3.0-linux-x86_64.AppImage");
  assert.equal(newestRelease(list, "0.3.0", "linux", "x64"), null);
});
