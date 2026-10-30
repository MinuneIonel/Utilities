// QR check: drives the built desktop app (npm run build first) through QR code graphs,
// then scans what Save wrote.
//   node test/e2e/qr.mjs     (on Linux under xvfb-run)
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const jsQR = require("jsqr");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-qr-"));

const GAME_BOY = { version: 1, name: "Game Boy", pixelSize: 1, steps: [{ type: "dither", enabled: true, params: { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 } }] };

// Each case: nodes [type, params], edges [from, output, to, input], and what the saved files should scan as.
const CASES = [
  {
    name: "Link to PNG and SVG",
    nodes: [["input.qr", { text: "https://example.com/ă?x=1", size: 600 }], ["output.save-file", { name: "link" }], ["output.save-file", { name: "link" }]],
    edges: [[0, "image", 1, "file"], [0, "svg", 2, "file"]],
    expect: { "link.png": "https://example.com/ă?x=1", "link.svg": null },
  },
  {
    name: "Wi-Fi, dithered",
    nodes: [["input.qr", { content: "wifi", ssid: "Casa", password: "secret;1", size: 800, level: "H" }], ["dither.recipe", { recipe: GAME_BOY, size: "source" }], ["output.save-file", { name: "wifi" }]],
    edges: [[0, "image", 1, "image"], [1, "image", 2, "file"]],
    expect: { "wifi.png": "WIFI:T:WPA;S:Casa;P:secret\\;1;;" },
  },
  {
    name: "Wired text",
    nodes: [["input.text", { text: "Salut din Toolbox" }], ["input.qr", {}], ["output.save-file", { name: "wired" }]],
    edges: [[0, "text", 1, "text"], [1, "image", 2, "file"]],
    expect: { "wired.png": "Salut din Toolbox" },
  },
];

function graph(c, folder) {
  const nodes = c.nodes.map(([type, params], i) => ({ id: `n${i}`, type, params: type === "output.save-file" ? { ...params, folder } : params, position: { x: 40 + 300 * i, y: 120 + 200 * i } }));
  const edges = c.edges.map(([s, sh, t, th], i) => ({ id: `e${i}`, source: `n${s}`, sourceHandle: sh, target: `n${t}`, targetHandle: th }));
  return { version: 1, nodes, edges };
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
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
    }, file);
    await win.waitForTimeout(1500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
    const want = Object.keys(c.expect);
    const written = () => readdirSync(out).filter((f) => want.includes(f));
    for (let i = 0; i < 120 && written().length < want.length; i++) await win.waitForTimeout(250);
    await win.waitForTimeout(500);
    const errText = await win.evaluate(() => [...document.querySelectorAll(".node-error, .error")].map((e) => e.textContent).join(" | "));
    const problems = [];
    for (const [f, text] of Object.entries(c.expect)) {
      const p = path.join(out, f);
      if (!written().includes(f)) { problems.push(`missing ${f}`); continue; }
      if (f.endsWith(".svg")) {
        if (!/^<svg [^>]*shape-rendering="crispEdges"/.test(readFileSync(p, "utf8"))) problems.push(`${f} isn't a QR SVG`);
        continue;
      }
      // Electron decodes the PNG; nativeImage gives BGRA.
      const { width, height, bgra } = await app.evaluate(({ nativeImage }, f) => {
        const img = nativeImage.createFromPath(f);
        const { width, height } = img.getSize();
        return { width, height, bgra: [...img.toBitmap()] };
      }, p);
      const rgba = new Uint8ClampedArray(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) rgba.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
      const got = jsQR(rgba, width, height)?.data;
      if (got !== text) problems.push(`${f} (${width}×${height}) scans as ${JSON.stringify(got)}, wanted ${JSON.stringify(text)}`);
    }
    return { ok: !problems.length, files: readdirSync(out).filter((f) => f !== "graph.toolbox").sort(), problems, errors: [errText, ...errors].filter(Boolean) };
  } finally {
    await app.close();
  }
}

let ok = true;
for (const c of CASES) {
  const r = await runCase(c);
  ok &&= r.ok;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${c.name}: ${r.files.join(", ")}`);
  for (const p of r.problems) console.log(`     ${p}`);
  if (!r.ok) for (const e of r.errors) console.log(`     ${e}`);
}
rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
