import "./style.css";
import type { RestoreResult, RestoredWord } from "./engine/restore";
import { SAMPLE } from "./sample";
import type { LoadRequest, RestoreRequest, WorkerMessage } from "./worker";
import RestoreWorker from "./worker?worker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const input = $<HTMLTextAreaElement>("input");
const output = $<HTMLDivElement>("output");
const status = $<HTMLSpanElement>("status");
const popover = $<HTMLDivElement>("popover");
const keep = $<HTMLInputElement>("keep");
const showUnsure = $<HTMLInputElement>("show-unsure");
const toastEl = $<HTMLDivElement>("toast");

const STORE_TEXT = "diacritics:text";
const STORE_OPTS = "diacritics:options";
/** Below this share of belief a word counts as unsure. */
const UNSURE = 0.8;

let result: RestoreResult | null = null;
let overrides = new Map<number, string>();
let requestId = 0;
let ready = false;
let lastMs = 0;
let timer = 0;

// ---------------------------------------------------------------- worker

const worker = new RestoreWorker();
worker.postMessage({
  type: "load",
  url: new URL("model.dat", document.baseURI).href,
  neuralUrl: new URL("neural.dat", document.baseURI).href,
} satisfies LoadRequest);
worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const m = e.data;
  if (m.type === "ready") {
    ready = true;
    status.textContent = `Model ready: ${m.words.toLocaleString()} words, ${m.ambiguous.toLocaleString()} decided by context${m.neural ? ", neural helper on" : ""} (${Math.round(m.ms)} ms)`;
    schedule(0);
  } else if (m.type === "error") {
    status.textContent = `Could not load the model: ${m.message}`;
    status.classList.add("error");
  } else if (m.id === requestId) {
    result = m.result;
    lastMs = m.ms;
    render();
  }
};

function schedule(delay = 120): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    requestId++;
    const req: RestoreRequest = {
      type: "restore",
      id: requestId,
      text: input.value,
      keepExisting: keep.checked,
      overrides: [...overrides],
    };
    worker.postMessage(req);
  }, delay);
}

// ---------------------------------------------------------------- output

function isUnsure(w: RestoredWord): boolean {
  return w.alternatives.length > 1 && w.alternatives[0].p < UNSURE && w.source !== "override";
}

function render(): void {
  if (!result) return;
  const text = input.value.normalize("NFC");
  const frag = document.createDocumentFragment();
  let pos = 0;
  let changed = 0;
  let unsure = 0;
  result.words.forEach((w, i) => {
    if (w.start > pos) frag.append(text.slice(pos, w.start));
    pos = w.end;
    const span = document.createElement("span");
    span.textContent = w.output;
    span.dataset.i = String(i);
    span.className = "w";
    if (w.changed) {
      span.classList.add("changed");
      changed++;
    }
    if (isUnsure(w)) {
      span.classList.add("unsure");
      unsure++;
    }
    if (w.source === "override") span.classList.add("override");
    if (w.alternatives.length > 1) span.classList.add("choice");
    frag.append(span);
  });
  frag.append(text.slice(pos));
  output.replaceChildren(frag);
  output.classList.toggle("hide-unsure", !showUnsure.checked);

  const n = result.words.length;
  $("in-count").textContent = n ? `${n.toLocaleString()} words` : "";
  $("out-count").textContent = n ? `${changed.toLocaleString()} changed · ${unsure.toLocaleString()} unsure` : "";
  if (ready) status.textContent = n ? `Restored ${n.toLocaleString()} words in ${lastMs.toFixed(1)} ms. Click an underlined word to pick another form.` : "Type or paste text on the left.";
}

// ---------------------------------------------------------------- alternatives popover

function openPopover(span: HTMLElement): void {
  if (!result) return;
  const i = Number(span.dataset.i);
  const w = result.words[i];
  if (w.alternatives.length < 2) return;
  popover.replaceChildren();
  const current = w.output.toLowerCase();
  for (const alt of w.alternatives) {
    const b = document.createElement("button");
    b.className = "alt" + (alt.form === current ? " current" : "");
    const pct = document.createElement("span");
    pct.className = "pct";
    pct.textContent = alt.p >= 0.995 ? ">99%" : alt.p < 0.005 ? "<1%" : `${Math.round(alt.p * 100)}%`;
    b.append(matchCase(w.input, alt.form), pct);
    b.onclick = () => {
      overrides.set(i, alt.form);
      closePopover();
      schedule(0);
    };
    popover.append(b);
  }
  if (overrides.has(i)) {
    const reset = document.createElement("button");
    reset.className = "alt reset";
    reset.textContent = "Let the model decide";
    reset.onclick = () => {
      overrides.delete(i);
      closePopover();
      schedule(0);
    };
    popover.append(reset);
  }
  const r = span.getBoundingClientRect();
  popover.hidden = false;
  const pw = popover.offsetWidth;
  popover.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))}px`;
  popover.style.top = `${r.bottom + 6}px`;
}

function closePopover(): void {
  popover.hidden = true;
}

function matchCase(typed: string, form: string): string {
  const a = [...typed];
  return [...form].map((c, j) => (a[j] && a[j] !== a[j].toLowerCase() ? c.toUpperCase() : c)).join("");
}

output.addEventListener("click", (e) => {
  const span = (e.target as HTMLElement).closest<HTMLElement>(".w.choice");
  if (span) {
    e.stopPropagation();
    openPopover(span);
  }
});
document.addEventListener("click", (e) => {
  if (!popover.contains(e.target as Node)) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopover();
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    copy();
  }
});
window.addEventListener("resize", closePopover);
output.addEventListener("scroll", closePopover);

// ---------------------------------------------------------------- input and actions

let lastWordCount = -1;
input.addEventListener("input", () => {
  // word positions shift when the text is edited; forget picks if the word count changed
  const count = (input.value.match(/\p{L}+/gu) ?? []).length;
  if (count !== lastWordCount) overrides = new Map();
  lastWordCount = count;
  save();
  schedule();
});

function setText(text: string): void {
  input.value = text;
  overrides = new Map();
  save();
  schedule(0);
}

function save(): void {
  try {
    localStorage.setItem(STORE_TEXT, input.value);
    localStorage.setItem(STORE_OPTS, JSON.stringify({ keep: keep.checked, unsure: showUnsure.checked }));
  } catch {
    // storage unavailable: nothing to remember
  }
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 1600);
}

async function copy(): Promise<void> {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.text);
    toast("Copied");
  } catch {
    toast("Copy failed: select the text and copy it by hand");
  }
}

$("copy").onclick = copy;
$("download").onclick = () => {
  if (!result) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([result.text], { type: "text/plain;charset=utf-8" }));
  a.download = (fileName ?? "text").replace(/\.[^.]+$/, "") + "-diacritice.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("paste").onclick = async () => {
  try {
    setText(await navigator.clipboard.readText());
  } catch {
    input.focus();
    toast("Press ⌘/Ctrl + V to paste");
  }
};
$("sample").onclick = () => setText(SAMPLE);
$("clear").onclick = () => {
  setText("");
  input.focus();
};
keep.onchange = () => {
  save();
  schedule(0);
};
showUnsure.onchange = () => {
  save();
  render();
};

let fileName: string | null = null;
const fileInput = $<HTMLInputElement>("file");
$("open").onclick = () => fileInput.click();
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = "";
};
async function openFile(f: File): Promise<void> {
  fileName = f.name;
  setText(await f.text());
}

const drop = $("drop");
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("show");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) drop.classList.remove("show");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("show");
  const f = e.dataTransfer?.files[0];
  if (f) openFile(f);
});

// ---------------------------------------------------------------- start

try {
  const opts = JSON.parse(localStorage.getItem(STORE_OPTS) ?? "{}");
  if (typeof opts.keep === "boolean") keep.checked = opts.keep;
  if (typeof opts.unsure === "boolean") showUnsure.checked = opts.unsure;
  input.value = localStorage.getItem(STORE_TEXT) ?? SAMPLE;
} catch {
  input.value = SAMPLE;
}
lastWordCount = (input.value.match(/\p{L}+/gu) ?? []).length;
schedule(0);
