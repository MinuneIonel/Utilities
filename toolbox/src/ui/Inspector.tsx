import { REGISTRY } from "../nodes";
import { bridge } from "../platform";
import type { ParamDef, Params } from "../runtime/types";
import type { ToolFlowNode } from "./context";
import { AsciiPanel } from "./AsciiPanel";
import { DitherPanel } from "./DitherPanel";

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
        <div className="field">
          <label>{def.label}</label>
          <input type="text" value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
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

  return (
    <aside className="inspector">
      <h2>{def.title}</h2>
      <p className="hint">{def.description}</p>
      {def.params
        .filter((d) => def.visible?.(d.key, p) ?? true)
        .map((d) => {
          if (d.kind !== "custom") return <Field key={d.key} def={d} value={p[d.key]} set={set(d.key)} />;
          if (def.type === "dither.recipe") return <DitherPanel key={node.id} value={p.recipe} onChange={set("recipe")} />;
          if (def.type === "ascii.convert") return <AsciiPanel key={node.id} value={p.settings} onChange={set("settings")} />;
          return null;
        })}
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
