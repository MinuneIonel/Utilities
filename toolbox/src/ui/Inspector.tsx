import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { REGISTRY } from "../nodes";
import { formatTime, parseTime } from "../nodes/clips";
import { bridge } from "../platform";
import { hasPresets, matchingPreset, PRESET_STORE, presetParams, readPresets, withoutPreset, withPreset, type PresetBook } from "../presets";
import type { NodeDef, NodeFacts, NumberParam, ParamDef, Params } from "../runtime/types";
import { fromLog, labelParts, LOG_STOPS, pctToSeconds, pickIndex, secondsToPct, sliderRange, toLog } from "./number-scale";
import { RuntimeContext, type ToolFlowNode } from "./context";
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
      <div className="presets naming">
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
    <div className="presets">
      <select
        aria-label="My presets"
        value={match?.name ?? ""}
        title={list.length ? "Put back settings you saved for this kind of node" : "Settings you save show up here"}
        onChange={(e) => {
          const p = list.find((x) => x.name === e.target.value);
          if (p) apply(structuredClone(p.params));
        }}
      >
        <option value="">{list.length ? (match ? "" : "My presets…") : "My presets: none saved yet"}</option>
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

/**
 * The number on a slider's label line. What you type applies as you type when it's in range; anything
 * else (150 in a 0–100 box, half-typed "1" in a 36–600 box) is pulled into range on Enter or blur.
 */
function NumberBox({ def, value, set, className = "num" }: { def: NumberParam; value: number; set: (v: number) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(v)) {
      const c = Math.min(def.max, Math.max(def.min, v));
      if (c !== value) set(c);
    }
    setDraft(null);
  };
  return (
    <input
      type="number"
      className={className}
      min={def.min}
      max={def.max}
      step={def.step}
      value={draft ?? value}
      aria-label={def.label}
      onChange={(e) => {
        const v = e.target.valueAsNumber;
        const ok = Number.isFinite(v) && v >= def.min && v <= def.max;
        // Only an out-of-range or half-typed value is held back until Enter or blur.
        setDraft(ok ? null : e.target.value);
        if (ok) set(v);
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/**
 * A time in seconds, shown as m:ss.d. Takes 65.5, 1:05.5 or 1:02:03 on Enter or blur; anything
 * else goes back to the time it was.
 */
function TimeBox({ value, set, className = "time" }: { value: number; set: (v: number) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = formatTime(Number.isFinite(value) ? value : 0);
  const commit = () => {
    if (draft === null) return;
    const v = parseTime(draft);
    if (Number.isFinite(v) && v !== value && draft.trim() !== shown) set(v);
    setDraft(null);
  };
  return (
    <input
      type="text"
      className={className}
      inputMode="decimal"
      value={draft ?? shown}
      title="Minutes:seconds (1:05.5) or seconds (65.5)"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** A setting's name, its hint in grey, and on the right whatever reads or resets its value. */
function Top({ label, children, reset }: { label: string; children?: ReactNode; reset?: () => void }) {
  const { main, hint } = labelParts(label);
  return (
    <div className="field-top">
      <label title={label}>{main}</label>
      {hint && <small>{hint}</small>}
      <span className="field-gap" />
      {reset && (
        <button className="reset" onClick={reset} title="Back to the default">
          ↺
        </button>
      )}
      {children}
    </div>
  );
}

/** Picks one of the node's items by name, with a step either way. */
function Picker({ def, value, set, items, reset }: { def: NumberParam; value: unknown; set: (v: number) => void; items: string[]; reset?: () => void }) {
  const at = pickIndex(value, items.length);
  return (
    <div className="field pick-field">
      <Top label={def.label} reset={reset}>
        <span className="field-note">
          {at} of {items.length}
        </span>
      </Top>
      <div className="picker">
        <button className="step-btn" disabled={at <= 1} onClick={() => set(at - 1)} title="Previous" aria-label="Previous">
          ‹
        </button>
        <select value={at} onChange={(e) => set(Number(e.target.value))} aria-label={def.label}>
          {items.map((name, i) => (
            <option key={i} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <button className="step-btn" disabled={at >= items.length} onClick={() => set(at + 1)} title="Next" aria-label="Next">
          ›
        </button>
      </div>
    </div>
  );
}

/** A number setting: a slider fitted to what the node has seen, its value on the label line. */
function NumberField({ def, value, set, facts, params, reset }: { def: NumberParam; value: number; set: (v: unknown) => void; facts?: NodeFacts; params?: Params; reset?: () => void }) {
  const items = facts?.items;
  if (def.pick && items?.length) return <Picker def={def} value={value} set={set} items={items} reset={reset} />;
  // An item number before the node has listed its items: just the number, no 1–5000 slider.
  if (def.pick)
    return (
      <div className="field">
        <Top label={def.label} reset={reset}>
          <NumberBox def={def} value={value} set={set} />
        </Top>
      </div>
    );

  const duration = def.time ? facts?.duration : undefined;
  if (duration && duration > 0) {
    // Shown and typed as a time; still saved as a % so graphs keep working.
    const step = Math.min(def.step, Math.max(0.001, Number(((100 * 0.1) / duration).toFixed(3))));
    return (
      <div className="field">
        <Top label={def.label} reset={reset}>
          <TimeBox className="num wide" value={pctToSeconds(value, duration)} set={(s) => set(secondsToPct(s, duration, def))} />
        </Top>
        <input type="range" min={def.min} max={def.max} step={step} value={value} aria-label={def.label} onChange={(e) => set(e.target.valueAsNumber)} />
        <div className="ticks">
          <span>{formatTime(0)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    );
  }

  const { min, max, fit } = sliderRange(def, value, facts, params);
  return (
    <div className="field">
      <Top label={def.label + (def.time ? " (%)" : "")} reset={reset}>
        {fit?.note && <span className="field-note">{fit.note}</span>}
        <NumberBox def={def} value={value} set={set} />
      </Top>
      {def.log ? (
        <input
          type="range"
          min={0}
          max={LOG_STOPS}
          step={1}
          value={toLog(value, min, max, def.step)}
          aria-label={def.label}
          onChange={(e) => set(fromLog(e.target.valueAsNumber, min, max, def.step))}
        />
      ) : (
        <input type="range" min={min} max={max} step={def.step} value={value} aria-label={def.label} onChange={(e) => set(e.target.valueAsNumber)} />
      )}
      {(fit?.max !== undefined || def.log) && (
        <div className="ticks">
          <span>{def.log && min <= 0 ? "off" : min}</span>
          <span>{max}</span>
        </div>
      )}
      {!!fit?.picks?.length && (
        <div className="quick-picks">
          {fit.picks.map((q) => (
            <button key={q.label} className={q.value === value ? "on" : ""} onClick={() => set(q.value)}>
              {q.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One setting, drawn from its ParamDef. `facts` (what the node found when it last ran) fits sliders
 * and pickers to it; `fallback` is the default, which ↺ puts back. Simple view's forms use it too.
 */
export function Field({ def, value, set, facts, params, fallback }: { def: ParamDef; value: unknown; set: (v: unknown) => void; facts?: NodeFacts; params?: Params; fallback?: unknown }) {
  // Not for what the preview shows (which item, where in the video): there's no default worth going back to.
  const browsing = def.kind === "number" && (def.pick || def.time);
  const reset = !browsing && fallback !== undefined && value !== undefined && JSON.stringify(value) !== JSON.stringify(fallback) ? () => set(structuredClone(fallback)) : undefined;
  switch (def.kind) {
    case "number":
      return <NumberField def={def} value={Number(value)} set={set} facts={facts} params={params} reset={reset} />;
    case "time":
      return (
        <div className="field">
          <Top label={def.label} reset={reset} />
          <TimeBox value={Number(value)} set={set} />
        </div>
      );
    case "select":
      return (
        <div className="field">
          <Top label={def.label} reset={reset} />
          <select value={String(value)} onChange={(e) => set(e.target.value)} aria-label={def.label}>
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    case "text":
      return (
        <div className="field">
          <Top label={def.label} />
          {def.multiline ? (
            <textarea rows={10} value={String(value ?? "")} onChange={(e) => set(e.target.value)} spellCheck={false} aria-label={def.label} />
          ) : def.commit ? (
            <CommitInput value={String(value ?? "")} set={set} placeholder={def.placeholder} />
          ) : (
            <input type="text" value={String(value ?? "")} placeholder={def.placeholder} onChange={(e) => set(e.target.value)} aria-label={def.label} />
          )}
        </div>
      );
    case "toggle": {
      const { main, hint } = labelParts(def.label);
      return (
        <label className="field toggle-field" title={def.label}>
          <span>
            {main}
            {hint && <small>{hint}</small>}
          </span>
          <input type="checkbox" className="switch" checked={!!value} onChange={(e) => set(e.target.checked)} />
        </label>
      );
    }
    case "custom":
      return null;
  }
}

export function Inspector({ node, onParams, onForgetDone }: { node: ToolFlowNode | undefined; onParams: (id: string, patch: Params) => void; onForgetDone?: (id: string) => void }) {
  const runtime = useContext(RuntimeContext);
  const def = node && REGISTRY.get(node.data.type);
  const defaults = useMemo<Params>(() => def?.defaults() ?? {}, [def]);
  if (!node) return <aside className="inspector empty">Select a node to edit it.</aside>;
  if (!def) return <aside className="inspector empty">Unknown node.</aside>;
  const facts = runtime[node.id]?.facts;
  const p = node.data.params;
  const set = (key: string) => (v: unknown) => onParams(node.id, { [key]: v });
  const shown = def.params.filter((d) => def.visible?.(d.key, p) ?? true);
  const field = (d: ParamDef) => {
    if (d.kind !== "custom") return <Field key={d.key} def={d} value={p[d.key]} set={set(d.key)} facts={facts} params={p} fallback={defaults[d.key]} />;
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
      {def.type === "input.folder" && (
        <FolderField value={String(p.folder || "")} empty="None yet" browser="Folders work in the desktop app" choose={() => bridge!.chooseInputFolder()} set={(f) => onParams(node.id, { folder: f })} />
      )}
      {shown.filter((d) => !d.advanced).map(field)}
      {def.type === "input.folder" && bridge && !!p.onlyNew && !!onForgetDone && (
        <div className="field">
          <button className="forget-done" onClick={() => onForgetDone(node.id)} title="Count every file in the folder as new again">
            Forget what was done
          </button>
        </div>
      )}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary>Advanced</summary>
          {advanced.map(field)}
        </details>
      )}
      {def.saves && (
        <FolderField
          value={String(p.folder || "")}
          empty="Ask each time"
          browser="Your browser's downloads folder"
          choose={() => bridge!.chooseFolder()}
          set={(f) => onParams(node.id, { folder: f })}
        />
      )}
    </aside>
  );
}

/** A folder setting: where a Save node writes, or which folder a Folder of files reads (desktop app). */
export function FolderField({ value, empty, browser, choose, set }: { value: string; empty: string; browser: string; choose: () => Promise<string | null>; set: (folder: string) => void }) {
  return (
    <div className="field folder-field">
      <Top label="Folder" />
      {bridge ? (
        <div className="folder-row">
          <span className="path" title={value}>
            {value || empty}
          </span>
          <button
            onClick={async () => {
              const f = await choose();
              if (f) set(f);
            }}
          >
            Choose…
          </button>
          {!!value && <button onClick={() => set("")}>Clear</button>}
        </div>
      ) : (
        <span className="path">{browser}</span>
      )}
    </div>
  );
}
