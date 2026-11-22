import assert from "node:assert/strict";
import { test } from "node:test";
import { explainYtdlp, isBotCheck, pauseBefore, signInArgs } from "../src/nodes/ytdlp-help.ts";

const BOT =
  "ERROR: [youtube] hU-h_sOJ4Lg: Sign in to confirm you’re not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.";

test("sign-in arguments only for browsers on the list", () => {
  assert.deepEqual(signInArgs(""), []);
  assert.deepEqual(signInArgs(undefined), []);
  assert.deepEqual(signInArgs("chrome"), ["--cookies-from-browser", "chrome"]);
  assert.deepEqual(signInArgs("chrome; rm -rf"), []);
  assert.deepEqual(signInArgs("--exec"), []);
});

test("spots YouTube's bot check, curly apostrophe or not", () => {
  assert.ok(isBotCheck(BOT));
  assert.ok(isBotCheck("Sign in to confirm you're not a bot"));
  assert.ok(!isBotCheck("ERROR: HTTP Error 403: Forbidden"));
});

test("bot check without a browser points to the setting", () => {
  const m = explainYtdlp(BOT, "")!;
  assert.match(m, /Use sign-in from/);
  assert.doesNotMatch(m, /--cookies/);
});

test("bot check with a browser asks to sign in there", () => {
  assert.match(explainYtdlp(BOT, "firefox")!, /Open YouTube in Firefox/);
});

test("Safari needs Full Disk Access", () => {
  const log = "ERROR: [Errno 1] Operation not permitted: '/Users/x/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'";
  assert.match(explainYtdlp(log, "safari")!, /Full Disk Access/);
});

test("a browser that isn't there", () => {
  assert.match(explainYtdlp("ERROR: could not find brave cookies database in \"/x\"", "brave")!, /couldn't find Brave/);
});

test("Chrome on Windows locks its cookies", () => {
  assert.match(explainYtdlp("ERROR: Failed to decrypt with DPAPI", "chrome")!, /Firefox/);
  assert.match(explainYtdlp("ERROR: Could not copy Chrome cookie database", "chrome")!, /Quit Chrome/);
});

test("other errors keep yt-dlp's own words", () => {
  assert.equal(explainYtdlp("ERROR: Unsupported URL: https://example.com", ""), undefined);
  assert.equal(explainYtdlp("ERROR: Video unavailable", "chrome"), undefined);
});

test("playlist videos are a few seconds apart, the first right away", () => {
  assert.equal(pauseBefore(0), 0);
  assert.equal(pauseBefore(1, () => 0), 3000);
  assert.equal(pauseBefore(5, () => 1), 7000);
});
