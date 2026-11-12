// Playback of the node shown behind the graph: its frames (small, paced by the worker) and its
// sound, or just the sound of an audio node. Frames are drawn straight onto the player's canvas,
// and the time goes to a small store the player reads, so playing never re-renders the window.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { REGISTRY } from "../nodes";
import type { RuntimeClient } from "../runtime/client";
import type { outputShapes } from "../runtime/evaluate";
import { needsResync, soundRate } from "../runtime/pacing";
import type { Graph, Params } from "../runtime/types";
import type { PlayMessage } from "../runtime/worker";
import type { ToolFlowNode } from "../ui/context";
import { typingIn, type Flash } from "./flow";

/** After a change while playing, playback starts again once changes stop for this long (ms). */
const RESTART_MS = 150;

export interface PlayState {
  playing: boolean;
  /** Where playback is, in seconds. */
  t: number;
  duration: number;
  /** Below 1 when the graph can't keep up with real time. */
  speed: number;
  /** Playing a sound, with no frames. */
  audioOnly: boolean;
}

/** The time and speed, for the player to show; they change with every frame. */
export class PlayStore {
  private state: PlayState = { playing: false, t: 0, duration: 0, speed: 1, audioOnly: false };
  private listeners = new Set<() => void>();
  get = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  set(patch: Partial<PlayState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

interface PlaybackDeps {
  client: RuntimeClient;
  graphRef: MutableRefObject<Graph>;
  /** Changes when params or wires change (not when nodes are only moved). */
  runKey: string;
  shapes: ReturnType<typeof outputShapes>;
  /** The node shown behind the graph, and its still picture. */
  shownId?: string;
  shownBitmap?: ImageBitmap;
  /** The video whose playhead (`at`) the shown node follows. */
  scrubbed?: ToolFlowNode;
  setParams(id: string, patch: Params): void;
  withoutHistory(change: () => void): void;
  /** Shows a node behind the graph. */
  show(id: string): void;
  flash: Flash;
  /** False while Graph view is hidden behind Simple view: playback stops and Space leaves it alone. */
  active?: boolean;
}

/** What the shown node can play: frames (a video, or a list of pictures) or a sound. Live webcams can't. */
function playableOf(graph: Graph, shapes: ReturnType<typeof outputShapes>, id: string | undefined) {
  const n = id ? graph.nodes.find((x) => x.id === id) : undefined;
  const port = n && REGISTRY.get(n.type)?.outputs[0];
  if (!n || !port) return undefined;
  const shape = shapes.get(`${n.id}:${port.key}`);
  const audio = !!shape && !shape.seq && shape.type === "audio";
  if (!audio && !(shape?.seq && (shape.type === "image" || shape.type === "grid"))) return undefined;
  const seen = new Set<string>();
  const stack = [n.id];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    const up = graph.nodes.find((m) => m.id === x);
    if (up && REGISTRY.get(up.type)?.live) return undefined;
    for (const e of graph.edges) if (e.target === x) stack.push(e.source);
  }
  return { nodeId: n.id, port: port.key, audio };
}

/** Two-tone squares of `sq` pixels, as in ui/ToolNode's Bitmap. */
function checkerboard(g: CanvasRenderingContext2D, sq: number): CanvasPattern | null {
  const tile = document.createElement("canvas");
  tile.width = tile.height = sq * 2;
  const t = tile.getContext("2d")!;
  t.fillStyle = "#2a2c30";
  t.fillRect(0, 0, sq * 2, sq * 2);
  t.fillStyle = "#1c1d20";
  t.fillRect(0, 0, sq, sq);
  t.fillRect(sq, sq, sq, sq);
  return g.createPattern(tile, "repeat");
}

export function usePlayback(d: PlaybackDeps) {
  const store = useMemo(() => new PlayStore(), []);
  const [playing, setPlaying] = useState(false);
  // The last played frame stays over the still picture after Pause, until the still catches up.
  const [covering, setCovering] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deps = useRef(d);
  deps.current = d;
  const live = useRef({
    on: false,
    /** The playback frames are taken from (0: none, or waiting to start again). */
    reqId: 0,
    restartPending: false,
    /** Where to start again after the playhead was moved while playing (0–1). */
    seekTo: undefined as number | undefined,
    startAt: 0,
    startedKey: "",
    audio: undefined as HTMLAudioElement | undefined,
    audioUrl: "",
    audioStart: 0,
    covering: false,
    stillAtPause: undefined as ImageBitmap | undefined,
  });

  const playable = useMemo(() => playableOf(d.graphRef.current, d.shapes, d.shownId), [d.graphRef, d.shapes, d.shownId, d.runKey]);
  const playableRef = useRef(playable);
  playableRef.current = playable;
  const playKey = playable ? `${playable.nodeId}:${playable.port}` : "";

  const stopAudio = useCallback(() => {
    const l = live.current;
    l.audio?.pause();
    l.audio?.removeAttribute("src");
    l.audio?.remove();
    if (l.audioUrl) URL.revokeObjectURL(l.audioUrl);
    l.audio = undefined;
    l.audioUrl = "";
  }, []);

  const start = useCallback(
    (at: number) => {
      const p = playableRef.current;
      if (!p) return;
      const l = live.current;
      stopAudio();
      l.on = true;
      l.restartPending = false;
      l.startAt = at;
      l.startedKey = deps.current.runKey;
      l.reqId = deps.current.client.play(deps.current.graphRef.current, p.nodeId, p.port, at);
      store.set({ playing: true, audioOnly: p.audio, speed: 1 });
      setPlaying(true);
    },
    [stopAudio, store],
  );

  /** Stops; `keepAt` leaves the video's playhead where it was instead of moving it to where playback got to. */
  const pause = useCallback(
    (keepAt = false) => {
      const l = live.current;
      if (!l.on) return;
      if (l.reqId) deps.current.client.stopPlay();
      l.on = false;
      l.reqId = 0;
      l.restartPending = false;
      l.seekTo = undefined;
      stopAudio();
      l.stillAtPause = deps.current.shownBitmap;
      store.set({ playing: false });
      setPlaying(false);
      const { t, duration, audioOnly } = store.get();
      const s = deps.current.scrubbed;
      // So the still preview everywhere shows where playback stopped. Not something to undo.
      if (!keepAt && s && duration > 0 && !audioOnly) {
        const at = Math.min(100, Math.round((t / duration) * 1000) / 10);
        deps.current.withoutHistory(() => deps.current.setParams(s.id, { at }));
      }
    },
    [stopAudio, store],
  );

  const startAtNow = useCallback(() => {
    const s = deps.current.scrubbed;
    const { t, duration } = store.get();
    if (s && !playableRef.current?.audio) return Number(s.data.params.at ?? 0) / 100;
    return duration > 0 && t < duration - 0.05 ? t / duration : 0;
  }, [store]);

  const toggle = useCallback(() => {
    if (live.current.on) pause();
    else start(startAtNow());
  }, [pause, start, startAtNow]);

  /** Moves the playhead, 0–1. While playing, playback carries on from there. */
  const seek = useCallback(
    (f: number) => {
      const l = live.current;
      const { duration, audioOnly } = store.get();
      if (l.on && audioOnly && l.audio) {
        l.audio.currentTime = l.audioStart + f * duration;
        store.set({ t: f * duration });
        return;
      }
      const s = deps.current.scrubbed;
      if (!s) return;
      if (l.on) {
        l.seekTo = f;
        store.set({ t: f * duration });
      }
      deps.current.setParams(s.id, { at: f * 100 });
    },
    [store],
  );

  /** Plays a node's sound from its card: shows it behind the graph first. */
  const pendingPlay = useRef<string | undefined>(undefined);
  const playNode = useCallback(
    (id: string) => {
      if (playableRef.current?.nodeId === id) return toggle();
      pendingPlay.current = id;
      deps.current.show(id);
    },
    [toggle],
  );
  useEffect(() => {
    if (playable && pendingPlay.current === playable.nodeId) {
      pendingPlay.current = undefined;
      if (live.current.on) pause(true);
      start(0);
    }
  }, [playKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another node shown, or nothing playable: stop, and start the next one from its own beginning.
  useEffect(() => {
    store.set({ t: 0, duration: 0, speed: 1 });
    live.current.covering = false;
    setCovering(false);
    return () => pause(true);
  }, [playKey, pause, store]);

  // A change while playing (a slider being tuned): stop now, start again from here once it settles.
  useEffect(() => {
    const l = live.current;
    if (!l.on || d.runKey === l.startedKey) return;
    if (l.reqId) d.client.stopPlay();
    l.reqId = 0;
    l.restartPending = true;
    l.audio?.pause();
    const timer = setTimeout(() => {
      if (!l.on || !l.restartPending) return;
      const { t, duration } = store.get();
      const at = l.seekTo ?? (duration > 0 ? t / duration : 0);
      l.seekTo = undefined;
      start(at);
    }, RESTART_MS);
    return () => clearTimeout(timer);
  }, [d.runKey, d.client, start, store]);

  // The still picture caught up with where playback stopped: show it again.
  useEffect(() => {
    const l = live.current;
    if (!playing && l.covering && d.shownBitmap !== l.stillAtPause) {
      l.covering = false;
      setCovering(false);
    }
  }, [d.shownBitmap, playing]);

  useEffect(() => {
    const client = d.client;
    let checker: CanvasPattern | null | undefined;
    const draw = (bmp: ImageBitmap, t: number) => {
      const c = canvasRef.current;
      if (!c) return;
      if (c.width !== bmp.width || c.height !== bmp.height) {
        c.width = bmp.width;
        c.height = bmp.height;
      }
      const g = c.getContext("2d")!;
      // The checkerboard the still picture has under it, so transparent areas read as transparent.
      checker ??= checkerboard(g, Math.max(4, Math.round(Math.max(bmp.width, bmp.height) / 40)));
      g.fillStyle = checker ?? "#2a2c30";
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0);
      // For the end-to-end checks.
      c.dataset.frames = String(Number(c.dataset.frames ?? 0) + 1);
      c.dataset.t = String(t);
      c.dataset.drawn = String(performance.now());
    };
    const syncSound = (t: number, speed: number) => {
      const l = live.current;
      const el = l.audio;
      if (!el) return;
      // Slowed down, the sound would only be out of step: it's left out.
      if (speed < 0.99) return void (el.paused || el.pause());
      const want = l.audioStart + t;
      if (el.paused) {
        el.currentTime = want;
        el.playbackRate = 1;
        void el.play().catch(() => undefined);
      } else if (needsResync(el.currentTime, want)) el.currentTime = want;
      // Small drift (the sound taking a moment to start) is played away rather than jumped over.
      else el.playbackRate = soundRate(el.currentTime, want);
    };
    client.onPlay = (m: PlayMessage) => {
      const l = live.current;
      if (m.reqId !== l.reqId) {
        if (m.type === "play-frame") m.bitmap.close();
        return;
      }
      if (m.type === "play-info") {
        store.set({ duration: m.duration, audioOnly: !m.frames });
        if (!m.audio) return;
        const el = new Audio();
        l.audioUrl = m.audio.blob ? URL.createObjectURL(m.audio.blob) : "";
        el.src = l.audioUrl || m.audio.url || "";
        el.preload = "auto";
        // In the page (hidden) only so the end-to-end checks can find it.
        el.className = "play-audio";
        el.hidden = true;
        document.body.append(el);
        l.audio = el;
        l.audioStart = m.audio.start;
        if (m.frames) return;
        // Just a sound: it keeps its own time.
        el.loop = true;
        el.currentTime = m.audio.start + l.startAt * m.duration;
        el.ontimeupdate = () => l.audio === el && store.set({ t: el.currentTime - l.audioStart });
        el.play().catch(() => {
          if (l.audio !== el) return;
          deps.current.flash("This sound can't play here.");
          pause(true);
        });
      } else if (m.type === "play-frame") {
        draw(m.bitmap, m.t);
        m.bitmap.close();
        client.playDrawn(m.reqId);
        store.set({ t: m.t, speed: m.speed });
        if (!l.covering) {
          l.covering = true;
          setCovering(true);
        }
        syncSound(m.t, m.speed);
      } else {
        // Stopped by Render, or it failed.
        pause(true);
        if (m.reason === "error" && m.error) deps.current.flash(m.error);
      }
    };
    return () => {
      client.onPlay = undefined;
    };
  }, [d.client, pause, store]);

  // Hiding Graph view (for Simple view) stops playback and its sound.
  useEffect(() => {
    if (d.active === false) pause(true);
  }, [d.active, pause]);

  // Space plays and pauses, unless typing, on a button, or holding it to pan the canvas.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    let armed = false;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || deps.current.active === false) return;
      const t = e.target as HTMLElement;
      if (typingIn(t) || t.closest?.("button, select, a, .node-menu, .tutorial")) return;
      armed = !!playableRef.current;
    };
    const pan = () => (armed = false);
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !armed) return;
      armed = false;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("pointerdown", pan);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("pointerdown", pan);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // The sound stops with the window.
  useEffect(() => () => stopAudio(), [stopAudio]);

  return { store, canvasRef, playing, covering, canPlay: !!playable, playingId: playing ? playable?.nodeId : undefined, toggle, seek, playNode };
}

export type Playback = ReturnType<typeof usePlayback>;
