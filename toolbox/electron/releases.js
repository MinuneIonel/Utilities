// Which Toolbox release is newest on GitHub, and which of its files this computer
// installs. No Electron here, so the tests can run it in plain Node.

/** True when version `a` (like "0.10.1") is newer than `b`. */
export function newer(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** The installer each system updates itself from (see artifactName in package.json). */
const ASSETS = {
  "darwin-arm64": /-mac-arm64\.dmg$/,
  "win32-x64": /-win-x64\.exe$/,
  "linux-x64": /-linux-x86_64\.AppImage$/,
};

/** The release's file for `platform`/`arch`, with its size and sha256 (hex, when GitHub lists one). */
export function pickAsset(release, platform, arch) {
  const pattern = ASSETS[`${platform}-${arch}`];
  const asset = pattern && release.assets?.find((a) => pattern.test(a.name));
  if (!asset) return null;
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase() ?? null;
  return { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256 };
}

/** The newest published Toolbox release in GitHub's release list, when it's newer than `current`. */
export function newestRelease(releases, current, platform, arch) {
  const latest = releases.find((r) => !r.draft && !r.prerelease && /^toolbox-v\d/.test(r.tag_name));
  const version = latest?.tag_name.replace(/^toolbox-v/, "");
  if (!version || !newer(version, current)) return null;
  return { version, url: latest.html_url, notes: latest.body ?? "", asset: pickAsset(latest, platform, arch) };
}
