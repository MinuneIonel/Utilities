import { useEffect, useRef } from "react";
import { parseSettings, type Settings } from "../../../ascii/src/engine/settings";
import { builtInPresets } from "../../../ascii/src/presets";
import { mountControls } from "../../../ascii/src/ui/controls";

/**
 * ASCII Lab's own settings panel, mounted inside the inspector.
 * Keyed by node id by the caller, so it remounts when the selection changes.
 */
export function AsciiPanel({ value, onChange }: { value: unknown; onChange: (s: Settings) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const work = useRef<Settings>(parseSettings(value));
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const syncRef = useRef<() => void>(() => {});
  const presets = useRef(builtInPresets());

  // What this panel last sent, so a change from elsewhere (undo, a preset) can be told apart.
  const sent = useRef(JSON.stringify(work.current));
  const emit = (s: Settings) => {
    sent.current = JSON.stringify(s);
    changeRef.current(structuredClone(s));
  };

  useEffect(() => {
    syncRef.current = mountControls(rootRef.current!, () => work.current, () => emit(work.current));
    return () => rootRef.current?.replaceChildren();
  }, []);

  useEffect(() => {
    const next = parseSettings(value);
    const key = JSON.stringify(next);
    if (key === sent.current) return;
    sent.current = key;
    work.current = next;
    syncRef.current();
  }, [value]);

  return (
    <div className="ascii-panel">
      <div className="field">
        <label>Preset</label>
        <select
          value=""
          onChange={(e) => {
            const p = presets.current[Number(e.target.value)];
            if (!p) return;
            work.current = structuredClone(p);
            syncRef.current();
            emit(p);
          }}
        >
          <option value="">{work.current.name}</option>
          {presets.current.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div ref={rootRef} className="controls" />
    </div>
  );
}
