// Simple view: Simple home's tiles, or one workflow as a form, under a top bar with the
// Simple | Graph switch. It keeps its own graph and worker; the canvas is never touched.
import { useCallback, useState } from "react";
import { useSimple, type GivenFile } from "../app/useSimple";
import { workflowsFor } from "../graphs";
import { isDesktop } from "../platform";
import type { Graph } from "../runtime/types";
import type { ViewMode } from "../simple-form";
import { ModeSwitch } from "./ModeSwitch";
import { SimpleForm } from "./SimpleForm";
import { SimpleHome } from "./SimpleHome";
import logoUrl from "../../build/icon.svg?url";

interface SimpleViewProps {
  active: boolean;
  onMode: (m: ViewMode) => void;
  /** Shows the form's graph in Graph view, with the files it was given. */
  openAsGraph: (graph: Graph, files: GivenFile[], title: string) => void;
}

export function SimpleView({ active, onMode, openAsGraph }: SimpleViewProps) {
  const [message, setMessage] = useState("");
  const flash = useCallback((text: string, ms = 6000) => {
    setMessage(text);
    setTimeout(() => setMessage((m) => (m === text ? "" : m)), ms);
  }, []);
  const s = useSimple(flash, active);

  return (
    <div className="simple" hidden={!active}>
      <header className="topbar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" /> TOOLBOX
        </div>
        <ModeSwitch mode="simple" onMode={onMode} />
        <div className="message">{s.workflow ? "" : message}</div>
      </header>
      <main className="simple-body">
        {s.workflow ? (
          <SimpleForm
            s={s}
            message={message}
            onOpenAsGraph={() => {
              const { graph, files } = s.forGraph();
              openAsGraph(graph, files, s.workflow!.title);
            }}
          />
        ) : (
          <SimpleHome workflows={workflowsFor(isDesktop)} onPick={s.open} />
        )}
      </main>
    </div>
  );
}
