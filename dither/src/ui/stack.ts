import { newStep, type Recipe, type Step } from "../engine/recipe";
import { STEP_DEFS, defaultParams, resolvePalette, stepDef, type ParamDef, type ParamValue } from "../engine/steps";
import { parseHexList } from "../engine/palettes";

export interface StackUI {
  refresh(): void;
  showPalette(colors: string[] | undefined): void;
}

/**
 * Renders the editable effect stack. `onChange` fires after every edit;
 * the recipe object is mutated in place.
 */
export function mountStack(
  list: HTMLOListElement,
  addSelect: HTMLSelectElement,
  getRecipe: () => Recipe,
  onChange: () => void,
): StackUI {
  for (const def of STEP_DEFS) {
    const o = document.createElement("option");
    o.value = def.type;
    o.textContent = def.label;
    addSelect.append(o);
  }
  addSelect.addEventListener("change", () => {
    if (!addSelect.value) return;
    const recipe = getRecipe();
    const step = newStep(addSelect.value);
    // New filters go before the first dither step, which is usually what you want.
    const di = recipe.steps.findIndex((s) => s.type === "dither");
    if (step.type !== "dither" && di >= 0) recipe.steps.splice(di, 0, step);
    else recipe.steps.push(step);
    addSelect.value = "";
    refresh();
    onChange();
  });

  let dragId: string | null = null;
  let lastPalette: string[] | undefined;

  function refresh() {
    list.replaceChildren(...getRecipe().steps.map(card));
    showPalette(lastPalette);
  }

  function card(step: Step): HTMLLIElement {
    const def = stepDef(step.type)!;
    const li = document.createElement("li");
    li.className = "card step" + (step.enabled ? "" : " off");
    li.dataset.id = step.id;

    const head = document.createElement("div");
    head.className = "step-head";
    const handle = el("span", "handle", "⋮⋮");
    handle.title = "Drag to reorder";
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      dragId = step.id;
      li.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", step.id);
      e.dataTransfer?.setDragImage(li, 20, 20);
    });
    handle.addEventListener("dragend", () => {
      dragId = null;
      li.classList.remove("dragging");
      list.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    });

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = step.enabled;
    toggle.title = "Enable step";
    toggle.addEventListener("change", () => {
      step.enabled = toggle.checked;
      li.classList.toggle("off", !step.enabled);
      onChange();
    });

    const title = el("span", "step-title", def.label);
    title.title = def.description;
    const actions = el("span", "step-actions");
    actions.append(
      iconButton("↺", "Reset to defaults", () => {
        step.params = defaultParams(step.type);
        replace();
        onChange();
      }),
      iconButton("⧉", "Duplicate", () => {
        const recipe = getRecipe();
        const copy = newStep(step.type, structuredClone(step.params));
        recipe.steps.splice(recipe.steps.indexOf(step) + 1, 0, copy);
        refresh();
        onChange();
      }),
      iconButton("✕", "Remove", () => {
        const recipe = getRecipe();
        recipe.steps.splice(recipe.steps.indexOf(step), 1);
        refresh();
        onChange();
      }),
    );
    head.append(handle, toggle, title, actions);
    li.append(head);

    const body = el("div", "step-body");
    for (const p of def.params) {
      if (def.visible && !def.visible(p.key, { ...defaultParams(step.type), ...step.params })) continue;
      body.append(control(step, p, replace));
    }
    if (step.type === "dither") {
      const strip = el("div", "result-palette");
      strip.dataset.palette = "1";
      body.append(strip);
    }
    li.append(body);

    li.addEventListener("dragover", (e) => {
      if (!dragId || dragId === step.id) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      li.classList.toggle("drop-after", after);
      li.classList.toggle("drop-before", !after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const recipe = getRecipe();
      const from = recipe.steps.findIndex((s) => s.id === dragId);
      if (from < 0) return;
      const after = li.classList.contains("drop-after");
      const [moved] = recipe.steps.splice(from, 1);
      const to = recipe.steps.indexOf(step) + (after ? 1 : 0);
      recipe.steps.splice(to, 0, moved);
      refresh();
      onChange();
    });

    function replace() {
      li.replaceWith(card(step));
      showPalette(lastPalette);
    }
    return li;
  }

  function control(step: Step, p: ParamDef, rerender: () => void): HTMLElement {
    const row = el("div", "row");
    const id = `${step.id}-${p.key}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = p.label;
    const value = step.params[p.key] ?? p.default;
    const set = (v: ParamValue, structural = false) => {
      step.params[p.key] = v;
      if (structural) rerender();
      onChange();
    };

    if (p.kind === "range") {
      const input = document.createElement("input");
      input.type = "range";
      input.id = id;
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.value = String(value);
      const out = document.createElement("output");
      out.textContent = fmt(value as number, p.step);
      input.addEventListener("input", () => {
        out.textContent = fmt(input.valueAsNumber, p.step);
        set(input.valueAsNumber);
      });
      // Double-click a slider to reset just that parameter.
      input.addEventListener("dblclick", () => {
        input.value = String(p.default);
        out.textContent = fmt(p.default, p.step);
        set(p.default);
      });
      row.append(label, input, out);
    } else if (p.kind === "toggle") {
      row.classList.add("toggle-row");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked = value as boolean;
      input.addEventListener("change", () => set(input.checked));
      row.append(label, input);
    } else if (p.kind === "select") {
      const select = document.createElement("select");
      select.id = id;
      const groups = new Map<string, HTMLElement>();
      for (const o of p.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        let parent: HTMLElement = select;
        if (o.group) {
          let g = groups.get(o.group);
          if (!g) {
            g = document.createElement("optgroup");
            (g as HTMLOptGroupElement).label = o.group;
            groups.set(o.group, g);
            select.append(g);
          }
          parent = g;
        }
        parent.append(opt);
      }
      select.value = value as string;
      select.addEventListener("change", () => set(select.value, true));
      row.append(label, select);
    } else {
      row.classList.add("colors-row");
      row.append(label, colorsEditor(value as string[], (v) => set(v, true)));
    }
    return row;
  }

  function showPalette(colors: string[] | undefined) {
    lastPalette = colors;
    const recipe = getRecipe();
    list.querySelectorAll<HTMLElement>("[data-palette]").forEach((strip) => {
      const stepId = strip.closest<HTMLElement>(".step")?.dataset.id;
      const step = recipe.steps.find((s) => s.id === stepId);
      if (!step) return;
      // Show the palette the step will use; extracted palettes come from the last render.
      const shown = step.params.palette === "extract" ? colors : resolvePalette(step.params);
      strip.replaceChildren();
      if (!shown?.length) return;
      for (const c of shown) {
        const sw = el("span", "swatch");
        sw.style.background = c;
        sw.title = c;
        strip.append(sw);
      }
      if (step.params.palette !== "custom") {
        strip.append(
          iconButton("Edit", "Copy these colors into a custom palette", () => {
            step.params.palette = "custom";
            step.params.colors = [...shown];
            refresh();
            onChange();
          }),
        );
      }
    });
  }

  refresh();
  return { refresh, showPalette };
}

function colorsEditor(colors: string[], onChange: (v: string[]) => void): HTMLElement {
  const wrap = el("div", "colors");
  const swatches = el("div", "swatches");
  colors.forEach((c, i) => {
    const sw = el("label", "swatch editable");
    sw.style.background = c;
    sw.title = `${c} (right-click to remove)`;
    const input = document.createElement("input");
    input.type = "color";
    input.value = c;
    input.addEventListener("input", () => {
      sw.style.background = input.value;
    });
    input.addEventListener("change", () => {
      const next = [...colors];
      next[i] = input.value;
      onChange(next);
    });
    sw.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (colors.length <= 2) return;
      onChange(colors.filter((_, j) => j !== i));
    });
    sw.append(input);
    swatches.append(sw);
  });
  swatches.append(
    iconButton("+", "Add a color", () => onChange([...colors, colors[colors.length - 1] ?? "#808080"])),
  );
  const paste = document.createElement("input");
  paste.type = "text";
  paste.placeholder = "Paste hex codes…";
  paste.addEventListener("change", () => {
    const parsed = parseHexList(paste.value);
    if (parsed.length >= 2) onChange(parsed);
  });
  wrap.append(swatches, paste);
  return wrap;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function fmt(v: number, step: number): string {
  return step < 1 ? v.toFixed(2) : String(v);
}
