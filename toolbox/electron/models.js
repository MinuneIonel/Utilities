// Model files for nodes that need one (Remove background). Each is downloaded the
// first time it's used, checked against a pinned checksum, and kept in Toolbox's
// folder, so after that it works offline.
import { app, ipcMain, net } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/";

/** Every model Toolbox may download, with its size and SHA-256. Nothing else is fetched. */
export const MODELS = {
  "isnet-general-use.onnx": { bytes: 178648008, sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a" },
  "u2netp.onnx": { bytes: 4574861, sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8" },
};

const home = (file) => path.join(app.getPath("userData"), "models", file);

/** One download per file at a time, even if several nodes ask at once. */
const pending = new Map();

async function download(file, report) {
  const spec = MODELS[file];
  const mb = Math.round(spec.bytes / 1e6);
  report(0, `Downloading the model (${mb} MB, once)…`);
  const res = await net.fetch(BASE + file);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the background model (${res.status}). It's needed once; check the internet connection.`);
  const chunks = [];
  let got = 0;
  let last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got - last > 2e6) {
      last = got;
      report(Math.min(0.99, got / spec.bytes), `Downloading the model (${mb} MB, once)…`);
    }
  }
  const bytes = Buffer.concat(chunks);
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (sum !== spec.sha256) throw new Error("The downloaded model didn't match its checksum, so Toolbox didn't keep it. Try again.");
  const to = home(file);
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to + ".part", bytes);
  await rename(to + ".part", to);
  return bytes;
}

async function getModel(file, report) {
  const spec = MODELS[file];
  if (!spec) throw new Error(`Unknown model ${file}`);
  const to = home(file);
  // A file of the right size was checked when it was downloaded.
  if (existsSync(to) && (await stat(to)).size === spec.bytes) return readFile(to);
  await rm(to, { force: true });
  let p = pending.get(file);
  if (!p) {
    p = download(file, report).finally(() => pending.delete(file));
    pending.set(file, p);
  }
  return p;
}

export function registerModels() {
  ipcMain.handle("model-get", (e, id, file) =>
    getModel(file, (fraction, label) => {
      if (!e.sender.isDestroyed()) e.sender.send("tool-progress", id, fraction, label);
    }),
  );
}
