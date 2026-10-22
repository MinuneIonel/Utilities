import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import "./style.css";
import {
  FORMAT_LIST,
  FORMATS,
  convertAudio,
  defaultSettings,
  estimateSize,
  isAudioFormat,
  type AudioSettings,
  type TrimRange,
} from "./engine/index.ts";
import { getFfmpeg } from "./ffmpeg.ts";

interface Track {
  id: number;
  file: File;
  duration?: number;
  channels?: number;
  sampleRate?: number;
  trim: TrimRange | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  open: $<HTMLButtonElement>("open"),
  fileInput: $<HTMLInputElement>("file-input"),
  status: $<HTMLSpanElement>("status"),
  convert: $<HTMLButtonElement>("convert"),
  convertAll: $<HTMLButtonElement>("convert-all"),
  format: $<HTMLSelectElement>("format"),
  bitrate: $<HTMLSelectElement>("bitrate"),
  bitrateRow: $<HTMLLabelElement>("bitrate-row"),
  sampleRate: $<HTMLSelectElement>("sample-rate"),
  channels: $<HTMLSelectElement>("channels"),
  estimate: $<HTMLParagraphElement>("estimate"),
  trimOn: $<HTMLInputElement>("trim-on"),
  trimStart: $<HTMLInputElement>("trim-start"),
  trimEnd: $<HTMLInputElement>("trim-end"),
  fadeIn: $<HTMLInputElement>("fade-in"),
  fadeOut: $<HTMLInputElement>("fade-out"),
  gain: $<HTMLInputElement>("gain"),
  normalize: $<HTMLInputElement>("normalize"),
  drop: $<HTMLDivElement>("drop"),
  editor: $<HTMLDivElement>("editor"),
  fileName: $<HTMLSpanElement>("file-name"),
  fileInfo: $<HTMLSpanElement>("file-info"),
  play: $<HTMLButtonElement>("play"),
  playSel: $<HTMLButtonElement>("play-sel"),
  selectAll: $<HTMLButtonElement>("select-all"),
  time: $<HTMLSpanElement>("time"),
  zoom: $<HTMLInputElement>("zoom"),
  files: $<HTMLUListElement>("files"),
  results: $<HTMLUListElement>("results"),
};

const tracks: Track[] = [];
let current: Track | null = null;
let nextId = 1;
let busy = false;

// ---------- formatting ----------

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, "0")}`;
}

/** Accepts "83.5", "1:23.5" or "0:01:23.5". */
function parseTime(text: string): number | null {
  const parts = text.trim().split(":").map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setStatus(text: string, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
}

// ---------- settings ----------

for (const f of FORMAT_LIST) ui.format.add(new Option(f.label, f.id));

function fillBitrates() {
  const def = FORMATS[ui.format.value as keyof typeof FORMATS];
  const prev = Number(ui.bitrate.value);
  ui.bitrate.replaceChildren(...def.bitrates.map((b) => new Option(`${b} kbps`, String(b))));
  ui.bitrate.value = String(def.bitrates.includes(prev) ? prev : def.defaultBitrate);
  ui.bitrateRow.hidden = !def.lossy;
}

function readSettings(trim: TrimRange | null): AudioSettings {
  const format = isAudioFormat(ui.format.value) ? ui.format.value : "mp3";
  return {
    ...defaultSettings(),
    format,
    bitrate: Number(ui.bitrate.value) || 0,
    sampleRate: ui.sampleRate.value ? Number(ui.sampleRate.value) : null,
    channels: ui.channels.value === "1" ? 1 : ui.channels.value === "2" ? 2 : null,
    trim,
    fadeIn: Math.max(0, Number(ui.fadeIn.value) || 0),
    fadeOut: Math.max(0, Number(ui.fadeOut.value) || 0),
    gainDb: Number(ui.gain.value) || 0,
    normalize: ui.normalize.checked,
  };
}

function updateEstimate() {
  if (!current) {
    ui.estimate.textContent = "";
    return;
  }
  const size = estimateSize(readSettings(current.trim), current.duration, current.channels, current.sampleRate);
  ui.estimate.textContent = size === undefined ? "" : `About ${formatBytes(Math.round(size))} (source ${formatBytes(current.file.size)})`;
}

const SETTINGS_KEY = "audio-lab-settings";
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings(null)));
  } catch {}
}
function loadSettings() {
  let s: Partial<AudioSettings> = {};
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {}
  const d = { ...defaultSettings(), ...s };
  ui.format.value = isAudioFormat(d.format) ? d.format : "mp3";
  fillBitrates();
  if (d.bitrate) ui.bitrate.value = String(d.bitrate);
  ui.sampleRate.value = d.sampleRate ? String(d.sampleRate) : "";
  ui.channels.value = d.channels ? String(d.channels) : "";
  ui.fadeIn.value = String(d.fadeIn);
  ui.fadeOut.value = String(d.fadeOut);
  ui.gain.value = String(d.gainDb);
  ui.normalize.checked = d.normalize;
}

ui.format.addEventListener("change", fillBitrates);
for (const el of [ui.format, ui.bitrate, ui.sampleRate, ui.channels, ui.fadeIn, ui.fadeOut, ui.gain, ui.normalize]) {
  el.addEventListener("change", () => {
    saveSettings();
    updateEstimate();
  });
}

// ---------- waveform & trim ----------

const regions = RegionsPlugin.create();
const wave = WaveSurfer.create({
  container: "#waveform",
  height: 128,
  waveColor: "#5b5e66",
  progressColor: "#e8ff59",
  cursorColor: "#e6e6e3",
  barWidth: 2,
  barGap: 1,
  barRadius: 1,
  normalize: true,
  plugins: [regions],
});
const REGION_COLOR = "rgba(232, 255, 89, 0.14)";
regions.enableDragSelection({ color: REGION_COLOR });

function selection(): Region | undefined {
  return regions.getRegions()[0];
}

let addingRegion = false;
function setSelection(start: number, end: number) {
  const r = selection();
  if (r) r.setOptions({ start, end });
  else {
    addingRegion = true;
    regions.addRegion({ start, end, color: REGION_COLOR });
    addingRegion = false;
  }
  syncTrimFromRegion();
}

function syncTrimFromRegion() {
  const r = selection();
  if (!current || !r) return;
  ui.trimStart.value = formatTime(r.start);
  ui.trimEnd.value = formatTime(r.end);
  current.trim = ui.trimOn.checked ? { start: r.start, end: r.end } : null;
  renderFiles();
  updateEstimate();
}

regions.on("region-created", (r) => {
  // Keep one selection: a new drag replaces the old one and switches trimming on.
  for (const other of regions.getRegions()) if (other !== r) other.remove();
  if (addingRegion) return;
  ui.trimOn.checked = true;
  syncTrimFromRegion();
});
regions.on("region-updated", syncTrimFromRegion);

ui.trimOn.addEventListener("change", () => {
  if (!current) return;
  if (ui.trimOn.checked && !selection()) setSelection(0, wave.getDuration());
  syncTrimFromRegion();
});

function onTrimInput() {
  if (!current) return;
  const start = parseTime(ui.trimStart.value);
  const end = parseTime(ui.trimEnd.value);
  const dur = wave.getDuration();
  if (start === null || end === null || end <= start) {
    syncTrimFromRegion();
    return;
  }
  ui.trimOn.checked = true;
  setSelection(Math.min(start, dur), Math.min(end, dur));
}
ui.trimStart.addEventListener("change", onTrimInput);
ui.trimEnd.addEventListener("change", onTrimInput);

wave.on("timeupdate", (t) => (ui.time.textContent = formatTime(t)));
wave.on("play", () => (ui.play.textContent = "Pause"));
wave.on("pause", () => (ui.play.textContent = "Play"));
ui.play.addEventListener("click", () => wave.playPause());
ui.playSel.addEventListener("click", () => selection()?.play(true));
ui.selectAll.addEventListener("click", () => {
  if (!current) return;
  ui.trimOn.checked = true;
  setSelection(0, wave.getDuration());
});
ui.zoom.addEventListener("input", () => wave.zoom(Number(ui.zoom.value)));

async function select(track: Track) {
  current = track;
  wave.pause();
  regions.clearRegions();
  ui.drop.hidden = true;
  ui.editor.hidden = false;
  ui.fileName.textContent = track.file.name;
  ui.fileInfo.textContent = "Decoding…";
  ui.trimOn.checked = !!track.trim;
  renderFiles();
  try {
    await wave.loadBlob(track.file);
  } catch {
    // The browser can't decode some formats (WMA, AMR, some video); ffmpeg still can convert them.
    ui.fileInfo.textContent = "No preview for this format, but it can still be converted.";
    ui.trimStart.value = ui.trimEnd.value = "";
    return;
  }
  if (current !== track) return;
  const buf = wave.getDecodedData();
  track.duration = wave.getDuration();
  track.channels = buf?.numberOfChannels;
  track.sampleRate = buf?.sampleRate;
  ui.fileInfo.textContent = `${formatTime(track.duration)} · ${track.channels === 1 ? "mono" : "stereo"} · ${formatBytes(track.file.size)}`;
  const t = track.trim ?? { start: 0, end: track.duration };
  setSelection(t.start, t.end);
  wave.zoom(Number(ui.zoom.value));
}

// ---------- file list ----------

function addFiles(files: Iterable<File>) {
  const added: Track[] = [];
  for (const file of files) {
    if (!file.type.startsWith("audio/") && !file.type.startsWith("video/") && !/\.(flac|opus|ogg|oga|m4a|aac|wav|aiff?|wma|amr|mp3|webm|mkv|mov|mp4)$/i.test(file.name)) continue;
    const t: Track = { id: nextId++, file, trim: null };
    tracks.push(t);
    added.push(t);
  }
  if (added.length) select(added[0]);
  else setStatus("Those files don't look like audio or video.", true);
}

function renderFiles() {
  ui.files.replaceChildren(
    ...tracks.map((t) => {
      const li = document.createElement("li");
      li.classList.toggle("selected", t === current);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.file.name;
      name.title = "Edit this file";
      name.addEventListener("click", () => select(t));
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = t.trim ? `${formatTime(t.trim.start)}–${formatTime(t.trim.end)}` : formatBytes(t.file.size);
      const remove = document.createElement("button");
      remove.className = "icon";
      remove.textContent = "✕";
      remove.title = "Remove from the list";
      remove.addEventListener("click", () => {
        tracks.splice(tracks.indexOf(t), 1);
        if (t === current) {
          current = null;
          if (tracks.length) select(tracks[0]);
          else {
            wave.empty();
            ui.editor.hidden = true;
            ui.drop.hidden = false;
            updateEstimate();
          }
        }
        renderFiles();
      });
      li.append(name, meta, remove);
      return li;
    }),
  );
  ui.convert.disabled = busy || !current;
  ui.convertAll.disabled = busy || tracks.length < 2;
}

function addResult(name: string, bytes: Uint8Array, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = formatBytes(bytes.length);
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "none";
  audio.src = url;
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "Download";
  li.append(label, meta, audio, link);
  ui.results.prepend(li);
  return link;
}

// ---------- conversion ----------

async function run(list: Track[]) {
  if (busy || !list.length) return;
  busy = true;
  renderFiles();
  try {
    setStatus("Loading ffmpeg…");
    const ff = await getFfmpeg();
    for (const [i, t] of list.entries()) {
      const prefix = list.length > 1 ? `${i + 1}/${list.length} ` : "";
      const onProgress = ({ progress }: { progress: number }) =>
        setStatus(`${prefix}Converting ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`);
      ff.on("progress", onProgress);
      setStatus(`${prefix}Converting…`);
      try {
        const bytes = new Uint8Array(await t.file.arrayBuffer());
        const out = await convertAudio(ff, { name: t.file.name, bytes, duration: t.duration }, readSettings(t.trim));
        const link = addResult(out.name, out.bytes, out.mime);
        if (list.length === 1) link.click();
      } finally {
        ff.off("progress", onProgress);
      }
    }
    setStatus(list.length > 1 ? `Converted ${list.length} files` : "Done");
  } catch (err) {
    console.error(err);
    setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    busy = false;
    renderFiles();
  }
}

ui.convert.addEventListener("click", () => current && run([current]));
ui.convertAll.addEventListener("click", () => run([...tracks]));

// ---------- input ----------

ui.open.addEventListener("click", () => ui.fileInput.click());
ui.drop.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", () => {
  if (ui.fileInput.files) addFiles(ui.fileInput.files);
  ui.fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) document.body.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target.matches("input, select, textarea")) return;
  if (e.code === "Space" && current) {
    e.preventDefault();
    wave.playPause();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && current) {
    run([current]);
  }
});

loadSettings();
renderFiles();
