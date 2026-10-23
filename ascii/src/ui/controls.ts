import { CHARSETS } from "../engine/charsets";
import { defaultSettings, FONTS, THEMES, type Settings } from "../engine/settings";

type Key = keyof Settings;
type Ctl =
  | { kind: "range"; key: Key; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }
  | { kind: "select"; key: Key; label: string; options: [string, string][] }
  | { kind: "check"; key: Key; label: string }
  | { kind: "text"; key: Key; label: string; placeholder?: string }
  | { kind: "color"; key: Key; label: string; transparent?: boolean }
  | { kind: "theme"; label: string };

interface Section { title: string; controls: (Ctl & { show?: (s: Settings) => boolean })[] }

const ramp = (s: Settings) => s.mode === "ramp";
const pct = (v: number) => `${Math.round(v * 100)}`;

const SECTIONS: Section[] = [
  {
    title: "Characters",
    controls: [
      { kind: "select", key: "mode", label: "Mode", options: [["ramp", "Character ramp"], ["braille", "Braille dots"]] },
      { kind: "select", key: "charset", label: "Set", options: CHARSETS.map((c) => [c.id, c.name]), show: ramp },
      { kind: "text", key: "custom", label: "Characters", placeholder: "light → dense", show: (s) => ramp(s) && s.charset === "custom" },
      { kind: "check", key: "sortByInk", label: "Sort by ink", show: ramp },
      { kind: "range", key: "edges", label: "Edge lines", min: 0, max: 1, step: 0.01, fmt: (v) => (v ? pct(v) : "off"), show: ramp },
      { kind: "check", key: "edgesOnly", label: "Edges only", show: (s) => ramp(s) && s.edges > 0 },
    ],
  },
  {
    title: "Size",
    controls: [
      { kind: "range", key: "columns", label: "Columns", min: 20, max: 400, step: 1 },
      { kind: "select", key: "font", label: "Font", options: FONTS.map((f) => [f.id, f.name]) },
      { kind: "check", key: "bold", label: "Bold" },
      { kind: "range", key: "fontSize", label: "Font size", min: 4, max: 32, step: 1, fmt: (v) => `${v}px` },
      { kind: "range", key: "lineHeight", label: "Line height", min: 0.6, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
    ],
  },
  {
    title: "Tone",
    controls: [
      { kind: "range", key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, fmt: pct },
      { kind: "range", key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01, fmt: pct },
      { kind: "range", key: "gamma", label: "Gamma", min: 0.2, max: 3, step: 0.01, fmt: (v) => v.toFixed(2) },
      { kind: "check", key: "invert", label: "Invert" },
      { kind: "check", key: "normalize", label: "Auto levels" },
      {
        kind: "select", key: "dither", label: "Dither",
        options: [["none", "None"], ["bayer", "Ordered (Bayer)"], ["floyd-steinberg", "Floyd–Steinberg"], ["atkinson", "Atkinson"]],
      },
    ],
  },
  {
    title: "Color",
    controls: [
      { kind: "theme", label: "Theme" },
      { kind: "select", key: "colorMode", label: "Ink", options: [["mono", "One color"], ["color", "Source colors"]] },
      { kind: "color", key: "fg", label: "Ink color", show: (s) => s.colorMode === "mono" },
      { kind: "range", key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01, fmt: pct, show: (s) => s.colorMode === "color" },
      { kind: "color", key: "bg", label: "Background", transparent: true },
    ],
  },
];

/** Builds the settings panel. Returns a function that re-syncs it after settings change from outside. */
export function mountControls(root: HTMLElement, get: () => Settings, onChange: () => void): () => void {
  const syncers: (() => void)[] = [];
  const set = (key: Key, v: unknown) => {
    (get() as unknown as Record<string, unknown>)[key] = v;
    onChange();
    sync();
  };
  const sync = () => syncers.forEach((f) => f());

  for (const sec of SECTIONS) {
    const card = document.createElement("section");
    card.className = "card section";
    const h = document.createElement("h2");
    h.textContent = sec.title;
    card.append(h);
    for (const ctl of sec.controls) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("label");
      label.textContent = ctl.label;
      row.append(label);
      let update: () => void = () => {};

      if (ctl.kind === "range") {
        const input = document.createElement("input");
        input.type = "range";
        Object.assign(input, { min: String(ctl.min), max: String(ctl.max), step: String(ctl.step) });
        const out = document.createElement("output");
        input.addEventListener("input", () => set(ctl.key, input.valueAsNumber));
        input.addEventListener("dblclick", () => set(ctl.key, defaultSettings()[ctl.key]));
        input.title = "Double-click to reset";
        row.append(input, out);
        update = () => {
          const v = get()[ctl.key] as number;
          input.value = String(v);
          out.textContent = ctl.fmt ? ctl.fmt(v) : String(v);
        };
      } else if (ctl.kind === "select") {
        const sel = document.createElement("select");
        ctl.options.forEach(([v, l]) => sel.append(new Option(l, v)));
        sel.addEventListener("change", () => set(ctl.key, sel.value));
        row.append(sel);
        update = () => (sel.value = String(get()[ctl.key]));
      } else if (ctl.kind === "check") {
        row.classList.add("toggle-row");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.addEventListener("change", () => set(ctl.key, input.checked));
        row.append(input);
        update = () => (input.checked = get()[ctl.key] as boolean);
      } else if (ctl.kind === "text") {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = ctl.placeholder ?? "";
        input.addEventListener("input", () => {
          (get() as unknown as Record<string, unknown>)[ctl.key] = input.value;
          onChange();
        });
        row.append(input);
        update = () => {
          if (document.activeElement !== input) input.value = String(get()[ctl.key]);
        };
      } else if (ctl.kind === "color") {
        const wrap = document.createElement("div");
        wrap.className = "color-pick";
        const input = document.createElement("input");
        input.type = "color";
        input.addEventListener("input", () => set(ctl.key, input.value));
        wrap.append(input);
        let none: HTMLInputElement | null = null;
        if (ctl.transparent) {
          const l = document.createElement("label");
          none = document.createElement("input");
          none.type = "checkbox";
          none.addEventListener("change", () => set(ctl.key, none!.checked ? "transparent" : input.value));
          l.append(none, " None");
          wrap.append(l);
        }
        row.append(wrap);
        update = () => {
          const v = get()[ctl.key] as string;
          if (v !== "transparent") input.value = v;
          if (none) none.checked = v === "transparent";
          input.disabled = v === "transparent";
        };
      } else {
        const sel = document.createElement("select");
        sel.append(new Option("Choose…", ""));
        THEMES.forEach((t, i) => sel.append(new Option(t.name, String(i))));
        sel.addEventListener("change", () => {
          const t = THEMES[Number(sel.value)];
          sel.value = "";
          if (!t) return;
          const s = get();
          s.fg = t.fg;
          s.bg = t.bg;
          s.colorMode = "mono";
          onChange();
          sync();
        });
        row.append(sel);
      }

      syncers.push(() => {
        row.hidden = ctl.show ? !ctl.show(get()) : false;
        update();
      });
      card.append(row);
    }
    root.append(card);
  }
  sync();
  return sync;
}
