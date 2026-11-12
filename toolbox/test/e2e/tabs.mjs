// Tabs check (npm run build first; on Linux under xvfb-run): several graphs open at once, one per
// tab. Two tabs whose graphs share node ids keep their own undo steps, pictures and renders; Save
// writes over a graph's own file without asking; opening a file that's already open shows its tab;
// a workflow opens in a tab of its own (or goes into this graph with Insert); a tab with changes
// asks before closing; Open Recent and a file on the command line open tabs; and a restart brings
// every tab back, with its unsaved changes.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-tabs-"));
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
// Every graph here uses the same node ids, as the same file opened twice would.
const graph = (text, out) => ({
  version: 1,
  nodes: [
    { id: "q", type: "input.qr", params: { text, size: 200 }, position: { x: 40, y: 120 } },
    { id: "s", type: "output.save-file", params: { name: "qr", folder: out }, position: { x: 340, y: 120 } },
  ],
  edges: [{ id: "e1", source: "q", sourceHandle: "image", target: "s", targetHandle: "file" }],
});
const graphFile = (name, text) => {
  const f = path.join(tmp, `${name}.toolbox`);
  writeFileSync(f, JSON.stringify(graph(text, folder(`out-${name}`))));
  return f;
};
const fileA = graphFile("alpha", "alpha");
const fileB = graphFile("beta", "beta");
const fileD = graphFile("delta", "delta");
const fileC = path.join(tmp, "gamma.toolbox");
const readText = (f) => JSON.parse(readFileSync(f, "utf8")).nodes.find((n) => n.id === "q")?.params.text;

async function launch(extra = []) {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, `--user-data-dir=${profile}`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), ...extra],
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".canvas", { state: "attached" });
  // A new profile opens on Simple view, and Graph view starts with the tour: these checks drive the graph.
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1" || localStorage.getItem("toolbox.mode") !== "graph")) {
    await win.evaluate(() => {
      localStorage.setItem("toolbox.tutorial", "1");
      localStorage.setItem("toolbox.mode", "graph");
    });
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  // Dialogs answer by themselves and count how often they were shown.
  await app.evaluate(({ dialog }) => {
    globalThis.shown = { open: 0, save: 0, ask: [] };
    globalThis.answer = 0;
    dialog.showOpenDialog = async () => (globalThis.shown.open++, { canceled: false, filePaths: [globalThis.openPath] });
    dialog.showSaveDialog = async () => (globalThis.shown.save++, { canceled: false, filePath: globalThis.savePath });
    dialog.showMessageBox = async (_w, o) => (globalThis.shown.ask.push(o.message), { response: globalThis.answer });
  });
  const menu = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), c);
  const t = {
    app,
    win,
    menu,
    shown: () => app.evaluate(() => globalThis.shown),
    resetShown: () => app.evaluate(() => (globalThis.shown = { open: 0, save: 0, ask: [] })),
    answer: (n) => app.evaluate((_e, n) => (globalThis.answer = n), n),
    async open(f) {
      await app.evaluate((_e, f) => (globalThis.openPath = f), f);
      await menu("open");
      await win.waitForTimeout(1500);
    },
    tabs: () =>
      win.$$eval(".tabstrip .tab", (els) =>
        els.map((e) => ({ name: e.querySelector(".tab-name")?.textContent ?? "", active: e.classList.contains("active"), unsaved: e.classList.contains("unsaved") })),
      ),
    async active() {
      return (await t.tabs()).find((x) => x.active)?.name;
    },
    names: async () => (await t.tabs()).map((x) => x.name).join(", "),
    async show(name) {
      await win.click(`.tabstrip .tab:has(.tab-name:text-is("${name}"))`);
      await win.waitForTimeout(1200);
    },
    async text() {
      await win.click('.react-flow__node[data-id="q"] .tnode-title');
      return win.locator('.inspector .field:has(label:text-is("Link or text")) textarea').inputValue();
    },
    async setText(text) {
      await win.click('.react-flow__node[data-id="q"] .tnode-title');
      await win.locator('.inspector .field:has(label:text-is("Link or text")) textarea').fill(text);
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await win.waitForTimeout(1200);
    },
    async undo() {
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await menu("undo");
      await win.waitForTimeout(800);
    },
    status: () => win.evaluate(() => document.querySelector('.react-flow__node[data-id="s"] .tnode-status')?.textContent ?? ""),
    /** The QR node's picture, to tell two tabs' previews apart. */
    picture: () => win.evaluate(() => {
      const c = document.querySelector('.react-flow__node[data-id="q"] .tnode-thumb');
      return c && c.width > 0 ? c.toDataURL() : "";
    }),
    async render() {
      await menu("render");
      for (let i = 0; i < 60; i++) {
        await win.waitForTimeout(250);
        if (/Saved/.test(await t.status())) break;
      }
      await win.waitForTimeout(400);
    },
  };
  return t;
}

let t = await launch();
try {
  check("A first launch has one tab", (await t.tabs()).length === 1, await t.names());

  await t.open(fileA);
  check("A file opened over an untouched starter graph takes its tab", (await t.names()) === "alpha", await t.names());
  await t.open(fileB);
  check("Another file opens in a new tab, named after the file", (await t.names()) === "alpha, beta" && (await t.active()) === "beta", await t.names());

  // Pictures and renders: both graphs have nodes "q" and "s".
  const picB = await t.picture();
  await t.render();
  check("Render in one tab writes that tab's file", readdirSync(path.join(tmp, "out-beta")).join() === "qr.png", readdirSync(path.join(tmp, "out-beta")).join());
  await t.show("alpha");
  const picA = await t.picture();
  check("Each tab previews its own graph", !!picA && !!picB && picA !== picB);
  check("…and a Render in one tab isn't another's, even with the same node ids", (await t.status()) === "Runs on Render", await t.status());
  check("…nor did it write the other's file", readdirSync(path.join(tmp, "out-alpha")).length === 0);
  await t.show("beta");
  check("Going back shows the tab as it was", (await t.picture()) === picB && /Saved/.test(await t.status()), await t.status());

  // Undo steps per tab.
  await t.setText("beta two");
  await t.show("alpha");
  await t.setText("alpha two");
  await t.show("beta");
  await t.undo();
  check("Undo in one tab undoes that tab's change", (await t.text()) === "beta", await t.text());
  await t.show("alpha");
  check("…and leaves the other tab's alone", (await t.text()) === "alpha two", await t.text());
  await t.undo();
  check("…which has its own steps", (await t.text()) === "alpha", await t.text());

  // Save writes over the file without a dialog.
  await t.setText("alpha saved");
  check("A changed file shows a dot on its tab", (await t.tabs()).find((x) => x.name === "alpha")?.unsaved === true, JSON.stringify(await t.tabs()));
  await t.resetShown();
  await t.menu("save");
  await t.win.waitForTimeout(800);
  check("Save writes to the graph's own file", readText(fileA) === "alpha saved", readText(fileA));
  check("…without a dialog", (await t.shown()).save === 0, JSON.stringify(await t.shown()));
  check("…and the dot goes", (await t.tabs()).find((x) => x.name === "alpha")?.unsaved === false);

  // The same file again shows its tab.
  await t.show("beta");
  await t.open(fileA);
  check("Opening a file that's already open shows its tab", (await t.names()) === "alpha, beta" && (await t.active()) === "alpha", `${await t.names()}; showing ${await t.active()}`);
  // The file changed since it was opened: a tab with no changes of its own shows it as it is now…
  writeFileSync(fileB, JSON.stringify(graph("beta on disk", folder("out-beta"))));
  await t.open(fileB);
  check("A file changed since, whose tab has no changes, opens as it is now", (await t.names()) === "alpha, beta" && (await t.active()) === "beta" && (await t.text()) === "beta on disk", `${await t.names()}; ${await t.text()}`);
  // …but a tab with changes keeps them.
  await t.setText("beta mine");
  writeFileSync(fileB, JSON.stringify(graph("beta on disk again", folder("out-beta"))));
  await t.show("alpha");
  await t.open(fileB);
  check("…and a tab with changes keeps them", (await t.active()) === "beta" && (await t.text()) === "beta mine" && /with changes/.test(await t.win.locator("header .message").textContent()), await t.text());

  // Workflows.
  await t.show("alpha");
  await t.menu("workflows");
  await t.win.click('.node-menu-list button:has-text("Video to GIF")');
  await t.win.waitForTimeout(1000);
  check("A workflow opens in a new tab named after it", (await t.names()) === "alpha, Video to GIF, beta" && (await t.active()) === "Video to GIF", await t.names());
  const before = await t.win.locator(".react-flow__node").count();
  await t.menu("workflows");
  await t.win.hover('.node-menu-list li:has-text("Compress an image")');
  await t.win.click('.node-menu-list li:has-text("Compress an image") button.insert');
  await t.win.waitForTimeout(1000);
  const after = await t.win.locator(".react-flow__node").count();
  check("Insert puts a workflow into the graph on screen instead", (await t.tabs()).length === 3 && after > before, `${before} → ${after} nodes; ${await t.names()}`);

  // A new graph saved for the first time asks where, and takes the file's name.
  await t.menu("new");
  await t.win.waitForTimeout(800);
  check("New graph opens an Untitled tab", (await t.active()) === "Untitled", await t.names());
  await t.app.evaluate((_e, f) => (globalThis.savePath = f), fileC);
  await t.resetShown();
  await t.menu("save");
  await t.win.waitForTimeout(800);
  check("Saving a graph with no file asks where", (await t.shown()).save === 1 && JSON.parse(readFileSync(fileC, "utf8")).nodes.length === 3);
  check("…and the tab takes the file's name", (await t.active()) === "gamma", await t.names());

  // Closing a tab with changes asks; one without doesn't.
  await t.win.locator('.react-flow__node:has(.tnode-title:text-is("Save"))').locator(".tnode-title").click();
  await t.win.locator('.inspector .field:has(label:text-is("If the file exists")) select').selectOption("skip");
  await t.win.waitForTimeout(800);
  await t.resetShown();
  await t.answer(2); // Cancel
  await t.menu("closeTab");
  await t.win.waitForTimeout(600);
  check("Closing a tab with unsaved changes asks first", /Save changes to gamma/.test((await t.shown()).ask.join()) && (await t.names()).includes("gamma"), JSON.stringify(await t.shown()));
  await t.answer(1); // Don't save
  await t.menu("closeTab");
  await t.win.waitForTimeout(600);
  check("…and Don't save closes it", !(await t.names()).includes("gamma"), await t.names());
  await t.show("alpha");
  await t.resetShown();
  await t.menu("closeTab");
  await t.win.waitForTimeout(600);
  check("A saved tab closes without asking", (await t.shown()).ask.length === 0 && (await t.names()) === "Video to GIF, beta", await t.names());

  // Open Recent brings it back.
  const recent = await t.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.find((i) => i.label === "File").submenu.items.find((i) => i.label === "Open Recent").submenu.items.map((i) => i.label),
  );
  check("Open Recent lists the graphs opened and saved, newest first", /^gamma\.toolbox/.test(recent[0] ?? "") && recent.some((l) => l.startsWith("alpha.toolbox")) && recent.some((l) => l.startsWith("beta.toolbox")), recent.join(" | "));
  await t.app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu().items.find((i) => i.label === "File").submenu.items.find((i) => i.label === "Open Recent").submenu.items;
    items.find((i) => i.label.startsWith("alpha.toolbox")).click();
  });
  await t.win.waitForTimeout(1500);
  check("…and picking one opens it in a tab", (await t.active()) === "alpha" && (await t.text()) === "alpha saved", await t.names());

  // Left with a change, for the restart.
  await t.show("beta");
  await t.setText("beta unsaved");
  await t.win.waitForTimeout(800); // the autosave
} finally {
  await t.app.close();
}

// A restart brings every tab back, and a file on the command line opens in one more.
t = await launch([fileD]);
try {
  await t.win.waitForTimeout(1500);
  check("A restart reopens every tab, and the file it was started with", (await t.names()) === "Video to GIF, alpha, beta, delta" && (await t.active()) === "delta", await t.names());
  await t.show("beta");
  check("…with unsaved changes, still marked", (await t.text()) === "beta unsaved" && (await t.tabs()).find((x) => x.name === "beta")?.unsaved === true, await t.text());
  check("…and its pictures", !!(await t.picture()));
  await t.resetShown();
  await t.menu("save");
  await t.win.waitForTimeout(800);
  check("After a restart Save still writes to the file without a dialog", readText(fileB) === "beta unsaved" && (await t.shown()).save === 0, `${readText(fileB)}; ${JSON.stringify(await t.shown())}`);
  await t.undo();
  check("…and a restart starts each tab's undo steps afresh", (await t.text()) === "beta unsaved", await t.text());
} finally {
  await t.app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall tab checks passed");
process.exit(failed ? 1 : 0);
