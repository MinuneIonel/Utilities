import { useContext, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { INPUT_ACCEPT, REGISTRY } from "../nodes";
import { PlayIcon } from "./Player";
import { ActionsContext, PlayingContext, PreviewContext, RuntimeContext, ShapesContext, type NodeRuntime, type ToolFlowNode } from "./context";

export function Bitmap({ bitmap, className }: { bitmap?: ImageBitmap; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (!bitmap) {
      c.width = c.height = 0;
      return;
    }
    c.width = bitmap.width;
    c.height = bitmap.height;
    const g = c.getContext("2d")!;
    // A checkerboard under the image, so transparent areas read as transparent instead of black.
    const sq = Math.max(4, Math.round(Math.max(bitmap.width, bitmap.height) / 40));
    g.fillStyle = "#2a2c30";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#1c1d20";
    for (let y = 0; y * sq < c.height; y++) for (let x = y % 2; x * sq < c.width; x += 2) g.fillRect(x * sq, y * sq, sq, sq);
    g.drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return <canvas ref={ref} className={className} hidden={!bitmap} />;
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

function statusLine(rt: NodeRuntime | undefined): string {
  if (!rt) return "";
  if (rt.status === "running") {
    const pct = rt.progress !== undefined && rt.progress >= 0 ? ` ${Math.round(rt.progress * 100)}%` : "";
    return `${rt.progressLabel ?? "Running…"}${pct}`;
  }
  if (rt.status === "stale") return rt.error ?? "Out of date";
  if (rt.savedTo) return rt.savedTo.startsWith("Kept ") ? rt.savedTo : `Saved ${rt.savedTo.split(/[\\/]/).pop()}`;
  if (rt.status === "waiting" || rt.status === "error" || rt.status === "skipped") return rt.error ?? "";
  if (rt.fileInfo) return rt.info ?? `${rt.fileInfo.name} · ${kb(rt.fileInfo.bytes)}`;
  if (rt.info) return rt.status === "cached" ? `${rt.info} · cached` : rt.info;
  const size = rt.size
    ? `${rt.size.width}×${rt.size.height}`
    : rt.text !== undefined
      ? `${rt.text.length.toLocaleString()} chars`
      : "";
  if (rt.status === "cached") return size ? `${size} · cached` : "cached";
  return [size, rt.ms !== undefined ? `${rt.ms} ms` : ""].filter(Boolean).join(" · ");
}

export function ToolNode({ id, data, selected }: NodeProps<ToolFlowNode>) {
  const def = REGISTRY.get(data.type);
  const rt = useContext(RuntimeContext)[id];
  const actions = useContext(ActionsContext);
  const shapes = useContext(ShapesContext);
  const previewed = useContext(PreviewContext) === id;
  const playing = useContext(PlayingContext) === id;
  const fileRef = useRef<HTMLInputElement>(null);
  if (!def) return <div className="tnode error">Unknown node {data.type}</div>;
  const accept = INPUT_ACCEPT[def.type];
  const multiple = def.type === "input.images";
  const empty = !!accept && !(multiple ? (data.params.assetIds as unknown[] | undefined)?.length : data.params.assetId);
  // An input waiting for its file or link is a normal state, not an error.
  const waitingForInput = def.category === "input" && (empty || (def.type === "input.download" && !String(data.params.url ?? "").trim()));
  const status = waitingForInput ? (accept ? "" : "Paste a link in the inspector") : statusLine(rt);
  // Job nodes only run on Render. A Save node offers to save again once it has saved; others can be run on their own.
  const job = def.kind === "job";
  const savedOnce = !!rt?.savedTo || (Array.isArray(data.params.lastSaved) && data.params.lastSaved.length > 0);
  // A sound can be played from its card, once there is one (a job's last render, even out of date).
  const out = def.outputs[0] && shapes.get(`${id}:${def.outputs[0].key}`);
  const sound = !!actions.play && out?.type === "audio" && !out.seq && (rt?.status === "ok" || rt?.status === "cached" || rt?.status === "stale");

  return (
    <div className={`tnode${job ? " job" : ""}${selected ? " selected" : ""}`}>
      <div className="tnode-head">
        <span className="tnode-title">{def.title}</span>
        {def.saves && savedOnce && (
          <button
            className="nodrag save-now"
            onClick={(e) => {
              e.stopPropagation();
              actions.saveNode(id);
            }}
            title="Render just what feeds this node and save it, even if it hasn't changed"
          >
            Save again
          </button>
        )}
        {job && !def.saves && (
          <button
            className={`nodrag save-now run-now${rt?.status === "stale" ? " stale" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              actions.runNode(id);
            }}
            title="Render just what feeds this node to see its result, without writing files"
          >
            Run
          </button>
        )}
        {sound && (
          <button
            className={`nodrag preview-toggle play-now${playing ? " on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              actions.play?.(id);
            }}
            title={playing ? "Pause" : "Play this sound"}
            aria-label={playing ? "Pause" : "Play"}
          >
            <PlayIcon playing={playing} />
          </button>
        )}
        <button
          className={`nodrag preview-toggle${previewed ? " on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            actions.togglePreview(id);
          }}
          title={previewed ? "Stop showing this node in the background (⌥-click the node)" : "Show this node in the background (⌥-click the node)"}
          aria-pressed={previewed}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="2.2" fill="currentColor" />
          </svg>
        </button>
      </div>
      <div className="tnode-ports">
        <div>
          {def.inputs.map((p) => (
            <div className="port in" key={p.key}>
              <Handle type="target" position={Position.Left} id={p.key} className={`h h-${p.type}`} />
              {p.label}
            </div>
          ))}
        </div>
        <div>
          {def.outputs.map((p) => (
            <div className="port out" key={p.key}>
              {p.label}
              <Handle type="source" position={Position.Right} id={p.key} className={`h h-${shapes.get(`${id}:${p.key}`)?.seq ? "video" : p.type}`} />
            </div>
          ))}
        </div>
      </div>
      {accept && (
        <div className="tnode-file">
          <span className="file-name">{empty ? (data.params.path ? `${String(data.params.name)} (not found)` : "Drop a file here") : String(data.params.name)}</span>
          <button className="nodrag" onClick={() => fileRef.current?.click()}>
            {empty ? "Choose…" : "Replace…"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            multiple={multiple}
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (multiple && files.length) actions.setNodeFiles(id, files);
              else if (files[0]) actions.setNodeFile(id, files[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <Bitmap bitmap={rt?.bitmap} className={`tnode-thumb${rt?.status === "stale" ? " stale" : ""}`} />
      {rt?.text !== undefined && !rt.bitmap && <pre className="tnode-text">{rt.text.slice(0, 600)}</pre>}
      {rt?.status === "running" && rt.progress !== undefined && (
        <div className={`tnode-progress${rt.progress < 0 ? " busy" : ""}`}>
          <div style={{ width: `${Math.max(0, rt.progress) * 100}%` }} />
        </div>
      )}
      {(status || !waitingForInput) && <div className={`tnode-status s-${waitingForInput ? "idle" : (rt?.status ?? "idle")}`}>{status}</div>}
    </div>
  );
}
