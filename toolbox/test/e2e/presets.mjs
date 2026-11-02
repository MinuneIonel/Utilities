// Undo and presets check: drives the built desktop app (npm run build first).
//   node test/e2e/presets.mjs     (on Linux under xvfb-run)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-presets-"));
const userData = path.join(tmp, "user");

const RECIPE = { version: 1, name: "Game Boy", pixelSize: 2, steps: [{ type: "dither", enabled: true, params: { algorithm: "bayer4", palette: "gb", distance: "luma", strength: 0.9 } }] };
const graph = {
  version: 1,
  nodes: [
    { id: "n0", type: "input.qr", params: { text: "hello" }, position: { x: 40, y: 120 } },
    { id: "n1", type: "dither.recipe", params: { recipe: RECIPE, size: "source" }, position: { x: 360, y: 120 } },
  ],
  edges: [{ id: "e0", source: "n0", sourceHandle: "image", target: "n1", targetHandle: "image" }],
};
const file = path.join(tmp, "graph.toolbox");
writeFileSync(file, JSON.stringify(graph));

const launch = () =>
  _electron.launch({ executablePath: require("electron"), args: [appDir, `--user-data-dir=${userData}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

async function open(app, win) {
  await win.waitForSelector(".canvas");
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1")) {
    await win.evaluate(() => localStorage.setItem("toolbox.tutorial", "1"));
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  await app.evaluate(({ dialog, BrowserWindow }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
  }, file);
  await win.waitForTimeout(1200);
  await win.click('.react-flow__node[data-id="n1"]');
  await win.waitForSelector(".dither-panel");
}

const menu = (app, c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
const pixel = (win) => win.locator(".dither-panel .field:has(> label:text-is('Pixel size')) input[type=range]");
const pixelShown = (win) => win.locator(".dither-panel .field:has(> label:text-is('Pixel size')) output").textContent();
const presetSelect = (win) => win.locator(".field.presets select");
const presetShown = (win) => presetSelect(win).evaluate((s) => s.options[s.selectedIndex]?.textContent ?? "");
const setPixel = async (win, v) => {
  await pixel(win).focus();
  await pixel(win).fill(String(v));
  await win.waitForTimeout(600); // let it settle into an undo step
};

let app = await launch();
try {
  const win = await app.firstWindow();
  const errors = [];
  win.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  await win.evaluate(() => localStorage.removeItem("toolbox.presets"));
  await open(app, win);
  check((await pixelShown(win)) === "2px", "dither node starts at 2px");

  // ⌘Z right after dragging a slider (focus still on it) undoes the change.
  await setPixel(win, 7);
  check((await pixelShown(win)) === "7px", "slider moves to 7px");
  await menu(app, "undo");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "2px", "⌘Z with the slider focused undoes it (panel shows 2px)");
  await menu(app, "redo");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "7px", "redo brings 7px back");
  await win.click(".topbar .undo");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "2px", "the Undo button undoes too");
  // The panel must not resend its stale copy: a new edit builds on the undone state.
  await setPixel(win, 3);
  await menu(app, "undo");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "2px", "editing after undo, then undoing, lands on 2px again");

  // Save a preset.
  check((await presetShown(win)) === "None saved yet", "no presets yet");
  await setPixel(win, 5);
  await win.click(".preset-actions button:text-is('Save…')");
  await win.fill(".field.presets input[type=text]", "Chunky");
  await win.press(".field.presets input[type=text]", "Enter");
  await win.waitForTimeout(300);
  check((await presetShown(win)) === "Chunky", "saved preset shows as the current one");
  const name = await win.locator(".dither-panel .field:has(> label:text-is('Preset')) select option").first().textContent();
  check(name === "Chunky", `dither recipe takes the preset's name (${name})`);

  // Change things, then put the preset back.
  await setPixel(win, 9);
  check((await presetShown(win)) === "Pick a preset…", "changing a setting leaves the preset");
  await presetSelect(win).selectOption("Chunky");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "5px", "picking the preset puts 5px back");
  await menu(app, "undo");
  await win.waitForTimeout(400);
  check((await pixelShown(win)) === "9px", "applying a preset is one undo step");
  check(!errors.length, `no console errors ${errors.join(" | ")}`);
} finally {
  await app.close();
}

// Presets outlive the app.
app = await launch();
try {
  const win = await app.firstWindow();
  await open(app, win);
  const options = await presetSelect(win).locator("option").allTextContents();
  check(options.includes("Chunky"), `preset is still there after a restart (${options.join(", ")})`);
  await presetSelect(win).selectOption("Chunky");
  await win.click(".preset-actions button:text-is('Delete')");
  await win.click(".preset-actions button:text-is('Delete?')");
  await win.waitForTimeout(200);
  check((await presetShown(win)) === "None saved yet", "delete asks once more, then removes it");
} finally {
  await app.close();
}

rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
