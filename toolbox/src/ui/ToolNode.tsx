import { useContext, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { REGISTRY } from "../nodes";
import { ActionsContext, RuntimeContext, type NodeRuntime, type ToolFlowNode } from "./context";

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

function statusLine(rt: NodeRuntime | undefined): string {
  if (!rt) return "";
  if (rt.status === "running") return "Running…";
  if (rt.savedTo) return `Saved ${rt.savedTo.split(/[\\/]/).pop()}`;
  if (rt.status === "waiting" || rt.status === "error" || rt.status === "skipped") return rt.error ?? "";
  const size = rt.size ? `${rt.size.width}×${rt.size.height}` : "";
  if (rt.status === "cached") return size ? `${size} · cached` : "cached";
  return [size, rt.ms !== undefined ? `${rt.ms} ms` : ""].filter(Boolean).join(" · ");
}

export function ToolNode({ id, data, selected }: NodeProps<ToolFlowNode>) {
  const def = REGISTRY.get(data.type);
  const rt = useContext(RuntimeContext)[id];
  const actions = useContext(ActionsContext);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!def) return <div className="tnode error">Unknown node {data.type}</div>;
  const empty = def.type === "input.file" && !data.params.assetId;

  return (
    <div className={`tnode${selected ? " selected" : ""}`}>
      <div className="tnode-head">
        <span className="tnode-title">{def.title}</span>
        <span className={`badge ${def.kind}`} title={def.kind === "frame" ? "Previews live" : "Runs on Render"}>
          {def.kind === "frame" ? "live" : "render"}
        </span>
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
              <Handle type="source" position={Position.Right} id={p.key} className={`h h-${p.type}`} />
            </div>
          ))}
        </div>
      </div>
      {def.type === "input.file" && (
        <div className="tnode-file">
          <span className="file-name">{empty ? "Drop an image on the window" : String(data.params.name)}</span>
          <button className="nodrag" onClick={() => fileRef.current?.click()}>
            {empty ? "Choose…" : "Replace…"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) actions.setNodeFile(id, f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <Bitmap bitmap={rt?.bitmap} className="tnode-thumb" />
      <div className={`tnode-status s-${rt?.status ?? "idle"}`}>{statusLine(rt)}</div>
    </div>
  );
}
