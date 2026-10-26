import { useEffect, useState } from "react";
import { bridge, type UpdateInfo } from "../platform";

type Stage = { at: "found" } | { at: "downloading"; fraction: number } | { at: "ready" } | { at: "manual" };

/**
 * The top bar's update button: Update to x.y.z → download progress → Restart to update.
 * When this copy can't replace itself (or the download fails) it links to the release page instead.
 */
export function UpdateButton({ update, busy, onError }: { update: UpdateInfo; busy: boolean; onError: (text: string) => void }) {
  const [stage, setStage] = useState<Stage>({ at: update.canInstall ? "found" : "manual" });
  useEffect(() => setStage({ at: update.canInstall ? "found" : "manual" }), [update]);
  useEffect(() => bridge?.onUpdateProgress((fraction) => setStage((s) => (s.at === "downloading" ? { at: "downloading", fraction } : s))), []);

  if (stage.at === "manual") {
    return (
      <a className="update" href={update.url} target="_blank" rel="noreferrer" title="Opens the download page">
        Toolbox {update.version} is out
      </a>
    );
  }
  if (stage.at === "downloading") {
    const label = stage.fraction < 0 ? "Getting it ready…" : `Downloading ${Math.round(stage.fraction * 100)}%`;
    return (
      <button className="update" disabled>
        {label}
      </button>
    );
  }
  if (stage.at === "ready") {
    return (
      <button
        className="update ready"
        disabled={busy}
        title={busy ? "Finish or cancel the render first" : "Toolbox closes, updates and opens again with your graph"}
        onClick={() => void bridge?.installUpdate().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))}
      >
        Restart to update
      </button>
    );
  }
  const download = () => {
    setStage({ at: "downloading", fraction: 0 });
    bridge!.downloadUpdate().then(
      () => setStage({ at: "ready" }),
      (e: unknown) => {
        // Electron wraps errors from the main process in "Error invoking remote method…".
        const text = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        onError(`Couldn't update: ${text}`);
        setStage({ at: "manual" });
      },
    );
  };
  return (
    <button className="update" onClick={download} title={`Downloads Toolbox ${update.version} (about 170 MB); you choose when to restart`}>
      Update to {update.version}
    </button>
  );
}
