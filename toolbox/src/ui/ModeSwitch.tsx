// The Simple | Graph switch in the top bar of both views.
import type { ViewMode } from "../simple-form";

export function ModeSwitch({ mode, onMode }: { mode: ViewMode; onMode: (m: ViewMode) => void }) {
  return (
    <div className="mode-switch" role="group" aria-label="View">
      <button className={mode === "simple" ? "on" : ""} aria-pressed={mode === "simple"} onClick={() => onMode("simple")} title="Ready-made tools as simple forms">
        Simple
      </button>
      <button className={mode === "graph" ? "on" : ""} aria-pressed={mode === "graph"} onClick={() => onMode("graph")} title="Build your own chains of tools">
        Graph
      </button>
    </div>
  );
}
