// Commands from the desktop menu and from keyboard shortcuts (in a browser tab).
import { useEffect, useRef } from "react";
import { bridge, isDesktop } from "../platform";
import { typingIn } from "./flow";

/** `commands` is rebuilt every render; the listeners always call the latest. */
export function useCommands(commands: Record<string, () => void>) {
  const ref = useRef(commands);
  ref.current = commands;
  useEffect(() => {
    const TEXT = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    // The desktop Edit menu sends its commands here; in a text field they edit the text instead.
    bridge?.onMenu((c) => {
      if (TEXT.has(c) && typingIn(document.activeElement)) void bridge!.editText(c);
      else if (c === "duplicate" && typingIn(document.activeElement)) return;
      else ref.current[c]?.();
    });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // Tab opens the Add node menu at the pointer, unless you're typing or moving between inspector fields.
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (t.closest("input, textarea, select, [contenteditable], .inspector, .node-menu, .tutorial")) return;
        e.preventDefault();
        ref.current.addNode();
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || isDesktop) return; // the desktop menu owns these
      const k = e.key.toLowerCase();
      const c =
        k === "z" ? (e.shiftKey ? "redo" : "undo")
        : ({ y: "redo", r: "render", o: "open", s: "save", c: "copy", x: "cut", v: "paste", d: "duplicate", a: "selectAll" } as Record<string, string>)[k];
      if (!c || (typingIn(t) && !["render", "open", "save"].includes(c))) return;
      e.preventDefault();
      ref.current[c]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return ref;
}
