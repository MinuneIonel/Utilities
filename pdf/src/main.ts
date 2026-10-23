import "./style.css";
import { inspect, PasswordError, type Bytes, type Source } from "./engine";
import { baseName, exportPdf, exportSplit } from "./exporter";
import { isPasswordError, openForRender } from "./render";
import { changed, checkpoint, fileById, onChange, redo, state, uid, undo, type FileEntry } from "./state";
import { mountEditor } from "./ui/editor";
import { deletePages, duplicatePages, forgetFile, mountGrid, rotatePages } from "./ui/grid";
import { mountPanel } from "./ui/panel";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file-input");
const imageInput = $<HTMLInputElement>("image-input");

// ---------------------------------------------------------------- views

const grid = mountGrid($<HTMLOListElement>("grid"), { onEdit: (id) => editor.open(id) });
const editor = mountEditor({ pickImage, onClose: () => changed() });
const panel = mountPanel({
  onRemoveFile: removeFile,
  onAddPages: (id) => {
    const f = fileById(id);
    if (f) appendPages(f);
  },
});

onChange(() => {
  grid.render();
  panel.render();
  const n = state.pages.length;
  const sel = state.selected.size;
  $("empty").hidden = n > 0 || state.files.length > 0;
  $("stats").textContent = n ? `${n} page${n === 1 ? "" : "s"}${sel ? ` · ${sel} selected` : ""}` : "";
  for (const id of ["rot-left", "rot-right", "dup", "del", "extract"]) {
    $<HTMLButtonElement>(id).disabled = sel === 0;
  }
  $<HTMLButtonElement>("edit").disabled = sel !== 1;
  for (const id of ["download", "preview", "download-split", "sel-all"])
    $<HTMLButtonElement>(id).disabled = n === 0;
});
changed();

// ---------------------------------------------------------------- loading files

async function addFiles(files: Iterable<File>) {
  const list = [...files];
  if (!list.length) return;
  busy("Opening…");
  try {
    for (const file of list) {
      try {
        const entry = await openFile(file);
        if (!entry) continue;
        state.files.push(entry);
        if (state.files.length === 1) panel.prefillMetadata(entry);
        appendPages(entry);
      } catch (err) {
        toast(`${file.name}: ${message(err)}`);
      }
    }
  } finally {
    busy(null);
  }
}

async function openFile(file: File): Promise<FileEntry | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = uid("f");
  if (isPdf(file, bytes)) {
    let password: string | undefined;
    for (;;) {
      try {
        const source: Source = { kind: "pdf", bytes, password };
        const [info, handle] = await Promise.all([inspect(source), openForRender(bytes, password)]);
        return { id, name: file.name, source, info, handle };
      } catch (err) {
        if (!(err instanceof PasswordError) && !isPasswordError(err)) throw err;
        const answer = prompt(`${file.name} is protected. Password:`);
        if (answer === null) return null;
        password = answer;
      }
    }
  }
  if (!file.type.startsWith("image/")) throw new Error("Not a PDF or image");
  const image = await normaliseImage(file, bytes);
  const source: Source = { kind: "image", ...image };
  return { id, name: file.name, source, info: await inspect(source), bitmap: image.bitmap };
}

function isPdf(file: File, bytes: Bytes) {
  return (
    file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name) ||
    String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-"
  );
}

/** PDFs only embed PNG and JPEG; anything else is re-encoded as PNG. */
async function normaliseImage(file: File, bytes: Bytes) {
  const bitmap = await createImageBitmap(file);
  if (file.type === "image/png" || file.type === "image/jpeg") {
    return { bytes, mime: file.type as "image/png" | "image/jpeg", bitmap };
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not convert image"))), "image/png"),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" as const, bitmap };
}

function appendPages(file: FileEntry) {
  checkpoint();
  for (let page = 0; page < file.info.pageCount; page++) {
    state.pages.push({ id: uid("p"), file: file.id, page, rotate: 0, overlays: [] });
  }
  changed();
}

function removeFile(id: string) {
  checkpoint();
  const file = fileById(id);
  state.files = state.files.filter((f) => f.id !== id);
  state.pages = state.pages.filter((p) => p.file !== id);
  delete state.forms[id];
  forgetFile(id);
  file?.handle?.loadingTask.destroy();
  for (const s of [...state.selected]) if (!state.pages.some((p) => p.id === s)) state.selected.delete(s);
  if (editor.isOpen()) editor.close();
  changed();
}

function pickImage(): Promise<number | null> {
  return new Promise((resolve) => {
    imageInput.value = "";
    imageInput.onchange = async () => {
      const file = imageInput.files?.[0];
      if (!file) return resolve(null);
      try {
        const image = await normaliseImage(file, new Uint8Array(await file.arrayBuffer()));
        state.images.push(image);
        resolve(state.images.length - 1);
      } catch (err) {
        toast(message(err));
        resolve(null);
      }
    };
    imageInput.click();
  });
}

// ---------------------------------------------------------------- export

async function run<T>(task: (progress: (m: string) => void) => Promise<T>): Promise<T | undefined> {
  busy("Working…");
  try {
    return await task((m) => busy(m));
  } catch (err) {
    toast(message(err));
    return undefined;
  } finally {
    busy(null);
  }
}

async function download() {
  const bytes = await run((p) => exportPdf(state.pages, p));
  if (bytes) save(bytes, `${baseName()}.pdf`, "application/pdf");
}

async function extract() {
  const pages = state.pages.filter((p) => state.selected.has(p.id));
  const bytes = await run((p) => exportPdf(pages, p));
  if (bytes) save(bytes, `${baseName()}-pages.pdf`, "application/pdf");
}

async function downloadSplit() {
  const zip = await run(exportSplit);
  if (zip) save(zip.bytes, zip.name, "application/zip");
}

async function preview() {
  // Open the tab now, while we still have the click, then fill it in.
  const tab = window.open("", "_blank");
  const bytes = await run((p) => exportPdf(state.pages, p));
  if (!bytes) return tab?.close();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  if (tab) tab.location.href = url;
  else window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function save(bytes: Bytes, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${name} (${formatSize(bytes.length)})`);
}

// ---------------------------------------------------------------- controls

const selectedIds = () => state.pages.filter((p) => state.selected.has(p.id)).map((p) => p.id);

$("add-files").addEventListener("click", () => fileInput.click());
$("empty-add").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files ?? []);
  fileInput.value = "";
});
$("undo").addEventListener("click", doUndo);
$("redo").addEventListener("click", doRedo);
$("download").addEventListener("click", download);
$("download-split").addEventListener("click", downloadSplit);
$("preview").addEventListener("click", preview);
$("sel-all").addEventListener("click", selectAll);
$("rot-left").addEventListener("click", () => rotatePages(selectedIds(), -90));
$("rot-right").addEventListener("click", () => rotatePages(selectedIds(), 90));
$("dup").addEventListener("click", () => duplicatePages(selectedIds(), uid));
$("del").addEventListener("click", () => deletePages(selectedIds()));
$("extract").addEventListener("click", extract);
$("edit").addEventListener("click", () => {
  const [id] = selectedIds();
  if (id) editor.open(id);
});
$<HTMLInputElement>("thumb-size").addEventListener("input", (e) => {
  $("grid").style.setProperty("--thumb", `${(e.target as HTMLInputElement).value}px`);
});

function selectAll() {
  state.selected = new Set(state.pages.map((p) => p.id));
  changed();
}

function doUndo() {
  if (undo()) editor.refresh();
}

function doRedo() {
  if (redo()) editor.refresh();
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
    e.preventDefault();
    return e.shiftKey ? doRedo() : doUndo();
  }
  if (mod && e.key.toLowerCase() === "y" && !typing(e.target)) {
    e.preventDefault();
    return doRedo();
  }
  if (typing(e.target) && e.key !== "Escape") return;
  if (editor.onKey(e)) return e.preventDefault();
  if (editor.isOpen()) return;
  if (mod && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAll();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    deletePages(selectedIds());
  } else if (e.key === "Escape") {
    state.selected.clear();
    changed();
  } else if (e.key === "Enter") {
    const [id] = selectedIds();
    if (id) editor.open(id);
  }
});

// Drop and paste files anywhere.
const drop = $("drop");
let dragDepth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  drop.classList.add("show");
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) drop.classList.remove("show");
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove("show");
  addFiles(e.dataTransfer!.files);
});
window.addEventListener("paste", (e) => {
  if (typing(e.target)) return;
  const files = e.clipboardData?.files;
  if (files?.length) addFiles(files);
});

// ---------------------------------------------------------------- feedback

const busyEl = $("busy");
function busy(text: string | null) {
  busyEl.hidden = text === null;
  if (text) $("busy-text").textContent = text;
}

let toastTimer = 0;
function toast(text: string) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3500);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
