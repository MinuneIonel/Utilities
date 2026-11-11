// Save check (npm run build first; on Linux under xvfb-run): what a Save node with a folder does
// when its file is already there. It replaces only the file it wrote itself, after a restart too,
// keeps both when told to, skips when told to, and never replaces a file a graph merely names.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-save-"));
// Its own profile, so the files Toolbox remembers writing start empty and the restart keeps them.
const profile = path.join(tmp, "profile");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const folder = (name) => {
  const d = path.join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const graph = (out, text, save = {}) => ({
  version: 1,
  nodes: [
    { id: "q", type: "input.qr", params: { text, size: 200 }, position: { x: 40, y: 120 } },
    { id: "s", type: "output.save-file", params: { name: "qr", folder: out, ...save }, position: { x: 340, y: 120 } },
  ],
  edges: [{ id: "e1", source: "q", sourceHandle: "image", target: "s", targetHandle: "file" }],
});
const ls = (d) => readdirSync(d).sort();

async function launch() {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, `--user-data-dir=${profile}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".canvas");
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1")) {
    await win.evaluate(() => localStorage.setItem("toolbox.tutorial", "1"));
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
  let n = 0;
  const t = {
    app,
    win,
    menu,
    async open(g) {
      const f = path.join(tmp, `g${Date.now()}-${n++}.toolbox`);
      writeFileSync(f, JSON.stringify(g));
      await app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
        dialog.showMessageBox = async () => ({ response: 0 });
      }, f);
      await menu("open");
      await win.waitForTimeout(1500);
    },
    /** Renders and waits until the Save node reports, so a skipped file still finishes. */
    async render() {
      await win.evaluate(() => {
        const el = document.querySelector('.react-flow__node[data-id="s"] .tnode-status');
        if (el) el.textContent = "";
      });
      await menu("render");
      for (let i = 0; i < 80; i++) {
        await win.waitForTimeout(250);
        if (/Saved|Kept/.test(await t.status())) break;
      }
      await win.waitForTimeout(500);
    },
    status: () => win.evaluate(() => document.querySelector('.react-flow__node[data-id="s"] .tnode-status')?.textContent ?? ""),
    async setText(text) {
      await win.click('.react-flow__node[data-id="q"] .tnode-title');
      await win.locator('.inspector .field:has(label:text-is("Link or text")) textarea').fill(text);
      await win.waitForTimeout(1200);
    },
    async setExists(value) {
      await win.click('.react-flow__node[data-id="s"] .tnode-title');
      await win.locator('.inspector .field:has(label:text-is("If the file exists")) select').selectOption(value);
      await win.waitForTimeout(800);
    },
  };
  return t;
}

const own = folder("own");
let t = await launch();
try {
  await t.open(graph(own, "first"));
  await t.render();
  const first = readFileSync(path.join(own, "qr.png"));
  await t.setText("second, a longer text so the code changes");
  await t.render();
  check("Render after a change replaces its own file", ls(own).join() === "qr.png", ls(own).join(", "));
  check("…with the new picture", !readFileSync(path.join(own, "qr.png")).equals(first));
  check("…and no half-written file is left", !ls(own).some((f) => f.endsWith(".part")));
} finally {
  await t.app.close();
}

// The graph autosaves with the files its Save node wrote, so after a restart it's still its own.
t = await launch();
try {
  await t.setText("third, after a restart");
  await t.render();
  check("After a restart it still replaces its own file", ls(own).join() === "qr.png", ls(own).join(", "));

  const theirs = folder("theirs");
  writeFileSync(path.join(theirs, "qr.png"), "not mine");
  await t.open(graph(theirs, "one"));
  await t.render();
  check("A file that was there first is kept; the new one gets a number", ls(theirs).join() === "qr (2).png,qr.png", ls(theirs).join(", "));
  check("…and the old file is untouched", readFileSync(path.join(theirs, "qr.png"), "utf8") === "not mine");
  await t.setText("two");
  await t.render();
  check("…and the next Render replaces the numbered one", ls(theirs).join() === "qr (2).png,qr.png", ls(theirs).join(", "));

  await t.setExists("number");
  await t.setText("three");
  await t.render();
  check("Keep both adds a number", ls(theirs).join() === "qr (2).png,qr (3).png,qr.png", ls(theirs).join(", "));

  await t.setExists("skip");
  await t.setText("four");
  await t.render();
  check("Skip writes nothing", ls(theirs).length === 3, ls(theirs).join(", "));
  check("…and says it kept the file", /^Kept qr\.png/.test(await t.status()), await t.status());

  // A graph from someone else can list any file as its own; Toolbox didn't write this one.
  const named = folder("named");
  writeFileSync(path.join(named, "qr.png"), "precious");
  await t.open(graph(named, "five", { lastSaved: [path.join(named, "qr.png")] }));
  await t.render();
  check("A graph naming a file as its own can't replace it", readFileSync(path.join(named, "qr.png"), "utf8") === "precious", ls(named).join(", "));
} finally {
  await t.app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall save checks passed");
process.exit(failed ? 1 : 0);
