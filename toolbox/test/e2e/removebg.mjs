// Remove background check: drives the built desktop app (npm run build first) through
// Remove background graphs and looks at the PNGs Save wrote. The first run downloads the
// model into Toolbox's folder, so it needs the internet once.
//   node test/e2e/removebg.mjs     (on Linux under xvfb-run)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-removebg-"));

// A red ball with a shadowy shading on a pale grey backdrop, like a product shot.
const photo = path.join(tmp, "ball.png");
const ball = (c) => `if(lt(hypot(X-450,Y-300),190),${c}*(1-0.4*hypot(X-390,Y-240)/380),232+8*Y/H)`;
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=900x600,format=rgb24", "-vf", `geq=r='${ball(230)}':g='${ball(40)}':b='${ball(40)}'`, "-frames:v", "1", photo]);

const photo2 = path.join(tmp, "ball-left.png");
execFileSync(ffmpeg, ["-v", "error", "-y", "-i", photo, "-vf", "hflip", photo2]);

const save = (name, folder) => ["output.save-file", { name, folder }];
const CASES = [
  {
    name: "Transparent cut-out (fast model)",
    nodes: (o) => [["input.file", {}], ["image.removebg", { model: "fast" }], save("cut", o)],
    edges: [[0, "image", 1, "image"], [1, "image", 2, "file"]],
    expect: { "cut.png": "cutout" },
  },
  {
    name: "Best model, white background and the mask",
    nodes: (o) => [["input.file", {}], ["image.removebg", { model: "best", fill: "color", color: "#ffffff" }], save("white", o), save("mask", o)],
    edges: [[0, "image", 1, "image"], [1, "image", 2, "file"], [1, "mask", 3, "file"]],
    expect: { "white.png": "white", "mask.png": "mask" },
  },
  {
    name: "Many photos keep their transparency",
    files: [photo, photo2],
    nodes: (o) => [["input.images", {}], ["image.removebg", { model: "fast" }], save("", o)],
    edges: [[0, "images", 1, "image"], [1, "image", 2, "file"]],
    expect: { "ball.png": "cutout", "ball-left.png": "cutout" },
  },
];

function graph(c, folder) {
  const nodes = c.nodes(folder).map(([type, params], i) => ({ id: `n${i}`, type, params, position: { x: 40 + 300 * i, y: 120 + 220 * i } }));
  const edges = c.edges.map(([s, sh, t, th], i) => ({ id: `e${i}`, source: `n${s}`, sourceHandle: sh, target: `n${t}`, targetHandle: th }));
  return { version: 1, nodes, edges };
}

/** Checks a saved picture: centre is the ball, corners are the background as `kind` says. */
function check(kind, { width, height, rgba }) {
  const at = (x, y) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  const centre = at(450, 300);
  const corner = at(20, 20);
  const problems = [];
  if (width !== 900 || height !== 600) problems.push(`is ${width}×${height}`);
  if (kind === "cutout") {
    if (centre[3] < 250 || centre[0] < 150) problems.push(`centre should be opaque red, is ${centre}`);
    if (corner[3] > 5) problems.push(`corner should be transparent, is ${corner}`);
  } else if (kind === "white") {
    if (centre[0] < 150 || centre[1] > 120) problems.push(`centre should be red, is ${centre}`);
    if (corner.some((v) => v < 250)) problems.push(`corner should be white, is ${corner}`);
  } else {
    if (centre[0] < 250) problems.push(`mask centre should be white, is ${centre}`);
    if (corner[0] > 5) problems.push(`mask corner should be black, is ${corner}`);
  }
  return problems;
}

async function runCase(c) {
  const out = path.join(tmp, c.name.replace(/\W+/g, "-"));
  mkdirSync(out, { recursive: true });
  const file = path.join(out, "graph.toolbox");
  writeFileSync(file, JSON.stringify(graph(c, out)));
  const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
  const errors = [];
  try {
    const win = await app.firstWindow();
    win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
    await win.waitForSelector(".canvas");
    await app.evaluate(({ dialog, BrowserWindow }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      // Opening a graph that names files asks first: use them.
      dialog.showMessageBox = async () => ({ response: 0 });
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
    }, file);
    await win.waitForTimeout(1000);
    await win.evaluate(async (files) => {
      const dt = new DataTransfer();
      for (const [b64, name] of files) dt.items.add(new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name, { type: "image/png" }));
      const el = document.querySelector(".canvas");
      const r = el.getBoundingClientRect();
      for (const t of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 100, clientY: r.y + 140 }));
    }, (c.files ?? [photo]).map((f) => [readFileSync(f).toString("base64"), path.basename(f)]));
    await win.waitForTimeout(2000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
    const want = Object.keys(c.expect);
    const written = () => readdirSync(out).filter((f) => want.includes(f));
    // The first run downloads the model.
    for (let i = 0; i < 1200 && written().length < want.length; i++) await win.waitForTimeout(250);
    await win.waitForTimeout(500);
    const errText = await win.evaluate(() => [...document.querySelectorAll(".node-error, .error")].map((e) => e.textContent).join(" | "));
    const problems = [];
    for (const [f, kind] of Object.entries(c.expect)) {
      const p = path.join(out, f);
      if (!written().includes(f)) {
        problems.push(`missing ${f}`);
        continue;
      }
      // Electron decodes the PNG; nativeImage gives BGRA, premultiplied is fine for these checks.
      const { width, height, bgra } = await app.evaluate(({ nativeImage }, f) => {
        const img = nativeImage.createFromPath(f);
        const { width, height } = img.getSize();
        return { width, height, bgra: [...img.toBitmap()] };
      }, p);
      const rgba = new Uint8ClampedArray(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) rgba.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
      problems.push(...check(kind, { width, height, rgba }).map((m) => `${f} ${m}`));
    }
    return { ok: !problems.length, files: readdirSync(out).filter((f) => f !== "graph.toolbox").sort(), problems, errors: [errText, ...errors].filter(Boolean) };
  } finally {
    await app.close();
  }
}

let ok = true;
for (const c of CASES) {
  const t = Date.now();
  const r = await runCase(c);
  ok &&= r.ok;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name} (${((Date.now() - t) / 1000).toFixed(1)} s): ${r.files.join(", ")}`);
  for (const p of r.problems) console.log(`     ${p}`);
  if (!r.ok) for (const e of r.errors) console.log(`     ${e}`);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
