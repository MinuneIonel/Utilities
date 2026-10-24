// GPU check: builds entry.ts, serves it on localhost (WebGPU needs a secure
// origin) and opens it in Electron, or in Playwright's Chromium with --chromium.
// Pass --bench to time CPU against GPU on 1080p frames as well.
//   node test/gpu/run.mjs [--bench] [--chromium]
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { build } from "vite";

const here = import.meta.dirname;
const out = path.join(os.tmpdir(), "toolbox-gpu-check");
const bench = process.argv.includes("--bench");
process.env.GPU_CHECK_OUT = out;
await build({ configFile: path.join(here, "vite.config.ts") });

const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const file = path.join(out, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/index.html${bench ? "?bench" : ""}`;

let result;
if (process.argv.includes("--chromium")) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && console.error(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.gpuCheck, null, { timeout: 600_000 });
  console.log(await page.textContent("#log"));
  result = await page.evaluate(() => window.gpuCheck);
  await browser.close();
} else {
  const electron = createRequire(import.meta.url)("electron");
  const code = await new Promise((resolve) => {
    const extra = process.platform === "linux" ? ["--no-sandbox"] : [];
    const p = spawn(electron, [path.join(here, "electron-main.cjs"), ...extra, url], { stdio: "inherit" });
    p.on("close", resolve);
  });
  result = { ok: code === 0 };
}
server.close();
process.exit(result?.ok ? 0 : 1);
