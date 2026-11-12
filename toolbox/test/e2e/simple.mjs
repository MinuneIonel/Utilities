// Simple view check (npm run build first; on Linux under xvfb-run). A fresh profile opens on Simple
// home. Compress an image, Clean up Romanian text and QR code each go from a tile to a file in the
// folder on the form, without a save dialog, and Open as graph shows the same nodes (with the same
// files) on the canvas. Every workflow's form fits its graph and never says "Render" or "node";
// settings come back after a restart; typing a link downloads nothing; and a profile that already
// has an autosaved graph opens in Graph view.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const jsQR = require("jsqr");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-simple-"));
const out = path.join(tmp, "Downloads");
mkdirSync(out);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};
const ls = () => readdirSync(out).sort();
const waitFor = async (win, test, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await test()) return true;
    await win.waitForTimeout(250);
  }
  return false;
};

async function launch(profile) {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, `--user-data-dir=${profile}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".simple, .canvas", { state: "attached" });
  return { app, win };
}

/** Stubs every dialog: open dialogs pick `folder`, and save dialogs are counted (there should be none). */
const stubDialogs = (app, folder) =>
  app.evaluate(({ app, dialog }, { folder, downloads }) => {
    app.setPath("downloads", downloads);
    globalThis.saveDialogs ??= 0;
    dialog.showSaveDialog = async () => {
      globalThis.saveDialogs++;
      return { canceled: true };
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { folder, downloads: out });

/** Counts native tool runs (yt-dlp, ffmpeg) the window starts, by wrapping the main process's handler. */
const countTools = (app) =>
  app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    if (!(handlers instanceof Map) || globalThis.toolRuns !== undefined) return handlers instanceof Map;
    globalThis.toolRuns = [];
    for (const ch of ["tool-run", "tool-open"]) {
      const h = handlers.get(ch);
      if (h) handlers.set(ch, (e, ...a) => (globalThis.toolRuns.push(a[1]), h(e, ...a)));
    }
    return true;
  });

/** Text Simple view shows that a person shouldn't meet there. */
const jargon = (win) => win.evaluate(() => (document.querySelector(".simple")?.innerText.match(/\b(render\w*|nodes?)\b/gi) ?? []).join(", "));

const pickTile = async (win, id) => {
  await win.click(`.simple-tile[data-workflow="${id}"]`);
  await win.waitForSelector(`.simple-form[data-workflow="${id}"]`);
};
const backHome = async (win) => {
  await win.click(".simple-form .back");
  await win.waitForSelector(".simple-home");
};
const pressAction = async (win) => {
  await win.waitForSelector(".simple-action:not([disabled])", { timeout: 15000 });
  await win.click(".simple-action");
};
/** Open as graph, then what the canvas shows: node titles, and whether the first node shows a picture. */
const openAsGraph = async (win) => {
  await win.click(".simple-form button.quiet");
  await win.waitForSelector(".canvas", { state: "visible" });
  await win.waitForTimeout(1500);
  return win.evaluate(() => ({
    simpleHidden: document.querySelector(".simple")?.hidden === true,
    titles: [...document.querySelectorAll(".react-flow__node .tnode-title")].map((e) => e.textContent),
    thumb: [...document.querySelectorAll(".react-flow__node .tnode-thumb")].some((c) => !c.hidden && c.width > 0),
    tutorial: !!document.querySelector(".tutorial"),
    message: document.querySelector(".topbar .message")?.textContent ?? "",
  }));
};
const toSimple = async (win) => {
  await win.click('.app .mode-switch button:has-text("Simple")');
  await win.waitForSelector(".simple:not([hidden])");
};

const profile = path.join(tmp, "profile");
let t = await launch(profile);
try {
  const { app, win } = t;
  const errors = [];
  win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  await win.waitForSelector(".simple-home");
  check(
    "a fresh profile opens on Simple home, not the graph",
    await win.evaluate(() => document.querySelector(".app")?.hidden === true && !document.querySelector(".tutorial")),
  );

  // A photo with detail in it, so compressing it is real work.
  const png = await app.evaluate(({ nativeImage }) => {
    const w = 640;
    const h = 480;
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        buf[i] = (x * 255) / w;
        buf[i + 1] = (y * 255) / h;
        buf[i + 2] = ((x ^ y) * 7) & 255;
        buf[i + 3] = 255;
      }
    return [...nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG()];
  });
  const photo = path.join(tmp, "holiday.png");
  writeFileSync(photo, Buffer.from(png));

  // The default folder is the system's Downloads folder: point it at ours and start again.
  await stubDialogs(app, out);
  await win.reload();
  await win.waitForSelector(".simple-home");
  await pickTile(win, "compress-image");
  check("Save to starts at the Downloads folder", (await win.textContent(".simple-folder .path")) === out, await win.textContent(".simple-folder .path"));

  // ---------------------------------------------------------- Compress an image
  await win.setInputFiles('.simple-form input[type="file"]', photo);
  await win.waitForSelector(".simple-drop.has");
  check("the form says nothing about Render or nodes", !(await jargon(win)), await jargon(win));
  await pressAction(win);
  const jpg = await waitFor(win, async () => ls().some((f) => f.endsWith(".jpg")));
  await win.waitForSelector(".simple-saved li", { timeout: 15000 }).catch(() => undefined);
  const saved = await win.evaluate(() => [...document.querySelectorAll(".simple-saved li .name")].map((e) => e.textContent));
  check("Compress an image writes a JPEG into the folder", jpg, ls().join(", "));
  check("…and lists it with Show in folder and Open", saved.length === 1 && ls().includes(saved[0]) && (await win.isVisible('.simple-saved button:has-text("Show in folder")')), saved.join(", "));
  check("…without the word Render or node anywhere on the way", !(await jargon(win)), await jargon(win));

  let g = await openAsGraph(win);
  check("Open as graph shows the same three nodes", g.simpleHidden && JSON.stringify(g.titles) === JSON.stringify(["Image file", "Encode image", "Save"]), g.titles.join(", "));
  check("…with the photo in it", g.thumb);
  check("…and the tour starts the first time Graph view opens", g.tutorial);
  if (g.tutorial) await win.click('.tutorial button:has-text("Skip tour")');
  await toSimple(win);
  check("back in Simple view the form is as it was", await win.isVisible('.simple-form[data-workflow="compress-image"] .simple-drop.has'));
  await backHome(win);

  // ---------------------------------------------------------- Clean up Romanian text
  await pickTile(win, "romanian");
  const plain = "Aceasta este o propozitie scrisa fara diacritice in limba romana, pentru tara mea.";
  await win.fill(".simple-text", plain);
  await win.waitForSelector(".simple-preview-text");
  await pressAction(win);
  const txt = await waitFor(win, async () => ls().includes("text-cu-diacritice.txt"));
  const fixed = txt ? readFileSync(path.join(out, "text-cu-diacritice.txt"), "utf8") : "";
  check("Clean up Romanian text writes the text with diacritics", txt && /[ăâîșț]/.test(fixed) && fixed !== plain, fixed || ls().join(", "));
  g = await openAsGraph(win);
  check("Open as graph shows Text, Romanian diacritics and Save", JSON.stringify(g.titles) === JSON.stringify(["Text", "Romanian diacritics", "Save"]), g.titles.join(", "));
  check("…and no tour the second time", !g.tutorial);
  check("…and says ⌘Z (Ctrl+Z) brings the old graph back", /brings back the graph/.test(g.message), g.message);
  await toSimple(win);
  await backHome(win);

  // ---------------------------------------------------------- QR code
  await pickTile(win, "qr-code");
  check("QR code waits for a link before it can run", await win.isDisabled(".simple-action"));
  const link = "https://example.com/simple-view";
  await win.fill(".simple-text", link);
  await pressAction(win);
  const qr = await waitFor(win, async () => ls().includes("qr-code.png"));
  let scanned;
  if (qr) {
    const { width, height, bgra } = await app.evaluate(({ nativeImage }, f) => {
      const img = nativeImage.createFromPath(f);
      const { width, height } = img.getSize();
      return { width, height, bgra: [...img.toBitmap()] };
    }, path.join(out, "qr-code.png"));
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) rgba.set([bgra[i + 2], bgra[i + 1], bgra[i], bgra[i + 3]], i);
    scanned = jsQR(rgba, width, height)?.data;
  }
  check("QR code writes a PNG that scans as the link", scanned === link, `${ls().join(", ")} scans as ${JSON.stringify(scanned)}`);
  // Pressing again keeps the first file and adds a numbered one.
  await pressAction(win);
  check("pressing again keeps both files", await waitFor(win, async () => ls().includes("qr-code (2).png")), ls().join(", "));
  g = await openAsGraph(win);
  check("Open as graph shows QR code and Save", JSON.stringify(g.titles) === JSON.stringify(["QR code", "Save"]), g.titles.join(", "));
  await toSimple(win);
  await backHome(win);

  // ---------------------------------------------------------- every workflow
  const ids = await win.evaluate(() => [...document.querySelectorAll(".simple-tile")].map((e) => e.dataset.workflow));
  const broken = [];
  for (const id of ids) {
    await pickTile(win, id);
    const problem = await win.evaluate(() => document.querySelector(".simple-broken")?.textContent ?? "");
    const action = (await win.textContent(".simple-action"))?.trim();
    const words = await jargon(win);
    if (problem || !action || words) broken.push(`${id}: ${problem || (!action ? "no button text" : `says ${words}`)}`);
    await backHome(win);
  }
  check(`all ${ids.length} workflows have a form that fits their graph`, ids.length >= 20 && broken.length === 0, broken.join("\n     "));

  // A typed link stays in the form: nothing downloads until the button is pressed.
  const counting = await countTools(app);
  await pickTile(win, "download-video");
  await win.fill(".simple-link", "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await win.waitForTimeout(2500);
  const runs = counting ? await app.evaluate(() => globalThis.toolRuns.length) : 0;
  check("typing a link starts no download", counting && runs === 0 && !(await win.isVisible(".simple-go button:has-text('Stop')")), counting ? `${runs} tool runs` : "couldn't watch the main process");
  // The button does start it (offline it fails, which is fine here), and Stop stops it.
  await pressAction(win);
  const started = await waitFor(win, async () => (await app.evaluate(() => globalThis.toolRuns?.length ?? 0)) > 0, 60);
  if (await win.isVisible(".simple-go button:has-text('Stop')")) await win.click(".simple-go button:has-text('Stop')");
  const stopped = await waitFor(win, async () => win.isEnabled(".simple-action"), 60);
  check("…and pressing Download starts it, and Stop ends it", started && stopped, `${await app.evaluate(() => globalThis.toolRuns?.join(", "))}`);
  await backHome(win);

  // Settings come back after a restart, per workflow.
  await pickTile(win, "compress-image");
  await win.fill(".simple-fields input.num", "55");
  await win.press(".simple-fields input.num", "Enter");
  await win.waitForTimeout(300);
  await win.reload();
  await win.waitForSelector(".simple-home, .canvas", { state: "attached" });
  check("the last view used is the one that opens", await win.isVisible(".simple-home"));
  await pickTile(win, "compress-image");
  check("a form's settings come back after a restart", (await win.inputValue(".simple-fields input.num")) === "55", await win.inputValue(".simple-fields input.num"));

  check("no save dialog was ever opened", (await app.evaluate(() => globalThis.saveDialogs)) === 0);
  check("no errors in the console", errors.length === 0, errors.join("\n     "));
} finally {
  await t.app.close();
}

// Someone who already had a graph before Simple view existed stays in Graph view.
t = await launch(path.join(tmp, "old-profile"));
try {
  const { win } = t;
  await win.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("toolbox.tutorial", "1");
    localStorage.setItem("toolbox.graph", JSON.stringify({ version: 1, nodes: [{ id: "q", type: "input.qr", params: {}, position: { x: 40, y: 120 } }], edges: [] }));
  });
  await win.reload();
  await win.waitForSelector(".canvas", { state: "visible" });
  check(
    "a profile with an autosaved graph opens in Graph view",
    await win.evaluate(() => !document.querySelector(".simple") && document.querySelectorAll(".react-flow__node").length === 1),
  );
} finally {
  await t.app.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall Simple view checks passed");
process.exit(failed ? 1 : 0);
