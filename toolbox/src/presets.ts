import type { NodeDef, Params } from "./runtime/types";

/**
 * Named settings you save for one kind of node (a dither look, an encode setup) and apply
 * to any node of that kind later. Kept in local storage, by node type.
 */
export interface Preset {
  name: string;
  params: Params;
}

export type PresetBook = Record<string, Preset[]>;

export const PRESET_STORE = "toolbox.presets";

/** The settings a preset carries: the node's own params, never the files it was given. */
export function presetParams(def: Pick<NodeDef, "params" | "saves">, params: Params): Params {
  const keys = def.params.map((d) => d.key);
  if (def.saves) keys.push("folder");
  const out: Params = {};
  for (const k of keys) if (k in params) out[k] = structuredClone(params[k]);
  return out;
}

/** Whether a node of this kind has anything worth saving. */
export const hasPresets = (def: Pick<NodeDef, "params">) => def.params.length > 0;

export function readPresets(storage: Pick<Storage, "getItem"> | undefined): PresetBook {
  try {
    const raw = JSON.parse(storage?.getItem(PRESET_STORE) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const book: PresetBook = {};
    for (const [type, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      book[type] = list.filter(
        (p): p is Preset => !!p && typeof p.name === "string" && !!p.params && typeof p.params === "object",
      );
    }
    return book;
  } catch {
    return {};
  }
}

/** Adds a preset, replacing one of the same name. Returns the new book; the old one isn't changed. */
export function withPreset(book: PresetBook, type: string, preset: Preset): PresetBook {
  const list = (book[type] ?? []).filter((p) => p.name !== preset.name);
  list.push({ name: preset.name, params: structuredClone(preset.params) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { ...book, [type]: list };
}

export function withoutPreset(book: PresetBook, type: string, name: string): PresetBook {
  const list = (book[type] ?? []).filter((p) => p.name !== name);
  const next = { ...book, [type]: list };
  if (!list.length) delete next[type];
  return next;
}

/** The saved preset these settings are exactly, if any. */
export function matchingPreset(list: Preset[], current: Params): Preset | undefined {
  return list.find((p) => Object.entries(p.params).every(([k, v]) => sameValue(v, current[k])));
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (k, x: unknown) =>
    // Dither steps get a fresh id whenever a recipe is read back, so a step's id never makes it a different look.
    k === "steps" && Array.isArray(x)
      ? x.map((s: unknown) => (s && typeof s === "object" ? Object.fromEntries(Object.entries(s).filter(([key]) => key !== "id")) : s))
      : x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}
