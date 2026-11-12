// Simple home: every ready-made workflow as a tile, with a search box.
import { useState } from "react";
import type { Workflow } from "../graphs";
import type { Topic } from "../simple-form";

/** Line icons, one per topic (24 × 24, drawn with the text colour). */
const ICONS: Record<Topic, string> = {
  video: "M3 6h13v12H3z M16 10l5-3v10l-5-3",
  sound: "M9 18V5l11-2v13 M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0z M20 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0z",
  image: "M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 6 M15.5 8.5h.01",
  pdf: "M6 2h9l5 5v15H6z M14 2v6h6 M9 13h6 M9 17h6",
  text: "M4 6h16 M4 10h16 M4 14h10 M4 18h7",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  camera: "M3 7h4l2-3h6l2 3h4v13H3z M12 17a4 4 0 1 0 0-8a4 4 0 0 0 0 8z",
};

export function TopicIcon({ topic }: { topic: Topic }) {
  return (
    <svg className="topic-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[topic]} />
    </svg>
  );
}

export function SimpleHome({ workflows, onPick }: { workflows: Workflow[]; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = workflows.filter((w) => {
    const text = `${w.title} ${w.form.blurb ?? w.description}`.toLowerCase();
    return words.every((x) => text.includes(x));
  });
  return (
    <div className="simple-home">
      <h1>What would you like to do?</h1>
      <input
        type="search"
        className="simple-search"
        placeholder="Search: video, photos, PDF, MP3…"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && shown.length === 1 && onPick(shown[0].id)}
      />
      <div className="simple-tiles">
        {shown.map((w) => (
          <button key={w.id} className="simple-tile" data-workflow={w.id} onClick={() => onPick(w.id)}>
            <span className={`topic t-${w.form.topic}`}>
              <TopicIcon topic={w.form.topic} />
            </span>
            <strong>{w.title}</strong>
            <span className="muted">{w.form.blurb ?? w.description}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="muted">Nothing matches “{query}”.</p>}
      </div>
    </div>
  );
}
