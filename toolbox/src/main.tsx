import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./style.css";
import { App } from "./App";
import { isDesktop } from "./platform";
import { installWheelNudge } from "./ui/wheel-nudge";

// The desktop window hides its title bar on macOS; leave room for the traffic lights.
if (isDesktop && /Mac/.test(navigator.platform)) document.body.classList.add("mac-desktop");

// Mouse wheel over a slider nudges it (Shift = fine, ⌘/Ctrl = coarse).
installWheelNudge();

createRoot(document.getElementById("root")!).render(
  // No StrictMode: its double effects would mount Dither Lab's stack editor twice.
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
