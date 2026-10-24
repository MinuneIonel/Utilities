import { useEffect, useRef, useState } from "react";
import { parseRecipe, type Recipe } from "../../../dither/src/engine/recipe";
import { builtInRecipes } from "../../../dither/src/recipes";
import { mountStack } from "../../../dither/src/ui/stack";

/**
 * Dither Lab's own effect-stack editor, mounted inside the inspector.
 * Keyed by node id by the caller, so it remounts when the selection changes.
 */
export function DitherPanel({ value, onChange }: { value: unknown; onChange: (r: Recipe) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLSelectElement>(null);
  const work = useRef<Recipe>(parseRecipe(value));
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const refreshRef = useRef<() => void>(() => {});
  const [pixelSize, setPixelSize] = useState(work.current.pixelSize);
  const presets = useRef(builtInRecipes());

  const emit = () => changeRef.current(structuredClone(work.current));

  useEffect(() => {
    addRef.current!.replaceChildren(new Option("+ Add step", ""));
    const ui = mountStack(listRef.current!, addRef.current!, () => work.current, emit);
    refreshRef.current = ui.refresh;
    ui.refresh();
  }, []);

  return (
    <div className="dither-panel">
      <div className="field">
        <label>Preset</label>
        <select
          value=""
          onChange={(e) => {
            const p = presets.current[Number(e.target.value)];
            if (!p) return;
            work.current = structuredClone(p);
            setPixelSize(p.pixelSize);
            refreshRef.current();
            emit();
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
      <div className="field">
        <label>Pixel size</label>
        <input
          type="range"
          min={1}
          max={16}
          step={1}
          value={pixelSize}
          onChange={(e) => {
            work.current.pixelSize = e.target.valueAsNumber;
            setPixelSize(e.target.valueAsNumber);
            emit();
          }}
        />
        <output>{pixelSize}px</output>
      </div>
      <div className="stack-head">
        <h2>Effect stack</h2>
        <select ref={addRef} />
      </div>
      <ol ref={listRef} className="stack" />
    </div>
  );
}
