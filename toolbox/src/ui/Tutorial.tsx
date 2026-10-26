// A short first-run tour: a card per step, with the part of the window it talks about
// lit up. Shown once; the ? button in the top bar (or Help > Tutorial) brings it back.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const SEEN = "toolbox.tutorial";

interface Step {
  title: string;
  body: string;
  /** What to light up: the first selector that matches something on screen. None centres the card. */
  target?: string[];
}

const STEPS: Step[] = [
  {
    title: "Start with a workflow",
    body: "Toolbox chains small tools: each box is a node, and wires carry images, video, sound, text or PDFs between them. Workflows drop in a ready-made chain, like downloading a video. Press Tab (or right-click) to add a single node.",
    target: [".topbar .workflows"],
  },
  {
    title: "Drop your files",
    body: "Drop images, videos, sound, PDFs or text anywhere here, or onto an input node. Drag from a dot on the right of a node to one on the left of another to wire them.",
    target: [".canvas"],
  },
  {
    title: "Look and tweak",
    body: "Select a node to change its settings here; previews update as you go. The eye on a node shows its result large, behind the graph.",
    target: [".inspector", ".inspector-wrap"],
  },
  {
    title: "Render",
    body: "Render runs everything at full size and the Save nodes write what changed; the files show up at the bottom. ⌘Z undoes, and the ? button brings this tour back.",
    target: [".topbar .primary"],
  },
];

export function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return true; // no storage: don't show it on every launch
  }
}

const CARD_WIDTH = 340;
const GAP = 12;

/** Where the card goes: below the target, else above, else beside it, kept on screen. */
function placeCard(r: DOMRect | undefined, h: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(GAP, Math.min(x, vw - CARD_WIDTH - GAP));
  const clampY = (y: number) => Math.max(GAP, Math.min(y, vh - h - GAP));
  if (!r) return { left: clampX((vw - CARD_WIDTH) / 2), top: clampY((vh - h) / 2) };
  if (r.bottom + GAP + h < vh) return { left: clampX(r.left), top: r.bottom + GAP };
  if (r.top - GAP - h > 0) return { left: clampX(r.left), top: r.top - GAP - h };
  if (r.left - GAP - CARD_WIDTH > 0) return { left: r.left - GAP - CARD_WIDTH, top: clampY(r.top) };
  if (r.right + GAP + CARD_WIDTH < vw) return { left: r.right + GAP, top: clampY(r.top) };
  // Big targets, like the canvas: sit inside, near the bottom.
  return { left: clampX(r.left + (r.width - CARD_WIDTH) / 2), top: clampY(r.bottom - h - 2 * GAP) };
}

export function Tutorial({ onClose }: { onClose(): void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | undefined>();
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const close = useCallback(() => {
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      /* storage may be unavailable */
    }
    onClose();
  }, [onClose]);

  // Follow the target as the window resizes or the graph moves.
  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target?.map((s) => document.querySelector(s)).find(Boolean);
      const r = el?.getBoundingClientRect();
      setRect(r && r.width > 0 ? r : undefined);
    };
    measure();
    window.addEventListener("resize", measure);
    const t = setInterval(measure, 500);
    return () => {
      window.removeEventListener("resize", measure);
      clearInterval(t);
    };
  }, [step]);

  useLayoutEffect(() => {
    setPos(placeCard(rect, cardRef.current?.offsetHeight ?? 160));
  }, [rect, index]);

  useEffect(() => nextRef.current?.focus(), [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, STEPS.length - 1));
    else if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    else return;
    e.preventDefault();
  };

  const pad = 6;
  return (
    <div className="tutorial" onKeyDown={onKeyDown} role="dialog" aria-label="Toolbox tutorial">
      {rect ? (
        <div
          className="tutorial-spot"
          style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad }}
        />
      ) : (
        <div className="tutorial-dim" />
      )}
      <div className="tutorial-card" ref={cardRef} style={{ ...pos, width: CARD_WIDTH }}>
        <div className="tutorial-count">
          {index + 1} / {STEPS.length}
        </div>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <div className="tutorial-actions">
          {!last && (
            <button className="icon" onClick={close}>
              Skip tour
            </button>
          )}
          <span className="spacer" />
          {index > 0 && <button onClick={() => setIndex(index - 1)}>Back</button>}
          <button ref={nextRef} className="primary" onClick={() => (last ? close() : setIndex(index + 1))}>
            {last ? "Done" : index === 0 ? "Show me" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
