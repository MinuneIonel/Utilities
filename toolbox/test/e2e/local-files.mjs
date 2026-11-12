// Local files check (npm run build first; on Linux under xvfb-run): a graph file can't make
// Toolbox read files on this computer without asking, the files you agree to come back after a
// restart, graphs autosaved before the check still get their files, and Open file / Show in
// folder only work on files Toolbox wrote.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-local-"));
const pic = path.join(tmp, "pic.png");
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120", "-frames:v", "1", pic]);
const secret = path.join(tmp, "secret.txt");
writeFileSync(secret, "do not read");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};

const graph = {
  version: 1,
  nodes: [{ id: "i", type: "input.file", params: { path: pic, name: "pic.png" }, position: { x: 40, y: 120 } }],
  edges: [],
};

async function launch(profile) {
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
  return {
    app,
    win,
    /** Opens a graph file, answering the "uses files on this computer" question with `answer`; returns whether it was asked. */
    async open(g, answer) {
      const f = path.join(tmp, `g${Date.now()}.toolbox`);
      writeFileSync(f, JSON.stringify(g));
      await app.evaluate(({ dialog, BrowserWindow }, [f, answer]) => {
        globalThis.asked = [];
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
        dialog.showMessageBox = async (_w, o) => {
          globalThis.asked.push(o.message);
          return { response: answer };
        };
        BrowserWindow.getAllWindows()[0].webContents.send("menu", "open");
      }, [f, answer]);
      await win.waitForTimeout(2000);
      return app.evaluate(() => globalThis.asked);
    },
    fetchStatus: (p) => win.evaluate((p) => fetch(`app://toolbox/@local/${encodeURIComponent(p)}`).then((r) => r.status, () => 0), p),
    card: () => win.evaluate(() => document.querySelector('.react-flow__node[data-id="i"] .file-name')?.textContent ?? ""),
  };
}

const profile = path.join(tmp, "profile");
let t = await launch(profile);
try {
  const asked = await t.open(graph, 1);
  check("Opening a graph that names a file asks first", asked.length === 1 && /uses a file on this computer/.test(asked[0]), JSON.stringify(asked));
  check("…and Open without files leaves it out", /\(not found\)/.test(await t.card()), await t.card());
  check("…and the window can't read it", (await t.fetchStatus(pic)) === 403);
  check("A file no graph or drop gave Toolbox can't be read", (await t.fetchStatus(secret)) === 403);
  check("…nor a relative path", (await t.fetchStatus("pic.png")) === 403);

  const again = await t.open(graph, 0);
  check("Use them lets it in", again.length === 1 && (await t.fetchStatus(pic)) === 200, `${await t.card()}, status ${await t.fetchStatus(pic)}`);
  check("…and the card has its file", (await t.card()) === "pic.png", await t.card());
  const third = await t.open(graph, 1);
  check("A file already agreed to isn't asked about again", third.length === 0, JSON.stringify(third));

  const opened = await t.win.evaluate((p) => window.toolbox.openPath(p), secret);
  check("Open file refuses a file Toolbox didn't write", /didn't write/.test(opened), opened);
  const ran = await t.win.evaluate((p) => window.toolbox.runTool("t1", "ffmpeg", ["-i", "in.png", "-f", "null", "-"], { "in.png": { path: p } }).then(() => "ran", (e) => String(e.message)), secret);
  check("ffmpeg can't be handed a file Toolbox wasn't given", /wasn't given/.test(ran), ran);
  await t.win.waitForTimeout(800); // the autosave
} finally {
  await t.app.close();
}

t = await launch(profile);
try {
  await t.win.waitForTimeout(1500);
  check("After a restart the autosaved graph's file comes back", (await t.card()) === "pic.png" && (await t.fetchStatus(pic)) === 200, await t.card());
} finally {
  await t.app.close();
}

// A graph autosaved by a Toolbox from before this check: its files are adopted once.
const old = path.join(tmp, "old-profile");
t = await launch(old);
try {
  await t.win.evaluate((g) => {
    // An older Toolbox kept one graph, under toolbox.graph, and no tabs (toolbox.docs).
    localStorage.setItem("toolbox.graph", JSON.stringify(g));
    localStorage.removeItem("toolbox.docs");
    // The window autosaves its own graphs as it closes; keep the planted one.
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k !== "toolbox.graph" && k !== "toolbox.docs") set.call(this, k, v);
    };
  }, graph);
  await t.win.waitForTimeout(1500); // localStorage reaches the disk
} finally {
  await t.app.close();
}
// An older Toolbox never wrote the list.
rmSync(path.join(old, "allowed-files.json"), { force: true });
t = await launch(old);
try {
  await t.win.waitForTimeout(1500);
  check("An older autosaved graph still gets its files", (await t.card()) === "pic.png" && (await t.fetchStatus(pic)) === 200, await t.card());
  // Then a graph from someone else, opened without its file.
  const pic2 = path.join(tmp, "pic2.png");
  copyFileSync(pic, pic2);
  await t.open({ ...graph, nodes: [{ ...graph.nodes[0], params: { path: pic2, name: "pic2.png" } }] }, 1);
  await t.win.waitForTimeout(800); // the autosave
} finally {
  await t.app.close();
}
// Adopting happens once: that declined file doesn't sneak in on the next launch.
t = await launch(old);
try {
  await t.win.waitForTimeout(1500);
  check("…only once, so a file you declined stays out after a restart", /\(not found\)/.test(await t.card()) && (await t.fetchStatus(path.join(tmp, "pic2.png"))) === 403, await t.card());
} finally {
  await t.app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall local file checks passed");
process.exit(failed ? 1 : 0);
