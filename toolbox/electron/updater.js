// Updates Toolbox from its GitHub Releases without a paid signing certificate.
// Electron's own updater (Squirrel.Mac) only accepts apps signed with a Developer ID,
// so each system gets the plain version of what electron-updater does:
//   Mac:     mount the new .dmg, copy Toolbox.app out, swap it in once this app quits, reopen.
//   Windows: run the new installer silently once this app quits; it reopens Toolbox.
//   Linux:   put the new AppImage where the old one is and restart into it.
// Files Toolbox downloads itself carry no quarantine flag (Mac) or mark of the web
// (Windows), so the updated app opens without the first-launch warnings.
import { app, ipcMain, net, session } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants, copyFile, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { newestRelease } from "./releases.js";

// TOOLBOX_RELEASES_URL points the check at a test server instead.
const RELEASES = process.env.TOOLBOX_RELEASES_URL || "https://api.github.com/repos/MinuneIonel/Utilities/releases?per_page=20";

/** The release found by the last check: what the download and install steps act on. */
let found = null;
/** The downloaded update, ready to install: { version, install() }. */
let ready = null;
let downloading = null;

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} failed: ${out.trim()}`))));
  });

const writable = (p) => access(p, constants.W_OK).then(() => true, () => false);

/** Toolbox.app on a Mac (the folder around the executable). */
const macBundle = () => path.resolve(app.getPath("exe"), "../../..");

/** Whether this copy of Toolbox can replace itself; otherwise the app links to the download page. */
async function installable(asset) {
  if (!asset || !app.isPackaged) return false;
  if (process.platform === "darwin") {
    const bundle = macBundle();
    // Opened straight from the .dmg, or from Downloads before it was moved (macOS runs that from a read-only copy).
    if (!bundle.endsWith(".app") || bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/")) return false;
    return (await writable(bundle)) && (await writable(path.dirname(bundle)));
  }
  if (process.platform === "linux") return !!process.env.APPIMAGE && (await writable(path.dirname(process.env.APPIMAGE)));
  return process.platform === "win32";
}

async function check() {
  const res = await net.fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const release = newestRelease(await res.json(), app.getVersion(), process.platform, process.arch);
  if (!release) return null;
  found = release;
  return { version: release.version, url: release.url, canInstall: await installable(release.asset) };
}

/** Downloads the installer into `dir`, checked against the size and sha256 GitHub lists for it. */
async function download(asset, dir, onProgress) {
  const res = await net.fetch(asset.url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the update (${res.status})`);
  const file = path.join(dir, asset.name);
  const out = createWriteStream(file);
  const hash = createHash("sha256");
  let got = 0;
  let shown = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      if (got - shown > asset.size / 200) {
        shown = got;
        onProgress(Math.min(0.99, got / asset.size));
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (got !== asset.size || (asset.sha256 && hash.digest("hex") !== asset.sha256)) {
    throw new Error("The download didn't match the release, so Toolbox didn't install it. Try again later.");
  }
  return file;
}

/** Mac: Toolbox.app out of the .dmg into `dir`, after checking it's the version that was asked for. */
async function prepareMac(dmg, dir, version) {
  const mount = path.join(dir, "mnt");
  await mkdir(mount);
  await run("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount]);
  const staged = path.join(dir, "Toolbox.app");
  try {
    const name = (await readdir(mount)).find((n) => n.endsWith(".app"));
    if (!name) throw new Error("The update's disk image has no app in it");
    await run("/usr/bin/ditto", [path.join(mount, name), staged]);
  } finally {
    await run("/usr/bin/hdiutil", ["detach", mount, "-force"]).catch(() => undefined);
  }
  await rm(dmg, { force: true });
  const plist = path.join(staged, "Contents/Info.plist");
  const has = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist])).trim();
  if (has !== version) throw new Error(`The update says it's version ${has}, not ${version}`);
  return staged;
}

/**
 * A shell script, started before Toolbox quits, that waits for it to exit, swaps the
 * app (keeping the old one until the new one is in place) and opens it again.
 */
function swapMacApp(staged) {
  const bundle = macBundle();
  const script = `
    while kill -0 "$PID" 2>/dev/null; do sleep 0.2; done
    mv "$APP" "$APP.old" || exit 1
    if /usr/bin/ditto "$NEW" "$APP"; then rm -rf "$APP.old"; else rm -rf "$APP"; mv "$APP.old" "$APP"; fi
    rm -rf "$(dirname "$NEW")"
    /usr/bin/xattr -cr "$APP" 2>/dev/null
    open "$APP"
  `;
  spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PID: String(process.pid), APP: bundle, NEW: staged },
  }).unref();
}

async function prepare(onProgress) {
  const release = found;
  if (!release?.asset) throw new Error("There's no update for this computer");
  const dir = path.join(app.getPath("temp"), `toolbox-update-${release.version}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const file = await download(release.asset, dir, onProgress);
  onProgress(-1);

  if (process.platform === "darwin") {
    const staged = await prepareMac(file, dir, release.version);
    return { version: release.version, install: () => swapMacApp(staged) };
  }
  if (process.platform === "win32") {
    // The same switches electron-updater passes: keep settings, no questions, open Toolbox when done.
    const install = () => spawn(file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    return { version: release.version, install };
  }
  // Linux: next to the old AppImage (same disk, so the final rename can't half-happen),
  // named after the new version when the old name had the old version in it.
  const current = process.env.APPIMAGE;
  const oldName = path.basename(current);
  const target = path.join(path.dirname(current), oldName.includes(app.getVersion()) ? oldName.replace(app.getVersion(), release.version) : oldName);
  const part = `${target}.part`;
  await copyFile(file, part);
  await chmod(part, 0o755);
  await rm(dir, { recursive: true, force: true });
  const install = async () => {
    await rename(part, target);
    if (target !== current) await unlink(current).catch(() => undefined);
    app.relaunch({ execPath: target, args: process.argv.slice(1) });
  };
  return { version: release.version, install };
}

export function registerUpdater(getWindow) {
  // Offline, the daily check tries again another day; Help > Check for Updates says so.
  ipcMain.handle("check-update", (_e, strict) => (strict ? check() : check().catch(() => null)));

  ipcMain.handle("update-download", () => {
    downloading ??= prepare((fraction) => getWindow()?.webContents.send("update-progress", fraction))
      .then((r) => {
        ready = r;
        return r.version;
      })
      .finally(() => (downloading = null));
    return downloading;
  });

  ipcMain.handle("update-install", async () => {
    if (!ready) throw new Error("Download the update first");
    // The graph autosaves to localStorage; make sure it's on disk before the app goes.
    await session.defaultSession.flushStorageData();
    await ready.install();
    app.quit();
  });
}
