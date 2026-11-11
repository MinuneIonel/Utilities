// Buttons check (npm run build first; on Linux under xvfb-run): Render, Save and "runs on Render"
// are told apart. The top bar names the graph buttons, Render says "& save" when something saves,
// job nodes look different and can Run without writing files, and out-of-date results show.
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-buttons-"));
const out = path.join(tmp, "out");
mkdirSync(out);

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const graph = (withSave) => ({
  version: 1,
  nodes: [
    { id: "q", type: "input.qr", params: { text: "one", size: 200 }, position: { x: 40, y: 120 } },
    { id: "e", type: "media.encode", params: { format: "png" }, position: { x: 340, y: 120 } },
    ...(withSave ? [{ id: "s", type: "output.save-file", params: { name: "qr", folder: out }, position: { x: 640, y: 120 } }] : []),
  ],
  edges: [
    { id: "e1", source: "q", sourceHandle: "image", target: "e", targetHandle: "image" },
    ...(withSave ? [{ id: "e2", source: "e", sourceHandle: "file", target: "s", targetHandle: "file" }] : []),
  ],
});

const app = await _electron.launch({ executablePath: require("electron"), args: [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])] });
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".canvas");
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1")) {
    await win.evaluate(() => localStorage.setItem("toolbox.tutorial", "1"));
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
  let n = 0;
  const open = async (g) => {
    const f = path.join(tmp, `g${n++}.toolbox`);
    writeFileSync(f, JSON.stringify(g));
    await app.evaluate(({ dialog }, f) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })), f);
    await menu("open");
    await win.waitForTimeout(2000);
  };
  const node = (id) => win.locator(`.react-flow__node[data-id="${id}"]`);
  const status = (id) => node(id).locator(".tnode-status").textContent().catch(() => "");
  const primary = () => win.locator("header button.primary").textContent();

  const bar = await win.locator("header.topbar button").allTextContents();
  check("The top bar names the graph buttons", ["New graph", "Open graph", "Save graph"].every((l) => bar.includes(l)), bar.join(" | "));

  await open(graph(true));
  check("With a Save node, the main button says Render & save", (await primary()).startsWith("Render & save"), await primary());
  check("Job nodes have the dashed edge", await node("e").locator(".tnode.job").count() === 1 && await node("s").locator(".tnode.job").count() === 1);
  check("…and live nodes don't", await node("q").locator(".tnode.job").count() === 0);
  check("A job node says it runs on Render", (await status("e")) === "Runs on Render", await status("e"));
  check("A Save node that hasn't saved has no Save again button", await node("s").getByRole("button", { name: "Save again" }).count() === 0);

  await node("e").getByRole("button", { name: "Run" }).click();
  for (let i = 0; i < 40 && /Runs on Render|Running/.test(await status("e")); i++) await win.waitForTimeout(250);
  await win.waitForTimeout(500);
  check("Run shows the job node's result", /KB|cached|ms/.test(await status("e")), await status("e"));
  check("…without writing a file", readdirSync(out).length === 0, readdirSync(out).join(", "));
  check("…and says how to write it", /Press Render & save/.test(await win.locator("header .message").textContent()), await win.locator("header .message").textContent());

  await menu("render");
  for (let i = 0; i < 40 && !readdirSync(out).length; i++) await win.waitForTimeout(250);
  await win.waitForTimeout(800);
  check("Render & save writes the file", readdirSync(out).join() === "qr.png", readdirSync(out).join(", "));
  check("…and then Save again appears", await node("s").getByRole("button", { name: "Save again" }).count() === 1);

  await node("q").locator(".tnode-title").click();
  await win.locator('.inspector .field:has(label:text-is("Link or text")) textarea').fill("two");
  await win.waitForTimeout(1500);
  check("An out-of-date job node lights up its Run button", await node("e").locator(".run-now.stale").count() === 1, await status("e"));
  check("…and the main button carries a dot", await win.locator("header button.primary .stale-dot").count() === 1);

  await open(graph(false));
  check("Without a Save node it just says Render", (await primary()).trim() === "Render", await primary());
} finally {
  await app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall button checks passed");
process.exit(failed ? 1 : 0);
