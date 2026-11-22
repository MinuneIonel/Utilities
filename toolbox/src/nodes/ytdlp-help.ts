// What the Download node tells yt-dlp about signing in, and how it explains
// yt-dlp's sign-in and bot-check errors in words a person can act on. Pure, so it is tested on its own.

/** Browsers yt-dlp can borrow a sign-in from (--cookies-from-browser). "" is none. */
export const SIGN_IN_BROWSERS = [
  { value: "", label: "No browser" },
  { value: "chrome", label: "Chrome" },
  { value: "safari", label: "Safari" },
  { value: "firefox", label: "Firefox" },
  { value: "edge", label: "Edge" },
  { value: "brave", label: "Brave" },
] as const;

const browserName = (b: string) => SIGN_IN_BROWSERS.find((o) => o.value === b)?.label ?? b;

/** The yt-dlp arguments for a sign-in choice; anything not on the list counts as none. */
export function signInArgs(browser: unknown): string[] {
  const b = String(browser ?? "");
  return b && SIGN_IN_BROWSERS.some((o) => o.value === b) ? ["--cookies-from-browser", b] : [];
}

/** YouTube's "Sign in to confirm you're not a bot": it has stopped answering this computer until it signs in. */
export function isBotCheck(message: string): boolean {
  return /confirm (that )?you.?re not a bot|sign in to confirm/i.test(message);
}

/**
 * A plain-words version of yt-dlp's last error, for the errors that need the person to do
 * something (sign in, give Toolbox a permission). Undefined for every other error.
 */
export function explainYtdlp(message: string, browser: unknown): string | undefined {
  const b = String(browser ?? "");
  const name = browserName(b);
  if (isBotCheck(message)) {
    if (!b)
      return "YouTube wants to check this isn't a bot (this happens after many downloads in a row). Pick the browser you watch YouTube in under \"Use sign-in from\" and try again, or wait an hour or so.";
    return `YouTube still wants to check this isn't a bot, even with ${name}'s sign-in. Open YouTube in ${name}, make sure you're signed in and play any video, then try again.`;
  }
  if (!b) return undefined;
  if (b === "safari" && /operation not permitted|permission ?error|permission denied/i.test(message))
    return "macOS keeps Safari's sign-ins private. Allow Toolbox under System Settings > Privacy & Security > Full Disk Access, then try again, or pick another browser under \"Use sign-in from\".";
  if (/could not find .*(cookies|profile)|no such file.*cookies|unsupported browser/i.test(message))
    return `Toolbox couldn't find ${name}'s sign-ins. Is ${name} installed, with YouTube signed in? Or pick another browser under "Use sign-in from".`;
  if (/could not copy .*cookie database|database is locked/i.test(message)) return `${name} is holding on to its sign-ins. Quit ${name}, then try again.`;
  if (/dpapi|app.?bound|failed to decrypt|cannot decrypt|keyring|keychain/i.test(message))
    return `Toolbox couldn't unlock ${name}'s sign-ins. On a Mac, click Allow when asked about "${name} Safe Storage". On Windows, Chrome, Edge and Brave lock them away: use Firefox there.`;
  return undefined;
}

/**
 * How long to wait before the next video of a playlist. YouTube asks to confirm you're not
 * a bot after many quick downloads in a row; a few seconds between videos, a little uneven
 * so it doesn't look scripted, keeps a long playlist going.
 */
export function pauseBefore(index: number, random = Math.random): number {
  return index === 0 ? 0 : Math.round(3000 + random() * 4000);
}
