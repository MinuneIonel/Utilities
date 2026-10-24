// The Add node menu, like TouchDesigner's: Tab (or a right-click, or a wire dropped
// on empty canvas) opens it at the pointer. Type to search, arrows to move, Enter to add.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NodeDef } from "../runtime/types";

export const CATEGORY_LABEL: Record<NodeDef["category"], string> = {
  input: "Input",
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
  pdf: "PDF",
  output: "Output",
};

/** Lower is better; undefined means no match. */
function score(d: NodeDef, q: string): number | undefined {
  const title = d.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 1;
  if (title.includes(q)) return 2;
  if (CATEGORY_LABEL[d.category].toLowerCase().startsWith(q)) return 3;
  if (d.description.toLowerCase().includes(q)) return 4;
  return undefined;
}

// The tab last used, so the menu opens where you left it.
let lastCategory: NodeDef["category"] | undefined;

export function NodeMenu({
  defs,
  x,
  y,
  title,
  onPick,
  onClose,
}: {
  defs: NodeDef[];
  /** Pointer position inside the canvas, in pixels. */
  x: number;
  y: number;
  title?: string;
  onPick(type: string): void;
  onClose(): void;
}) {
  const categories = useMemo(() => [...new Set(defs.map((d) => d.category))], [defs]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(() => (lastCategory && categories.includes(lastCategory) ? lastCategory : categories[0]));
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const q = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (!q) return defs.filter((d) => d.category === category);
    return defs
      .map((d, i) => ({ d, i, s: score(d, q) }))
      .filter((e) => e.s !== undefined)
      .sort((a, b) => a.s! - b.s! || a.i - b.i)
      .map((e) => e.d);
  }, [defs, q, category]);
  const current = items[Math.min(active, items.length - 1)];

  useEffect(() => setActive(0), [q, category]);
  useEffect(() => {
    lastCategory = category;
  }, [category]);

  // Keep the menu inside the canvas.
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement?.getBoundingClientRect();
    if (!el || !box) return;
    setPos({
      left: Math.max(8, Math.min(x, box.width - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(y, box.height - el.offsetHeight - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  // A click anywhere else closes it.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = (k: number) => {
      e.preventDefault();
      setActive((a) => (items.length ? (Math.min(a, items.length - 1) + k + items.length) % items.length : 0));
    };
    const tab = (k: number) => {
      e.preventDefault();
      setCategory((c) => categories[(categories.indexOf(c) + k + categories.length) % categories.length]);
    };
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Tab":
        // Tab again cycles the tabs, like TouchDesigner.
        if (!q) tab(e.shiftKey ? -1 : 1);
        else step(e.shiftKey ? -1 : 1);
        break;
      case "ArrowRight":
        if (!q) tab(1);
        break;
      case "ArrowLeft":
        if (!q) tab(-1);
        break;
      case "Enter":
        e.preventDefault();
        if (current) onPick(current.type);
        break;
    }
    e.stopPropagation();
  };

  return (
    <div className="node-menu" ref={ref} style={pos} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <input
        className="node-menu-search"
        autoFocus
        placeholder={title ?? "Add node: type to search"}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      {!q && categories.length > 1 && (
        <div className="node-menu-tabs">
          {categories.map((c) => (
            <button key={c} className={c === category ? "active" : ""} onClick={() => setCategory(c)} tabIndex={-1}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      )}
      <ul className="node-menu-list" ref={listRef}>
        {items.map((d, i) => (
          <li key={d.type}>
            <button
              className={d === current ? "active" : ""}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => onPick(d.type)}
            >
              <span>{d.title}</span>
              {q && <span className="muted">{CATEGORY_LABEL[d.category]}</span>}
            </button>
          </li>
        ))}
        {!items.length && <li className="node-menu-empty muted">No node matches “{query}”</li>}
      </ul>
      {current && <p className="node-menu-desc">{current.description}</p>}
    </div>
  );
}
