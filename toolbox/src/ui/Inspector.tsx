import { useEffect, useState } from "react";
import { REGISTRY } from "../nodes";
import { bridge } from "../platform";
import { hasPresets, matchingPreset, PRESET_STORE, presetParams, readPresets, withoutPreset, withPreset, type PresetBook } from "../presets";
import type { NodeDef, ParamDef, Params } from "../runtime/types";
import type { ToolFlowNode } from "./context";
import { AsciiPanel } from "./AsciiPanel";
import { DitherPanel } from "./DitherPanel";

/** A text box that only applies its value on Enter or when it loses focus (for links that start downloads). */
function CommitInput({ value, set, placeholder }: { value: string; set: (v: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && set(draft)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

const storage = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** Save the node's settings under a name, and put saved ones back with one pick (⌘Z undoes it). */
function PresetBar({ def, params, apply }: { def: NodeDef; params: Params; apply: (p: Params) => void }) {
  const [book, setBook] = useState<PresetBook>(() => readPresets(storage()));
  const [naming, setNaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Another window, or another inspector, may have saved one.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === PRESET_STORE && setBook(readPresets(storage()));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => setConfirm(false), [params]);

  const list = book[def.type] ?? [];
  const current = presetParams(def, params);
  const match = matchingPreset(list, current);
  const store = (next: PresetBook) => {
    setBook(next);
    try {
      storage()?.setItem(PRESET_STORE, JSON.stringify(next));
    } catch {
      /* full or unavailable: the preset lasts until the app closes */
    }
  };
  const save = () => {
    const name = (naming ?? "").trim();
    if (!name) return setNaming(null);
    const p = structuredClone(current);
    // Dither recipes and ASCII settings carry their own name, which their panels show.
    for (const d of def.params) {
      const v = p[d.key] as { name?: unknown } | undefined;
      if (d.kind === "custom" && v && typeof v === "object" && typeof v.name === "string") v.name = name;
    }
    store(withPreset(book, def.type, { name, params: p }));
    setNaming(null);
    apply(p);
  };

  if (naming !== null)
    return (
      <div className="field presets">
        <label>Preset name</label>
        <input
          type="text"
          autoFocus
          value={naming}
          placeholder="e.g. Grainy Game Boy"
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setNaming(null);
          }}
        />
        <span className="preset-actions">
          <button onClick={save} disabled={!naming.trim()}>
            {list.some((p) => p.name === naming.trim()) ? "Replace" : "Save"}
          </button>
          <button onClick={() => setNaming(null)}>Cancel</button>
        </span>
      </div>
    );
  return (
    <div className="field presets">
      <label>My presets</label>
      <select
        value={match?.name ?? ""}
        title={list.length ? "Put back settings you saved for this kind of node" : "Settings you save show up here"}
        onChange={(e) => {
          const p = list.find((x) => x.name === e.target.value);
          if (p) apply(structuredClone(p.params));
        }}
      >
        <option value="">{list.length ? (match ? "" : "Pick a preset…") : "None saved yet"}</option>
        {list.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="preset-actions">
        <button onClick={() => setNaming(match?.name ?? "")} title="Save these settings as a preset for every node of this kind">
          Save…
        </button>
        {match && (
          <button
            className={confirm ? "danger" : ""}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              store(withoutPreset(book, def.type, match.name));
              setConfirm(false);
            }}
            onBlur={() => setConfirm(false)}
            title={`Delete the preset “${match.name}”`}
          >
            {confirm ? "Delete?" : "Delete"}
          </button>
        )}
      </span>
    </div>
  );
}

function Field({ def, value, set }: { def: ParamDef; value: unknown; set: (v: unknown) => void }) {
  switch (def.kind) {
    case "number":
      return (
        <div className="field">
          <label>{def.label}</label>
          <input type="range" min={def.min} max={def.max} step={def.step} value={Number(value)} onChange={(e) => set(e.target.valueAsNumber)} />
          <input
            type="number"
            className="num"
            min={def.min}
            max={def.max}
            step={def.step}
            value={Number(value)}
            onChange={(e) => Number.isFinite(e.target.valueAsNumber) && set(e.target.valueAsNumber)}
          />
        </div>
      );
    case "select":
      return (
        <div className="field">
          <label>{def.label}</label>
          <select value={String(value)} onChange={(e) => set(e.target.value)}>
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "text":
      return def.multiline ? (
        <div className="field stacked">
          <label>{def.label}</label>
          <textarea rows={10} value={String(value ?? "")} onChange={(e) => set(e.target.value)} spellCheck={false} />
        </div>
      ) : (
        <div className={def.commit ? "field stacked" : "field"}>
          <label>{def.label}</label>
          {def.commit ? (
            <CommitInput value={String(value ?? "")} set={set} placeholder={def.placeholder} />
          ) : (
            <input type="text" value={String(value ?? "")} placeholder={def.placeholder} onChange={(e) => set(e.target.value)} />
          )}
        </div>
      );
    case "toggle":
      return (
        <div className="field">
          <label>{def.label}</label>
          <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        </div>
      );
    case "custom":
      return null;
  }
}

export function Inspector({ node, onParams }: { node: ToolFlowNode | undefined; onParams: (id: string, patch: Params) => void }) {
  if (!node) return <aside className="inspector empty">Select a node to edit it.</aside>;
  const def = REGISTRY.get(node.data.type);
  if (!def) return <aside className="inspector empty">Unknown node.</aside>;
  const p = node.data.params;
  const set = (key: string) => (v: unknown) => onParams(node.id, { [key]: v });
  const shown = def.params.filter((d) => def.visible?.(d.key, p) ?? true);
  const field = (d: ParamDef) => {
    if (d.kind !== "custom") return <Field key={d.key} def={d} value={p[d.key]} set={set(d.key)} />;
    if (def.type === "dither.recipe") return <DitherPanel key={node.id} value={p.recipe} onChange={set("recipe")} />;
    if (def.type === "ascii.convert") return <AsciiPanel key={node.id} value={p.settings} onChange={set("settings")} />;
    return null;
  };
  const advanced = shown.filter((d) => d.advanced);

  return (
    <aside className="inspector">
      <h2>{def.title}</h2>
      <p className="hint">{def.description}</p>
      {hasPresets(def) && <PresetBar key={def.type} def={def} params={p} apply={(patch) => onParams(node.id, patch)} />}
      {shown.filter((d) => !d.advanced).map(field)}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary>Advanced</summary>
          {advanced.map(field)}
        </details>
      )}
      {def.saves && (
        <div className="field">
          <label>Folder</label>
          {bridge ? (
            <>
              <span className="path" title={String(p.folder || "")}>
                {p.folder ? String(p.folder) : "Ask each time"}
              </span>
              <button
                onClick={async () => {
                  const f = await bridge!.chooseFolder();
                  if (f) onParams(node.id, { folder: f });
                }}
              >
                Choose…
              </button>
              {!!p.folder && <button onClick={() => onParams(node.id, { folder: "" })}>Clear</button>}
            </>
          ) : (
            <span className="path">Your browser's downloads folder</span>
          )}
        </div>
      )}
    </aside>
  );
}
