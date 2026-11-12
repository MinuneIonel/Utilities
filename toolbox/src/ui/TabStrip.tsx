// The open graphs, one tab each, under the top bar: click to show one, × or a middle-click to
// close it, + for a new graph. A dot marks a graph with changes its file doesn't have yet.
import { MOD } from "../app/flow";
import type { TabInfo } from "../app/useDocuments";

interface TabStripProps {
  tabs: TabInfo[];
  active: string;
  /** The tab whose Render is running. */
  busy?: string;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

export function TabStrip({ tabs, active, busy, onSelect, onClose, onNew }: TabStripProps) {
  return (
    <nav className="tabstrip" role="tablist" aria-label="Open graphs">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={`tab${t.id === active ? " active" : ""}${t.unsaved ? " unsaved" : ""}`}
          title={t.path ?? `${t.name} (not saved in a file)`}
          onClick={() => onSelect(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1) onClose(t.id);
          }}
          onMouseDown={(e) => {
            // A middle-click would otherwise start scrolling.
            if (e.button === 1) e.preventDefault();
          }}
        >
          {busy === t.id && <span className="tab-busy" aria-label="rendering" />}
          <span className="tab-name">{t.name}</span>
          {t.unsaved && <span className="tab-dot" aria-label="unsaved changes" />}
          <button
            className="tab-close"
            aria-label={`Close ${t.name}`}
            title={`Close (${MOD}W)`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew} title={`New graph (${MOD}N)`} aria-label="New graph">
        +
      </button>
    </nav>
  );
}
