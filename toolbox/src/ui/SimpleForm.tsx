// One workflow as a form: what to give it, a few settings, a preview, where the files go, and one
// button. Runs the workflow's graph through the same runtime as the canvas (see app/useSimple.ts).
import { useMemo, useRef, useState } from "react";
import { builtInRecipes } from "../../../dither/src/recipes";
import type { useSimple } from "../app/useSimple";
import { REGISTRY } from "../nodes";
import { bridge } from "../platform";
import type { ParamDef } from "../runtime/types";
import { formProblems, LOOK_PARAMS } from "../simple-form";
import { Field } from "./Inspector";
import { TopicIcon } from "./SimpleHome";
import { Bitmap } from "./ToolNode";

type Simple = ReturnType<typeof useSimple>;

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Dither's effect stack as a pick of its ready-made looks. */
function LookField({ label, value, set }: { label: string; value: unknown; set: (v: unknown) => void }) {
  const looks = useMemo(() => builtInRecipes(), []);
  const name = value && typeof value === "object" ? String((value as { name?: unknown }).name ?? "") : "";
  return (
    <div className="field">
      <label>{label}</label>
      <select value={looks.some((l) => l.name === name) ? name : ""} onChange={(e) => set(structuredClone(looks.find((l) => l.name === e.target.value)))}>
        {!looks.some((l) => l.name === name) && <option value="">{name || "Your own"}</option>}
        {looks.map((l) => (
          <option key={l.name} value={l.name}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function InputArea({ s }: { s: Simple }) {
  const form = s.form!;
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { kind, label, accept } = form.input;
  const p = s.inputParams ?? {};

  if (kind === "file" || kind === "files") {
    const many = kind === "files";
    const chosen = many ? (Array.isArray(p.names) ? (p.names as string[]) : []) : p.assetId ? [String(p.name ?? "")] : [];
    return (
      <div
        className={`simple-drop${over ? " over" : ""}${chosen.length ? " has" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          s.giveFiles([...e.dataTransfer.files]);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={accept}
          multiple={many}
          onChange={(e) => {
            s.giveFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button onClick={() => fileRef.current?.click()}>{chosen.length ? (many ? "Choose other files…" : "Choose another file…") : many ? "Choose files…" : "Choose a file…"}</button>
        <span className="muted">
          {chosen.length === 0 ? `or drop ${many ? "them" : "it"} here` : chosen.length === 1 ? chosen[0] : `${chosen.length} files: ${chosen.slice(0, 3).join(", ")}${chosen.length > 3 ? "…" : ""}`}
        </span>
      </div>
    );
  }
  if (kind === "link")
    return (
      <input
        type="url"
        className="simple-link"
        placeholder="https://…"
        value={s.link}
        aria-label={label ?? "Link"}
        onChange={(e) => s.setLink(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void s.run()}
      />
    );
  if (kind === "text") {
    const def = REGISTRY.get(s.nodes[form.input.node]?.data.type ?? "");
    const placeholder = String(def?.defaults().text ?? "");
    return <textarea className="simple-text" rows={6} value={String(p.text ?? "")} placeholder={placeholder} aria-label={label ?? "Text"} onChange={(e) => s.setText(e.target.value)} />;
  }
  if (kind === "camera") return <p className="muted">Your camera shows below. Press {form.action} to start and Stop to finish.</p>;
  return null;
}

/** What's running now, in the words the running step reports. */
function activity(s: Simple): string {
  if (s.recording) return "Recording…";
  const busy = Object.values(s.runtime).find((r) => r?.status === "running" && r.progressLabel);
  if (!busy) return "Working…";
  const pct = busy.progress !== undefined && busy.progress >= 0 ? ` ${Math.round(busy.progress * 100)}%` : "";
  return `${busy.progressLabel}${pct}`;
}

export function SimpleForm({ s, message, onOpenAsGraph }: { s: Simple; message: string; onOpenAsGraph: () => void }) {
  const w = s.workflow!;
  const form = w.form;
  const types = s.nodes.map((n) => n.data.type);
  const problems = formProblems(form, types, (t) => REGISTRY.get(t));
  const preview = s.previewId ? s.runtime[s.previewId] : undefined;
  // A step that failed on what was given (a file it can't read); nothing to say before there's input.
  const failed = !s.missing && !s.rendering ? Object.values(s.runtime).find((r) => r?.status === "error" && r.error) : undefined;
  const busy = s.rendering || s.recording;

  const field = (f: (typeof form.fields)[number]) => {
    const n = s.nodes[f.node];
    const def = n && REGISTRY.get(n.data.type);
    const pd = def?.params.find((d) => d.key === f.param);
    if (!n || !def || !pd) return null;
    if (!(def.visible?.(f.param, n.data.params) ?? true)) return null;
    const set = (v: unknown) => s.setField(f.node, f.param, v);
    const label = f.label ?? pd.label;
    if (pd.kind === "custom") return LOOK_PARAMS.has(`${def.type}:${f.param}`) ? <LookField key={`${f.node}.${f.param}`} label={label} value={n.data.params[f.param]} set={set} /> : null;
    return <Field key={`${f.node}.${f.param}`} def={{ ...pd, label } as ParamDef} value={n.data.params[f.param]} set={set} />;
  };

  return (
    <div className="simple-form" data-workflow={w.id}>
      <button className="link back" onClick={s.close}>
        ← All tools
      </button>
      <header className="simple-head">
        <span className={`topic t-${form.topic}`}>
          <TopicIcon topic={form.topic} />
        </span>
        <div>
          <h1>{w.title}</h1>
          <p className="muted">{form.blurb ?? w.description}</p>
        </div>
      </header>
      {problems.length > 0 && (
        <p className="simple-broken" role="alert">
          This form doesn't fit its workflow: {problems.join(" ")}
        </p>
      )}

      <section className="simple-section">
        <h2>{form.input.label ?? "Your file"}</h2>
        <InputArea s={s} />
      </section>

      {form.fields.length > 0 && (
        <section className="simple-section simple-fields">
          <h2>Settings</h2>
          {form.fields.map(field)}
        </section>
      )}

      {preview && (preview.bitmap || preview.text !== undefined || preview.info) && !s.missing && (
        <section className="simple-section simple-preview">
          {preview.bitmap ? (
            <Bitmap bitmap={preview.bitmap} className="simple-preview-img" />
          ) : preview.text !== undefined ? (
            <pre className="simple-preview-text">{preview.text}</pre>
          ) : (
            <p className="muted">{preview.info}</p>
          )}
        </section>
      )}
      {failed && <p className="simple-error">{failed.error}</p>}

      <section className="simple-section simple-save">
        {bridge ? (
          <div className="simple-folder">
            <span className="muted">Save to</span>
            <span className="path" title={s.folder}>
              {s.folder ?? "…"}
            </span>
            <button onClick={() => void s.chooseFolder()} disabled={busy}>
              Change…
            </button>
          </div>
        ) : (
          <p className="muted">Your browser saves the files in its downloads folder.</p>
        )}
        <div className="simple-go">
          {s.recording ? (
            <button className="primary rec simple-action" onClick={s.stop}>
              Stop
            </button>
          ) : (
            <button className="primary simple-action" onClick={() => void s.run()} disabled={busy || !!s.missing} title={s.missing}>
              {form.action}
            </button>
          )}
          {s.rendering && !s.recording && <button onClick={s.stop}>Stop</button>}
          <span className={busy || message ? "simple-status" : "muted simple-status"}>{busy ? activity(s) : message || s.missing || ""}</span>
        </div>
        {s.ran && !busy && s.outputs.length > 0 && (
          <ul className="simple-saved">
            {s.outputs.map((o) => (
              <li key={o.id}>
                <span className="name" title={o.savedTo}>
                  {o.name}
                </span>
                <span className="muted">{kb(o.bytes)}</span>
                {bridge ? (
                  <>
                    <button className="icon" onClick={() => void bridge!.reveal(o.savedTo)}>
                      Show in folder
                    </button>
                    <button className="icon" onClick={() => void bridge!.openPath(o.savedTo)}>
                      Open
                    </button>
                  </>
                ) : (
                  <span className="muted">in your downloads</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button className="link quiet" onClick={onOpenAsGraph} disabled={busy} title="See how this tool is built, and change anything in it">
        Open as graph
      </button>
    </div>
  );
}
