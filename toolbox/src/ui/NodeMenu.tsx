// The Add node menu, like TouchDesigner's: Tab (or a right-click, or a wire dropped
// on empty canvas) opens it at the pointer. Type to search, arrows to move, Enter to add.
// Its last tab holds the ready-made workflows, which drop in a whole chain at once.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Workflow } from "../graphs";
import type { NodeDef } from "../runtime/types";

type Tab = NodeDef["category"] | "workflow";

export const CATEGORY_LABEL: Record<Tab, string> = {
  input: "Input",
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
  pdf: "PDF",
  output: "Output",
  workflow: "Workflows",
};

/** One line of the menu: a node type or a workflow. */
interface Entry {
  id: string;
  title: string;
  description: string;
  tab: Tab;
}

/** Lower is better; undefined means no match. */
function score(d: Entry, q: string): number | undefined {
  const title = d.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 1;
  if (title.includes(q)) return 2;
  if (CATEGORY_LABEL[d.tab].toLowerCase().startsWith(q)) return 3;
  if (d.description.toLowerCase().includes(q)) return 4;
  return undefined;
}

// The tab last used, so the menu opens where you left it.
let lastCategory: Tab | undefined;

export function NodeMenu({
  defs,
  workflows = [],
  x,
  y,
  title,
  tab,
  onPick,
  onPickWorkflow,
  onClose,
}: {
  defs: NodeDef[];
  workflows?: Workflow[];
  /** Pointer position inside the canvas, in pixels. */
  x: number;
  y: number;
  title?: string;
  /** The tab to open on, instead of the last one used. */
  tab?: Tab;
  onPick(type: string): void;
  onPickWorkflow?(id: string): void;
  onClose(): void;
}) {
  const entries = useMemo<Entry[]>(
    () => [
      ...defs.map((d) => ({ id: d.type, title: d.title, description: d.description, tab: d.category })),
      ...workflows.map((w) => ({ id: w.id, title: w.title, description: w.description, tab: "workflow" as const })),
    ],
    [defs, workflows],
  );
  const categories = useMemo(() => [...new Set(entries.map((d) => d.tab))], [entries]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(() => {
    const want = tab ?? lastCategory;
    return want && categories.includes(want) ? want : categories[0];
  });
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const q = query.trim().toLowerCase();
  const items = useMemo(() => {
    if (!q) return entries.filter((d) => d.tab === category);
    return entries
      .map((d, i) => ({ d, i, s: score(d, q) }))
      .filter((e) => e.s !== undefined)
      .sort((a, b) => a.s! - b.s! || a.i - b.i)
      .map((e) => e.d);
  }, [entries, q, category]);
  const current = items[Math.min(active, items.length - 1)];
  const pick = (d: Entry) => (d.tab === "workflow" ? onPickWorkflow?.(d.id) : onPick(d.id));

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
        if (current) pick(current);
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
          <li key={`${d.tab}:${d.id}`}>
            <button
              className={d === current ? "active" : ""}
              tabIndex={-1}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(d)}
            >
              <span>{d.title}</span>
              {q && <span className="muted">{d.tab === "workflow" ? "Workflow" : CATEGORY_LABEL[d.tab]}</span>}
            </button>
          </li>
        ))}
        {!items.length && <li className="node-menu-empty muted">Nothing matches “{query}”</li>}
      </ul>
      {current && <p className="node-menu-desc">{current.description}</p>}
    </div>
  );
}
