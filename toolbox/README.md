# Toolbox

One desktop app for all the Utilities tools. Drop in inputs, wire them through nodes, and render files out.

```sh
# from the repo root
npm install
npm run toolbox        # builds the UI and opens the Electron window
npm run toolbox:web    # the same UI in a browser tab (saving uses downloads)
npm test -w toolbox    # graph runtime tests
```

## How it works

- **Nodes** wrap the existing engines (`../dither/src/engine`, …) without changing them. Each node declares typed inputs and outputs, so only matching ports can be wired.
- **Live preview**: nodes marked `live` re-run on a downscaled frame (max 1280 px) whenever a setting changes. The selected node shows full size in the Preview panel.
- **Render** (⌘R): runs everything at full size, including `render` nodes such as Save image, and writes the files. Pick a folder on a Save node to skip the save dialog.
- A **cache** keyed on node type, settings and inputs means only the nodes downstream of a change re-run.
- Graphs save as `.toolbox` JSON files (⌘S / ⌘O). Dropped files are not stored in the graph, so drop them again after opening.

## Layout

| Path | What |
| --- | --- |
| `electron/` | Main process: window, menus, file dialogs, the `app://` protocol that serves `dist/` |
| `src/runtime/` | Graph types, evaluator + cache (DOM-free, tested in Node), the worker and its client |
| `src/nodes/` | Node definitions: File input, Dither, Save image |
| `src/ui/` | React components: graph node card, inspector, Dither Lab's stack editor |

Nodes so far: File input (images), Dither, Save image. ASCII, resize/crop, encoders, text and diacritics come next, then video, audio and PDF.
