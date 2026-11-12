// The bar along the top: graph buttons, undo and redo, the message line, and Render.
import { MOD, type Flash } from "../app/flow";
import type { UpdateInfo } from "../platform";
import { UpdateButton } from "./UpdateButton";
import logoUrl from "../../build/icon.svg?url";

interface TopBarProps {
  commands: Record<string, () => void>;
  canUndo: boolean;
  canRedo: boolean;
  message: string;
  update: UpdateInfo | null;
  rendering: boolean;
  recording: boolean;
  downloading: boolean;
  hasSave: boolean;
  stale: boolean;
  flash: Flash;
  onHelp: () => void;
  onCancel: () => void;
  onStopDownloads: () => void;
  onStopRecording: () => void;
  onRender: () => void;
}

export function TopBar(p: TopBarProps) {
  const c = p.commands;
  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src={logoUrl} alt="" /> TOOLBOX
      </div>
      <div className="group">
        <button onClick={() => c.new()}>New graph</button>
        <button className="add-node" onClick={() => c.addNode()} title="Add a node (Tab, or right-click the canvas)">
          Add node <kbd>Tab</kbd>
        </button>
        <button className="workflows" onClick={() => c.workflows()} title="Drop in a ready-made chain, like downloading a video">
          Workflows
        </button>
        <button onClick={() => c.open()}>Open graph</button>
        <button onClick={() => c.save()}>Save graph</button>
        <button className="undo" onClick={() => c.undo()} disabled={!p.canUndo} title={`Undo (${MOD}Z)`} aria-label="Undo">
          ↶
        </button>
        <button className="redo" onClick={() => c.redo()} disabled={!p.canRedo} title={`Redo (${MOD === "⌘" ? "⇧⌘Z" : "Ctrl+Y"})`} aria-label="Redo">
          ↷
        </button>
      </div>
      <div className="message">{p.message}</div>
      <div className="group right">
        {p.update && <UpdateButton update={p.update} busy={p.rendering || p.recording} onError={p.flash} />}
        <button className="help" onClick={p.onHelp} title="Show the tutorial again">
          ?
        </button>
        {p.rendering && <button onClick={p.onCancel}>Cancel</button>}
        {!p.rendering && p.downloading && (
          <button onClick={p.onStopDownloads} title="Stop downloading the link. Render downloads it again.">
            Stop download
          </button>
        )}
        {p.recording ? (
          <button className="primary rec" onClick={p.onStopRecording} title="Stop recording and write the files">
            Stop
          </button>
        ) : (
          <button className="primary" onClick={p.onRender} disabled={p.rendering} title={`Render and save what changed (${MOD}R)${p.stale ? ". Some results are out of date." : ""}`}>
            {p.rendering ? "Rendering…" : p.hasSave ? "Render & save" : "Render"}
            {p.stale && !p.rendering && <span className="stale-dot" aria-label="out of date" />}
          </button>
        )}
      </div>
    </header>
  );
}
