// The player on the backdrop: Play/Pause, the playhead, the time, and a note when the graph is too
// slow for real time. Played frames are drawn onto PlayerFrame, over the still picture.
import { useSyncExternalStore } from "react";
import type { Playback } from "../app/usePlayback";
import { clockText } from "../runtime/pacing";
import type { ToolFlowNode } from "./context";

/** Where played frames are drawn, the same size on screen as the still picture under it. */
export function PlayerFrame({ playback, size }: { playback: Playback; size?: { width: number; height: number } }) {
  return (
    <canvas
      ref={playback.canvasRef}
      className="backdrop-img play-frame"
      hidden={!playback.covering}
      style={size ? { width: size.width, height: size.height } : undefined}
    />
  );
}

export function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" /> : <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />}
    </svg>
  );
}

export function Player({ playback, scrubbed, stale }: { playback: Playback; scrubbed?: ToolFlowNode; stale?: boolean }) {
  const s = useSyncExternalStore(playback.store.subscribe, playback.store.get);
  if (!playback.canPlay && !scrubbed) return null;
  const at = Number(scrubbed?.data.params.at ?? 0);
  const pos = s.playing && s.duration > 0 ? (s.t / s.duration) * 100 : at;
  const slider = !!scrubbed || (s.playing && s.audioOnly);
  return (
    <div className="player" data-playing={s.playing ? "1" : undefined}>
      {playback.canPlay && (
        <button className="play-toggle" onClick={playback.toggle} title={s.playing ? "Pause (Space)" : "Play (Space)"} aria-label={s.playing ? "Pause" : "Play"}>
          <PlayIcon playing={s.playing} />
        </button>
      )}
      {slider ? (
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={pos}
          onChange={(e) => playback.seek(e.target.valueAsNumber / 100)}
          title="Playhead: the frame every live node previews"
        />
      ) : (
        <span className="player-fill" />
      )}
      {playback.canPlay && s.duration > 0 && (
        <span className="play-time">
          {clockText(s.t)} / {clockText(s.duration)}
        </span>
      )}
      {s.playing && s.speed < 0.99 && (
        <span className="play-note" title="The graph can't keep up with real time, so it plays slower (without sound)">
          {s.speed.toFixed(1)}× speed
        </span>
      )}
      {stale && <span className="play-note">Out of date: Render to update</span>}
    </div>
  );
}
