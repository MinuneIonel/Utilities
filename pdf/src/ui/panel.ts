// Side panel: the file list, form fields and document-wide settings.

import type { FieldInfo, FieldValue } from "../engine";
import { changed, fromHex, state, toHex, type FileEntry } from "../state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface PanelOptions {
  onRemoveFile: (id: string) => void;
  onAddPages: (id: string) => void;
}

export function mountPanel(opts: PanelOptions) {
  const filesEl = $<HTMLUListElement>("files");
  const formsCard = $<HTMLDetailsElement>("forms-card");
  const formsEl = $<HTMLElement>("forms");
  let formsKey = "";

  function renderFiles() {
    $("files-empty").hidden = state.files.length > 0;
    filesEl.replaceChildren(
      ...state.files.map((f) => {
        const li = document.createElement("li");
        const used = state.pages.filter((p) => p.file === f.id).length;
        const kind = f.source.kind === "image" ? "image" : `${f.info.pageCount} p`;
        li.innerHTML = `<span class="name"></span><span class="sub">${kind}${
          used !== f.info.pageCount ? ` · ${used} used` : ""
        }</span>
          <button class="icon" data-act="add" title="Append all of this file's pages again">+</button>
          <button class="icon" data-act="remove" title="Remove this file and its pages">✕</button>`;
        li.querySelector(".name")!.textContent = f.name;
        li.title = f.name;
        li.querySelector('[data-act="add"]')!.addEventListener("click", () => opts.onAddPages(f.id));
        li.querySelector('[data-act="remove"]')!.addEventListener("click", () => opts.onRemoveFile(f.id));
        return li;
      }),
    );
  }

  function renderForms() {
    const withFields = state.files.filter((f) => f.info.fields.some(editable));
    const key = withFields.map((f) => f.id).join();
    formsCard.hidden = withFields.length === 0;
    if (key === formsKey) return;
    formsKey = key;
    formsEl.replaceChildren(...withFields.map(formFor));
  }

  function formFor(file: FileEntry) {
    const box = document.createElement("div");
    box.className = "form";
    if (state.files.length > 1) {
      const h = document.createElement("h3");
      h.textContent = file.name;
      box.append(h);
    }
    const values = (state.forms[file.id] ??= {});
    const set = (name: string, v: FieldValue) => {
      values[name] = v;
      changed();
    };
    for (const field of file.info.fields.filter(editable)) {
      const row = document.createElement("label");
      row.className = field.type === "checkbox" ? "check" : "field";
      const name = document.createElement("span");
      name.textContent = field.name;
      const current = values[field.name] ?? field.value;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (field.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = current === true;
        input.addEventListener("change", () => set(field.name, (input as HTMLInputElement).checked));
        row.append(input, name);
      } else if (field.type === "radio" || field.type === "dropdown" || field.type === "list") {
        const sel = document.createElement("select");
        sel.multiple = field.type === "list";
        if (!sel.multiple) sel.append(new Option("—", ""));
        for (const opt of field.options ?? []) {
          const o = new Option(opt, opt);
          o.selected = Array.isArray(current) ? current.includes(opt) : current === opt;
          sel.append(o);
        }
        sel.addEventListener("change", () =>
          set(field.name, sel.multiple ? [...sel.selectedOptions].map((o) => o.value) : sel.value),
        );
        input = sel;
        row.append(name, input);
      } else {
        input = document.createElement(field.multiline ? "textarea" : "input");
        input.value = String(current ?? "");
        input.addEventListener("input", () => set(field.name, input.value));
        row.append(name, input);
      }
      box.append(row);
    }
    return box;
  }

  // ---------------------------------------------------------------- settings

  const s = state.settings;
  bindCheck("flatten", (v) => (s.flattenForms = v));

  bindCheck("wm-on", (v) => (s.watermark.enabled = v));
  bindText("wm-text", (v) => (s.watermark.text = v));
  bindRange(
    "wm-size",
    (v) => (s.watermark.size = v),
    (v) => `${v}`,
  );
  bindRange(
    "wm-opacity",
    (v) => (s.watermark.opacity = v / 100),
    (v) => `${v}%`,
  );
  bindRange(
    "wm-angle",
    (v) => (s.watermark.angle = v),
    (v) => `${v}°`,
  );
  bindColor("wm-color", s.watermark.color, (c) => (s.watermark.color = c));

  bindCheck("pn-on", (v) => (s.numbers.enabled = v));
  bindText("pn-format", (v) => (s.numbers.format = v || "{n}"));
  bindSelect("pn-pos", (v) => (s.numbers.position = v as typeof s.numbers.position));
  bindRange(
    "pn-size",
    (v) => (s.numbers.size = v),
    (v) => `${v}`,
  );
  bindText("pn-start", (v) => (s.numbers.start = Number(v) || 0));

  bindText("meta-title", (v) => (s.metadata.title = v));
  bindText("meta-author", (v) => (s.metadata.author = v));
  bindText("meta-subject", (v) => (s.metadata.subject = v));
  bindText(
    "meta-keywords",
    (v) =>
      (s.metadata.keywords = v
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)),
  );

  bindCheck("pw-on", (v) => (s.protection.enabled = v));
  bindText("pw-user", (v) => (s.protection.userPassword = v));
  bindText("pw-owner", (v) => (s.protection.ownerPassword = v));
  bindCheck("pw-print", (v) => (s.protection.allowPrinting = v));
  bindCheck("pw-copy", (v) => (s.protection.allowCopying = v));
  bindCheck("pw-modify", (v) => (s.protection.allowModifying = v));

  const czMode = bindSelect("cz-mode", (v) => {
    s.compress.mode = v as typeof s.compress.mode;
    document.querySelectorAll<HTMLElement>(".row.raster").forEach((r) => (r.hidden = v !== "raster"));
  });
  czMode.dispatchEvent(new Event("change"));
  bindRange(
    "cz-dpi",
    (v) => (s.compress.dpi = v),
    (v) => `${v} dpi`,
  );
  bindRange(
    "cz-quality",
    (v) => (s.compress.quality = v / 100),
    (v) => `${v}%`,
  );

  const spMode = bindSelect("sp-mode", (v) => {
    s.split.mode = v as typeof s.split.mode;
    document.querySelector<HTMLElement>(".sp-every")!.hidden = v !== "every";
    document.querySelector<HTMLElement>(".sp-ranges")!.hidden = v !== "ranges";
  });
  spMode.dispatchEvent(new Event("change"));
  bindText("sp-n", (v) => (s.split.n = Math.max(1, Number(v) || 1)));
  bindText("sp-ranges", (v) => (s.split.ranges = v));

  /** Prefill document info from the first file that has any. */
  function prefillMetadata(file: FileEntry) {
    const m = file.info.metadata;
    const fill = (id: string, value: string | undefined, apply: () => void) => {
      const el = $<HTMLInputElement>(id);
      if (!el.value && value) {
        el.value = value;
        apply();
      }
    };
    fill("meta-title", m.title, () => (s.metadata.title = m.title));
    fill("meta-author", m.author, () => (s.metadata.author = m.author));
    fill("meta-subject", m.subject, () => (s.metadata.subject = m.subject));
    fill("meta-keywords", m.keywords?.join(", "), () => (s.metadata.keywords = m.keywords));
  }

  return {
    render() {
      renderFiles();
      renderForms();
    },
    prefillMetadata,
  };
}

const editable = (f: FieldInfo) =>
  !f.readOnly && ["text", "checkbox", "radio", "dropdown", "list"].includes(f.type);

function bindCheck(id: string, apply: (v: boolean) => void) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("change", () => {
    apply(el.checked);
    changed();
  });
  apply(el.checked);
}

function bindText(id: string, apply: (v: string) => void) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("input", () => {
    apply(el.value);
    changed();
  });
}

function bindSelect(id: string, apply: (v: string) => void) {
  const el = $<HTMLSelectElement>(id);
  el.addEventListener("change", () => {
    apply(el.value);
    changed();
  });
  return el;
}

function bindRange(id: string, apply: (v: number) => void, show: (v: number) => string) {
  const el = $<HTMLInputElement>(id);
  const out = el.nextElementSibling as HTMLOutputElement;
  const update = () => {
    apply(Number(el.value));
    out.textContent = show(Number(el.value));
  };
  el.addEventListener("input", () => {
    update();
    changed();
  });
  update();
}

function bindColor(
  id: string,
  initial: [number, number, number],
  apply: (c: [number, number, number]) => void,
) {
  const el = $<HTMLInputElement>(id);
  el.value = toHex(initial);
  el.addEventListener("input", () => {
    apply(fromHex(el.value));
    changed();
  });
}
