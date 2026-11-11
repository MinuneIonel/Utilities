// The Outputs tray along the bottom: the last files Render wrote.
import type { OutputEntry } from "../app/flow";
import { bridge } from "../platform";

export function OutputsTray({ outputs, onClear }: { outputs: OutputEntry[]; onClear: () => void }) {
  return (
    <footer className="tray">
      <strong>Outputs</strong>
      {outputs.length === 0 && <span className="muted">Rendered files show up here.</span>}
      {outputs.map((o) => (
        <span key={o.id} className="out-item" title={o.savedTo}>
          {bridge ? (
            <button className="link" onClick={() => void bridge!.openPath(o.savedTo)} title={`Open ${o.savedTo}`}>
              {o.name}
            </button>
          ) : (
            o.name
          )}
          <span className="muted">{(o.bytes / 1024).toFixed(0)} KB</span>
          {bridge && (
            <button className="icon" onClick={() => bridge!.reveal(o.savedTo)}>
              Show
            </button>
          )}
        </span>
      ))}
      {outputs.length > 0 && (
        <button className="icon clear" onClick={onClear} title="Clear this list (the files stay)">
          Clear
        </button>
      )}
    </footer>
  );
}
