import { useContext, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { INPUT_ACCEPT, REGISTRY } from "../nodes";
import { ActionsContext, PreviewContext, RuntimeContext, ShapesContext, type NodeRuntime, type ToolFlowNode } from "./context";

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
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
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
  if (rt.savedTo) return `Saved ${rt.savedTo.split(/[\\/]/).pop()}`;
  if (rt.status === "waiting" || rt.status === "error" || rt.status === "skipped") return rt.error ?? "";
  if (rt.fileInfo) return `${rt.fileInfo.name} · ${kb(rt.fileInfo.bytes)}`;
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
  const fileRef = useRef<HTMLInputElement>(null);
  if (!def) return <div className="tnode error">Unknown node {data.type}</div>;
  const accept = INPUT_ACCEPT[def.type];
  const multiple = def.type === "input.images";
  const empty = !!accept && !(multiple ? (data.params.assetIds as unknown[] | undefined)?.length : data.params.assetId);
  // A frame node fed a video runs on every frame; its outputs are videos too.
  const mapped = def.outputs.some((p) => p.type !== "video" && shapes.get(`${id}:${p.key}`)?.seq);

  return (
    <div className={`tnode${selected ? " selected" : ""}`}>
      <div className="tnode-head">
        <span className="tnode-title">{def.title}</span>
        {mapped && (
          <span className="badge frames" title="Runs on every frame of the video wired into it">
            frames
          </span>
        )}
        <span className={`badge ${def.kind}`} title={def.kind === "frame" ? "Previews live" : "Runs on Render"}>
          {def.kind === "frame" ? "live" : "render"}
        </span>
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
          <span className="file-name">{empty ? "Drop a file on the window" : String(data.params.name)}</span>
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
      <Bitmap bitmap={rt?.bitmap} className="tnode-thumb" />
      {rt?.text !== undefined && !rt.bitmap && <pre className="tnode-text">{rt.text.slice(0, 600)}</pre>}
      {rt?.status === "running" && rt.progress !== undefined && (
        <div className={`tnode-progress${rt.progress < 0 ? " busy" : ""}`}>
          <div style={{ width: `${Math.max(0, rt.progress) * 100}%` }} />
        </div>
      )}
      <div className={`tnode-status s-${rt?.status ?? "idle"}`}>{statusLine(rt)}</div>
    </div>
  );
}
