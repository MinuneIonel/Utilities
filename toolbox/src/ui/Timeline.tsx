// The timeline under the canvas: a filmstrip or waveform of the video or sound a node's times are in,
// with a ruler, the playhead, and handles for the node's Start and End, cut times or parts. Every
// drag writes the node's params (so ⌘Z undoes it); the strip itself comes from the worker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Playback } from "../app/usePlayback";
import type { TimelineState } from "../app/useTimeline";
import { formatTime } from "../nodes/clips";
import type { Params } from "../runtime/types";
import {
  atOfTime,
  editMarks,
  editParts,
  effectiveRange,
  panSpan,
  playheadTime,
  rangeValue,
  rulerTicks,
  snapTime,
  tOf,
  timelineMarks,
  xOf,
  zoomSpan,
  type Span,
  type TimeRange,
} from "../timeline";
import type { ToolFlowNode } from "./context";
import { PlayIcon } from "./Player";

/** What's selected, for the arrow keys and Delete. Marks go by time: they're kept in order, so their places change. */
type Selection = { kind: "start" | "end" } | { kind: "mark"; t: number } | { kind: "part"; index: number } | undefined;

type Drag =
  | { kind: "range"; which: "start" | "end" }
  | { kind: "mark"; marks: number[]; index: number }
  | { kind: "part-edge"; parts: TimeRange[]; index: number; edge: "start" | "end" }
  | { kind: "part-move"; parts: TimeRange[]; index: number; from: number }
  | { kind: "new-part"; parts: TimeRange[]; from: number; x: number; made: boolean }
  | { kind: "scrub" }
  | { kind: "pan"; x: number; span: Span };

interface Props {
  tl: TimelineState;
  playback: Playback;
  /** The video whose playhead the node behind the graph follows. */
  scrubbed?: ToolFlowNode;
  shownId?: string;
  setParams(id: string, patch: Params): void;
  collapsed: boolean;
  onToggle(): void;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.006;

export function Timeline({ tl, playback, scrubbed, shownId, setParams, collapsed, onToggle }: Props) {
  const { target, def, source, ts, strip } = tl;
  const play = useSyncExternalStore(playback.store.subscribe, playback.store.get);
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const duration = strip?.duration ?? 0;
  const [span, setSpan] = useState<Span>({ t0: 0, t1: 1 });
  const [sel, setSel] = useState<Selection>();
  const [hover, setHover] = useState<number | undefined>();
  const drag = useRef<Drag | undefined>(undefined);

  // A new strip (or a new length) shows all of it, with nothing selected.
  useEffect(() => {
    setSpan({ t0: 0, t1: duration || 1 });
    setSel(undefined);
  }, [strip?.key, duration]);
  useEffect(() => setSel(undefined), [target?.id]);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [collapsed]);

  const params = target?.data.params ?? {};
  const marks = useMemo(() => timelineMarks(def?.timeline, params, duration), [def, params, duration]);

  // The playhead: the source's Playhead % (within the part it keeps), or where playback is.
  const srcParams = source?.data.params ?? {};
  const hasAt = "at" in srcParams && ts?.source.port === "video";
  const kept = ts?.whole && source?.data.type === "input.video" ? effectiveRange(srcParams.start, srcParams.end, duration) : undefined;
  const speed = Number(srcParams.speed) > 0 ? Number(srcParams.speed) : 1;
  const followsPlay = play.playing && (hasAt ? scrubbed?.id === source?.id && !play.audioOnly : play.audioOnly && !!shownId && [target?.id, ts?.base.id, ts?.source.id].includes(shownId));
  const playhead = followsPlay ? (kept ? kept.start + play.t * speed : play.t) : hasAt ? playheadTime(srcParams.at, duration, kept) : undefined;

  // The pictures, drawn for the part of the strip in view.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !width) return;
    const h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, h);
    if (!strip || !(duration > 0)) return;
    if (strip.wave) {
      const w = strip.wave;
      const sx = (span.t0 / duration) * w.width;
      const sw = ((span.t1 - span.t0) / duration) * w.width;
      g.imageSmoothingEnabled = true;
      g.drawImage(w, sx, 0, sw, w.height, 0, 0, width, h);
    }
    const n = strip.count;
    for (let i = 0; i < n; i++) {
      const bmp = strip.thumbs[i];
      if (!bmp) continue;
      const x0 = xOf((i * duration) / n, span, width);
      const x1 = xOf(((i + 1) * duration) / n, span, width);
      if (x1 < 0 || x0 > width) continue;
      // Each picture fills its slot, cropped to keep its shape; zoomed in, it repeats along the slot.
      const tileW = Math.max(1, Math.min(x1 - x0, h * (bmp.width / bmp.height)));
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, h);
      g.clip();
      for (let x = x0; x < x1; x += tileW) {
        const scale = Math.max(tileW / bmp.width, h / bmp.height);
        const sw = tileW / scale;
        const sh = h / scale;
        g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, x, 0, tileW, h);
      }
      g.restore();
    }
  }, [strip, span, width, duration, collapsed]);

  // Wheel: zoom around the pointer (sideways scrolling pans). Not passive, so the page doesn't scroll.
  useEffect(() => {
    const el = stripRef.current?.parentElement;
    if (!el || !(duration > 0)) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setSpan((s) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return panSpan(s, (e.deltaX / r.width) * (s.t1 - s.t0), duration);
        return zoomSpan(s, tOf(e.clientX - r.left, s, r.width), Math.exp(e.deltaY * 0.002), duration);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [duration, collapsed]);

  if (!target || !ts) return null;

  const tAt = (clientX: number) => {
    const r = stripRef.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, tOf(clientX - r.left, span, r.width)));
  };
  const set = (patch: Params) => setParams(target.id, patch);
  const tlDef = def?.timeline;

  const scrub = (t: number) => {
    if (hasAt && source) {
      const at = atOfTime(t, duration, kept);
      if (scrubbed?.id === source.id) playback.seek(at / 100);
      else setParams(source.id, { at });
    } else if (play.playing && play.audioOnly && duration > 0) playback.seek(t / duration);
  };

  const setRange = (which: "start" | "end", t: number) => {
    if (!tlDef?.range || !marks.range) return;
    set({ [tlDef.range[which]]: rangeValue(which, t, marks.range, duration) });
  };

  const start = (e: React.PointerEvent, d: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).closest(".timeline")?.querySelector<HTMLElement>(".timeline-body")?.focus({ preventScroll: true });
    drag.current = d;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = snapTime(tAt(e.clientX), e.shiftKey);
    if (d.kind === "range") setRange(d.which, t);
    else if (d.kind === "mark" && tlDef?.marks) {
      set({ [tlDef.marks]: editMarks(d.marks, d.index, t) });
      setSel({ kind: "mark", t: Math.round(t * 100) / 100 });
    } else if (d.kind === "part-edge" && tlDef?.parts) {
      const p = d.parts[d.index];
      set({ [tlDef.parts]: editParts(d.parts, d.index, d.edge === "start" ? { start: Math.min(t, p.end - 0.1), end: p.end } : { start: p.start, end: Math.max(t, p.start + 0.1) }) });
    } else if (d.kind === "part-move" && tlDef?.parts) {
      const p = d.parts[d.index];
      const len = p.end - p.start;
      const s = Math.min(duration - len, Math.max(0, snapTime(p.start + tAt(e.clientX) - d.from, e.shiftKey)));
      set({ [tlDef.parts]: editParts(d.parts, d.index, { start: s, end: s + len }) });
    } else if (d.kind === "new-part" && tlDef?.parts) {
      if (!d.made && Math.abs(e.clientX - d.x) < 4) return;
      d.made = true;
      set({ [tlDef.parts]: editParts(d.parts, -1, { start: d.from, end: t }) });
      setSel({ kind: "part", index: d.parts.length });
    } else if (d.kind === "scrub") scrub(tAt(e.clientX));
    else if (d.kind === "pan") {
      const w = stripRef.current?.clientWidth || 1;
      setSpan(panSpan(d.span, (-(e.clientX - d.x) / w) * (d.span.t1 - d.span.t0), duration));
    }
  };
  const end = () => {
    drag.current = undefined;
    window.removeEventListener("pointermove", move);
  };

  const step = strip?.kind === "audio" || !(strip?.fps && strip.fps > 0) ? 0.1 : 1 / strip.fps;
  const markIndex = sel?.kind === "mark" ? (marks.marks ?? []).findIndex((m) => near(m, sel.t)) : -1;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dt = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : step);
      e.preventDefault();
      if ((sel?.kind === "start" || sel?.kind === "end") && marks.range) setRange(sel.kind, marks.range[sel.kind] + dt);
      else if (sel?.kind === "mark" && markIndex >= 0 && tlDef?.marks) {
        const t = Math.min(duration, Math.max(0, marks.marks![markIndex] + dt));
        set({ [tlDef.marks]: editMarks(marks.marks!, markIndex, t) });
        setSel({ kind: "mark", t: Math.round(t * 100) / 100 });
      } else if (sel?.kind === "part" && marks.parts?.[sel.index] && tlDef?.parts) {
        const p = marks.parts[sel.index];
        const s = Math.min(duration - (p.end - p.start), Math.max(0, p.start + dt));
        set({ [tlDef.parts]: editParts(marks.parts, sel.index, { start: s, end: s + p.end - p.start }) });
      } else if (playhead !== undefined) scrub(Math.min(duration, Math.max(0, playhead + dt)));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // Never the node: the canvas would delete it otherwise.
      e.preventDefault();
      e.stopPropagation();
      if (sel?.kind === "mark" && markIndex >= 0 && tlDef?.marks) set({ [tlDef.marks]: editMarks(marks.marks!, markIndex, undefined) });
      else if (sel?.kind === "part" && marks.parts?.[sel.index] && tlDef?.parts) set({ [tlDef.parts]: editParts(marks.parts, sel.index, undefined) });
      setSel(undefined);
    } else if (e.key === "Escape") setSel(undefined);
  };

  const x = (t: number) => xOf(t, span, width);
  /** A stretch of time on the strip, cut to the part in view. */
  const seg = (a: number, b: number) => {
    const l = Math.max(0, x(a));
    return { left: l, width: Math.max(0, Math.min(width, x(b)) - l) };
  };
  const ticks = width > 0 && duration > 0 ? rulerTicks(span, width) : { step: 1, times: [] };
  const removed: TimeRange[] = [];
  if (marks.kept) {
    let at = 0;
    for (const r of [...marks.kept].sort((a, b) => a.start - b.start)) {
      if (r.start > at) removed.push({ start: at, end: r.start });
      at = Math.max(at, r.end);
    }
    if (at < duration) removed.push({ start: at, end: duration });
  }
  const hint =
    marks.use === "range" ? (tlDef?.remove?.(params) ? "Drag the handles around the part to take out." : "Drag the handles to choose the part to keep.")
    : marks.use === "marks" ? "Double-click to add a cut. Drag a cut to move it; Delete removes it."
    : marks.use === "parts" ? "Drag across the strip to add a part. Delete removes the selected one."
    : marks.use === "cuts" ? "Where the clips are cut, from the settings."
    : "Click to move the playhead.";
  const status = strip?.error ? strip.error : !strip || (!strip.done && !strip.duration) ? "Loading…" : "";
  const readout = hover !== undefined ? formatTime(hover) : playhead !== undefined ? formatTime(playhead) : "";

  return (
    <div className="timeline nokey" data-collapsed={collapsed ? "1" : undefined} data-node={target.id}>
      <div className="timeline-head">
        <button className="tl-fold" onClick={onToggle} title={collapsed ? "Show the timeline" : "Hide the timeline"} aria-label={collapsed ? "Show the timeline" : "Hide the timeline"}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>Timeline</strong>
        <span className="tl-title">{def?.title}</span>
        {!collapsed && playback.canPlay && (
          <button className="tl-play" onClick={playback.toggle} title={play.playing ? "Pause (Space)" : "Play (Space)"} aria-label={play.playing ? "Pause" : "Play"}>
            <PlayIcon playing={play.playing} />
          </button>
        )}
        {!collapsed && <span className="tl-hint">{status || hint} Scroll to zoom.</span>}
        {!collapsed && duration > 0 && (
          <span className="tl-time">
            {readout ? `${readout} / ` : ""}
            {formatTime(duration)}
          </span>
        )}
      </div>
      {!collapsed && (
        <div className="timeline-body" tabIndex={0} onKeyDown={onKey} aria-label="Timeline">
          <div className="tl-ruler" onPointerDown={(e) => start(e, { kind: "pan", x: e.clientX, span })} title="Drag to move along; scroll to zoom">
            {ticks.times.map((t) => (
              <span key={t} className="tl-tick" style={{ left: x(t) }}>
                {formatTime(t).replace(/\.0$/, "")}
              </span>
            ))}
          </div>
          <div
            className="tl-strip"
            ref={stripRef}
            // For the end-to-end checks.
            data-duration={duration || undefined}
            data-pictures={(strip?.thumbs.filter(Boolean).length ?? 0) + (strip?.wave ? 1 : 0)}
            onPointerDown={(e) => {
              const t = tAt(e.clientX);
              if (marks.use === "parts") start(e, { kind: "new-part", parts: marks.parts ?? [], from: snapTime(t, e.shiftKey), x: e.clientX, made: false });
              else {
                start(e, { kind: "scrub" });
                scrub(t);
              }
              setSel(undefined);
            }}
            onDoubleClick={(e) => {
              if (marks.use !== "marks" || !tlDef?.marks || !(duration > 0)) return;
              const t = snapTime(tAt(e.clientX), e.shiftKey);
              set({ [tlDef.marks]: editMarks(marks.marks ?? [], -1, t) });
              setSel({ kind: "mark", t: Math.round(t * 100) / 100 });
            }}
            onPointerMove={(e) => duration > 0 && setHover(tAt(e.clientX))}
            onPointerLeave={() => setHover(undefined)}
          >
            <canvas ref={canvasRef} className="tl-pictures" />
            {removed.map((r, i) => (
              <div key={`r${i}`} className="tl-hatch" style={seg(r.start, r.end)} />
            ))}
            {marks.use === "range" && marks.range && (
              <>
                <div className="tl-range" data-remove={tlDef?.remove?.(params) ? "1" : undefined} style={seg(marks.range.start, marks.range.end)} />
                {(["start", "end"] as const).map((w) => (
                  <div
                    key={w}
                    className="tl-handle"
                    data-handle={w}
                    data-selected={sel?.kind === w ? "1" : undefined}
                    style={{ left: x(marks.range![w]) }}
                    title={`${w === "start" ? "Start" : "End"} ${formatTime(marks.range![w])}: drag, or select and use the arrow keys (Shift snaps to seconds)`}
                    onPointerDown={(e) => {
                      setSel({ kind: w });
                      start(e, { kind: "range", which: w });
                    }}
                  />
                ))}
              </>
            )}
            {marks.marks?.map((m, i) => (
              <div
                key={`m${i}`}
                className="tl-mark"
                data-mark={i}
                data-selected={i === markIndex ? "1" : undefined}
                style={{ left: x(m) }}
                title={`Cut at ${formatTime(m)}`}
                onDoubleClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  setSel({ kind: "mark", t: m });
                  start(e, { kind: "mark", marks: marks.marks!, index: i });
                }}
              />
            ))}
            {marks.parts?.map((p, i) => (
              <div
                key={`p${i}`}
                className="tl-part"
                data-part={i}
                data-selected={sel?.kind === "part" && sel.index === i ? "1" : undefined}
                style={{ left: x(p.start), width: Math.max(2, x(p.end) - x(p.start)) }}
                title={`Part ${i + 1}: ${formatTime(p.start)} to ${formatTime(p.end)}`}
                onPointerDown={(e) => {
                  setSel({ kind: "part", index: i });
                  start(e, { kind: "part-move", parts: marks.parts!, index: i, from: tAt(e.clientX) });
                }}
              >
                {(["start", "end"] as const).map((edge) => (
                  <span
                    key={edge}
                    className="tl-part-edge"
                    data-edge={edge}
                    onPointerDown={(e) => {
                      setSel({ kind: "part", index: i });
                      start(e, { kind: "part-edge", parts: marks.parts!, index: i, edge });
                    }}
                  />
                ))}
              </div>
            ))}
            {marks.cuts?.map((c, i) => <div key={`c${i}`} className="tl-cut" style={{ left: x(c) }} />)}
            {playhead !== undefined && duration > 0 && (
              <div className="tl-playhead" style={{ left: x(playhead) }} onPointerDown={(e) => start(e, { kind: "scrub" })} title={`Playhead ${formatTime(playhead)}`} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
