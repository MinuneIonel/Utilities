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

  useEffect(() => {
    syncRef.current = mountControls(rootRef.current!, () => work.current, () => changeRef.current(structuredClone(work.current)));
    return () => rootRef.current?.replaceChildren();
  }, []);

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
            changeRef.current(structuredClone(p));
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
