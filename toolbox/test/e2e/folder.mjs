// Folder of files check (npm run build first; on Linux under xvfb-run). A graph that names a folder
// asks before Toolbox may read it, and nothing outside it can be read. Folder of files → Encode
// image → Save (skip existing): Render writes every image (one from a sub-folder into the same
// sub-folder), and after a new file arrives writes just that one and keeps the rest. With Only new
// files the ones done before aren't even read; Forget what was done counts them as new again.
// A Save sub-folder can't lead out of its folder. Simple view's "Compress a folder of photos"
// does the same from a form, and only the new photos the second time.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const ffmpeg = require("ffmpeg-static");
const appDir = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "toolbox-folder-"));
const pics = path.join(tmp, "pics");
const out = path.join(tmp, "out");
mkdirSync(path.join(pics, "sub"), { recursive: true });
mkdirSync(out);
const picture = (file, n) => execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=160x120:rate=1`, "-vf", `drawbox=x=${n * 10}:y=10:w=20:h=20:color=red:t=fill`, "-frames:v", "1", file]);
picture(path.join(pics, "a.png"), 1);
picture(path.join(pics, "b.png"), 2);
picture(path.join(pics, "c.png"), 3);
picture(path.join(pics, "sub", "d.png"), 4);
writeFileSync(path.join(pics, "notes.txt"), "not an image");
const secret = path.join(tmp, "secret.txt");
writeFileSync(secret, "do not read");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail}` : ""}`);
};
/** Every file under a folder, as relative paths with "/". */
const ls = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? ls(path.join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]))
    .sort();

const graph = (extra = {}) => ({
  version: 1,
  nodes: [
    { id: "f", type: "input.folder", params: { folder: pics, subfolders: true, ...extra }, position: { x: 40, y: 120 } },
    { id: "e", type: "media.encode", params: { format: "jpeg", quality: 80 }, position: { x: 340, y: 120 } },
    { id: "s", type: "output.save-file", params: { name: "", folder: out, exists: "skip" }, position: { x: 640, y: 120 } },
  ],
  edges: [
    { id: "e1", source: "f", sourceHandle: "images", target: "e", targetHandle: "image" },
    { id: "e2", source: "e", sourceHandle: "file", target: "s", targetHandle: "file" },
  ],
});

let n = 0;
async function launch(profile) {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [appDir, `--user-data-dir=${profile}`, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
  });
  const win = await app.firstWindow();
  await win.waitForSelector(".canvas", { state: "attached" });
  if (await win.evaluate(() => localStorage.getItem("toolbox.tutorial") !== "1" || localStorage.getItem("toolbox.mode") !== "graph")) {
    await win.evaluate(() => {
      localStorage.setItem("toolbox.tutorial", "1");
      localStorage.setItem("toolbox.mode", "graph");
    });
    await win.reload();
    await win.waitForSelector(".canvas");
  }
  const card = (id) => win.evaluate((id) => document.querySelector(`.react-flow__node[data-id="${id}"] .tnode-status`)?.textContent ?? "", id);
  const t = {
    app,
    win,
    card,
    /** Opens a graph file, answering the question about files with `answer`; returns the questions asked. */
    async open(g, answer = 0) {
      const f = path.join(tmp, `g${Date.now()}-${n++}.toolbox`);
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
      await win.waitForTimeout(2500);
      return app.evaluate(() => globalThis.asked);
    },
    /** Waits until a card says something matching `re`. */
    async cardSays(id, re, tries = 60) {
      for (let i = 0; i < tries; i++) {
        if (re.test(await card(id))) return true;
        await win.waitForTimeout(250);
      }
      return false;
    },
    /** Renders and waits until the Save node reports. */
    async render() {
      await win.evaluate(() => {
        const el = document.querySelector('.react-flow__node[data-id="s"] .tnode-status');
        if (el) el.textContent = "";
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu", "render"));
      for (let i = 0; i < 160; i++) {
        await win.waitForTimeout(250);
        if (/Saved|Kept/.test(await card("s"))) break;
      }
      await win.waitForTimeout(800);
      return win.evaluate(() => document.querySelector(".topbar .message")?.textContent ?? "");
    },
    fetchStatus: (p) => win.evaluate((p) => fetch(`app://toolbox/@local/${encodeURIComponent(p)}`).then((r) => r.status, () => 0), p),
    /** The window came back to the front: folders are looked at again. */
    focus: () => win.evaluate(() => window.dispatchEvent(new Event("focus"))),
  };
  return t;
}

const profile = path.join(tmp, "profile");
let t = await launch(profile);
try {
  // ---------------------------------------------------------- asking first
  const asked = await t.open(graph(), 1);
  check("Opening a graph that names a folder asks first", asked.length === 1 && /uses a folder on this computer/.test(asked[0]), JSON.stringify(asked));
  check("…and Open without files leaves it unread", await t.cardSays("f", /wasn't given pics/), await t.card("f"));
  check("…the window can't read a file in it", (await t.fetchStatus(path.join(pics, "a.png"))) === 403);
  const refused = await t.win.evaluate((folder) => window.toolbox.listFolder({ folder, kind: "images", pattern: "", recursive: false }), pics);
  check("…nor list it", refused.refused === true && refused.entries.length === 0, JSON.stringify(refused));

  const again = await t.open(graph(), 0);
  check("Use them lets the folder in", again.length === 1 && (await t.cardSays("f", /^4 images in pics/)), `${JSON.stringify(again)} ${await t.card("f")}`);
  check("…files in it can be read, one in a sub-folder too", (await t.fetchStatus(path.join(pics, "a.png"))) === 200 && (await t.fetchStatus(path.join(pics, "sub", "d.png"))) === 200);
  check("…but nothing beside it", (await t.fetchStatus(secret)) === 403);
  check("…nor above it by way of ..", (await t.fetchStatus(path.join(pics, "..", "secret.txt"))) === 403 && (await t.fetchStatus(`${pics}/../secret.txt`)) === 403);
  check("…nor the folder itself", (await t.fetchStatus(pics)) !== 200);
  const third = await t.open(graph(), 1);
  check("A folder already agreed to isn't asked about again", third.length === 0, JSON.stringify(third));

  // ---------------------------------------------------------- Render, then a new file
  await t.render();
  check("Render writes every image, the sub-folder's into the same sub-folder", ls(out).join() === "a.jpg,b.jpg,c.jpg,sub/d.jpg", ls(out).join(", "));
  picture(path.join(pics, "e.png"), 5);
  const msg = await t.render();
  check("A new file: Render writes just that one", ls(out).join() === "a.jpg,b.jpg,c.jpg,e.jpg,sub/d.jpg", ls(out).join(", "));
  check("…and says it kept the 4 already there", /Saved 1 file; kept 4 files/.test(msg), msg);
  check("…and the card counts the new file", /^5 images in pics/.test(await t.card("f")), await t.card("f"));

  const sneaky = await t.win.evaluate((out) => window.toolbox.saveFile("x.txt", new Uint8Array([1]), out, { sub: "../evil" }).then(() => "saved", (e) => String(e.message)), out);
  check("A Save sub-folder can't lead out of the Save folder", /stay inside/.test(sneaky) && !existsSync(path.join(tmp, "evil")), sneaky);

  // ---------------------------------------------------------- Only new files
  await t.open(graph({ onlyNew: true }), 0);
  check("Only new files: at first every file is new", await t.cardSays("f", /^5 new of 5 in pics/), await t.card("f"));
  await t.render();
  check("…after a Render, nothing is new", await t.cardSays("f", /Nothing new in pics/), await t.card("f"));
  picture(path.join(pics, "f.png"), 6);
  await t.focus();
  check("…a file added meanwhile shows when the window comes back", await t.cardSays("f", /^1 new of 6 in pics/), await t.card("f"));
  const onlyOne = await t.render();
  // Had the old files gone through again, Save would say it kept them.
  check("…and Render does just that one, without going through the others", ls(out).length === 6 && ls(out).includes("f.jpg") && !/kept/.test(onlyOne), `${ls(out).join(", ")} / ${onlyOne}`);
  check("…then nothing is new again", await t.cardSays("f", /Nothing new in pics/), await t.card("f"));

  await t.win.click('.react-flow__node[data-id="f"] .tnode-title');
  await t.win.click(".inspector .forget-done");
  check("Forget what was done counts every file as new again", await t.cardSays("f", /^6 new of 6 in pics/), await t.card("f"));
  await t.win.waitForTimeout(800); // the autosave
} finally {
  await t.app.close();
}

t = await launch(profile);
try {
  check("After a restart the folder can still be read", (await t.fetchStatus(path.join(pics, "a.png"))) === 200 && (await t.cardSays("f", /new of 6 in pics/)), await t.card("f"));

  // ---------------------------------------------------------- Simple view
  const downloads = path.join(tmp, "Downloads");
  mkdirSync(downloads);
  const pics2 = path.join(tmp, "Holiday");
  mkdirSync(pics2);
  picture(path.join(pics2, "x1.png"), 1);
  picture(path.join(pics2, "x2.png"), 2);
  await t.app.evaluate(({ app, dialog }, { folder, downloads }) => {
    app.setPath("downloads", downloads);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, { folder: pics2, downloads });
  await t.win.evaluate(() => localStorage.setItem("toolbox.mode", "simple"));
  await t.win.reload();
  await t.win.waitForSelector(".simple-home");
  await t.win.click('.simple-tile[data-workflow="compress-folder"]');
  await t.win.waitForSelector('.simple-form[data-workflow="compress-folder"]');
  await t.win.click(".simple-input-folder button");
  const about = () => t.win.evaluate(() => document.querySelector(".simple-folder-about")?.textContent ?? "");
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    ok = /2 new of 2 in Holiday/.test(await about());
    if (!ok) await t.win.waitForTimeout(250);
  }
  check("Simple view: a folder form shows the folder's photos", ok && (await t.win.textContent(".simple-input-folder .path")) === pics2, await about());
  await t.win.waitForSelector(".simple-action:not([disabled])");
  await t.win.click(".simple-action");
  ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    ok = ls(downloads).join() === "x1.jpg,x2.jpg";
    if (!ok) await t.win.waitForTimeout(250);
  }
  check("…Compress saves each one", ok, ls(downloads).join(", "));
  picture(path.join(pics2, "x3.png"), 3);
  await t.win.waitForTimeout(1000);
  await t.win.evaluate(() => window.dispatchEvent(new Event("focus")));
  ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    ok = /1 new of 3 in Holiday/.test(await about());
    if (!ok) await t.win.waitForTimeout(250);
  }
  check("…and next time only the new photo is new", ok, await about());
  await t.win.click(".simple-action");
  ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    ok = ls(downloads).join() === "x1.jpg,x2.jpg,x3.jpg";
    if (!ok) await t.win.waitForTimeout(250);
  }
  check("…which is the one it saves", ok, ls(downloads).join(", "));
  const words = await t.win.evaluate(() => (document.querySelector(".simple")?.innerText.match(/\b(render\w*|nodes?)\b/gi) ?? []).join(", "));
  check("…without the word Render or node", !words, words);
} finally {
  await t.app.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall folder checks passed");
process.exit(failed ? 1 : 0);
