// Browser build check (npm run toolbox:web): with no desktop app around, the starter graph still
// renders and Save still downloads its file, so nothing desktop-only (the scratch folder, native
// tools) leaks into the browser; Simple view's button downloads its file too. Uses the installed
// Google Chrome; skipped when there is none.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const appDir = path.resolve(import.meta.dirname, "../..");

const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(
  (p) => p && existsSync(p),
);
if (!chrome) {
  console.log("skipped: no Google Chrome found (set CHROME_PATH)");
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const { createServer } = await import("vite");
const server = await createServer({ root: appDir, configFile: path.join(appDir, "vite.config.ts"), logLevel: "error", server: { port: 0, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local[0];
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-web-"));
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on("pageerror", (e) => errors.push(e.message));
  // A missing resource is reported by URL below (the dev server has no favicon, which is fine).
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 300)));
  page.on("response", (r) => r.status() >= 400 && !/\/favicon\.ico$/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(url);
  await page.waitForSelector(".canvas", { state: "attached", timeout: 60_000 });
  // A new browser opens on Simple view, and Graph view starts with the tour: this part drives the graph.
  await page.evaluate(() => {
    localStorage.setItem("toolbox.tutorial", "1");
    localStorage.setItem("toolbox.mode", "graph");
  });
  await page.reload();
  await page.waitForSelector(".canvas");
  check("The browser build has no desktop bridge", await page.evaluate(() => !("toolbox" in window)));
  // Drop a picture on the canvas: it fills the starter graph's empty image input.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(64, 48);
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(1, "#fff");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 48);
    const blob = await c.convertToBlob({ type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "gradient.png", { type: "image/png" }));
    const el = document.querySelector(".canvas");
    const r = el.getBoundingClientRect();
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 100, clientY: r.y + 400 }));
  });
  await page.waitForTimeout(3000);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }).catch(() => null), page.click(".topbar button.primary")]);
  const file = download && path.join(tmp, download.suggestedFilename());
  if (download) await download.saveAs(file);
  const png = file && existsSync(file) ? readFileSync(file) : null;
  check(
    "Render & save downloads the starter graph's PNG",
    !!png && download.suggestedFilename() === "dithered.png" && png.subarray(1, 4).toString() === "PNG",
    download ? `${download.suggestedFilename()}, ${png?.length ?? 0} bytes` : `no download; ${errors.join(" | ")}`,
  );

  // Simple view in a browser: no folder to pick, and the button downloads the file.
  await page.click('.app .mode-switch button:has-text("Simple")');
  await page.waitForSelector('.simple-tile[data-workflow="qr-code"]');
  check(
    "A browser tab offers no folder workflows (it can't read folders)",
    !(await page.$('.simple-tile[data-workflow="compress-folder"]')) && !(await page.$('.simple-tile[data-workflow="watermark-folder"]')),
  );
  await page.click('.simple-tile[data-workflow="qr-code"]');
  await page.fill(".simple-text", "https://example.com/from-the-browser");
  check(
    "Simple view says files go to the browser's downloads folder, with no folder to pick",
    (await page.isVisible("text=Your browser saves the files in its downloads folder.")) && !(await page.$(".simple-folder")),
  );
  const [qr] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }).catch(() => null), page.click(".simple-action")]);
  check("…and its button downloads the QR code", qr?.suggestedFilename() === "qr-code.png", qr ? qr.suggestedFilename() : `no download; ${errors.join(" | ")}`);
  check("…with no errors on the page", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall browser checks passed");
process.exit(failed ? 1 : 0);
