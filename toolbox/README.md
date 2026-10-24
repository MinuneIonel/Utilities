# Toolbox

One desktop app for all the Utilities tools. Drop in inputs, wire them through nodes, and render files out.

```sh
# from the repo root
npm install
npm run toolbox        # builds the UI and opens the Electron window
npm run toolbox:web    # the same UI in a browser tab (saving uses downloads)
npm test -w toolbox    # graph runtime tests
npm run toolbox:dmg    # on a Mac: builds release/Toolbox-<version>-arm64.dmg
```

The `.dmg` is unsigned: the first time, right-click Toolbox in Applications and choose Open.

## How it works

- **Nodes** wrap the existing engines (`../dither/src/engine`, …) without changing them. Each node declares typed inputs and outputs, so only matching ports can be wired.
- **Live preview**: nodes marked `live` re-run on a downscaled frame (max 1280 px) whenever a setting changes. The selected node shows full size in the Preview panel.
- **Render** (⌘R): runs everything at full size, including `render` nodes such as Save image, and writes the files. Pick a folder on a Save node to skip the save dialog.
- A **cache** keyed on node type, settings and inputs means only the nodes downstream of a change re-run.
- **Video**: a Video file, Webcam or Pages to images node outputs a video. Image nodes wired after it (Resize, Dither, ASCII…) run on every frame: live preview shows the frame at the playhead, Render streams every frame through them into Encode video, Images to PDF or a GIF. With a Webcam, Render records until you press Stop.
- **Progress and cancel**: long nodes show a progress bar during Render; Cancel stops them without writing half files.
- **Native tools** (desktop app only): ffmpeg ships inside the app and runs in its own process. Convert audio uses it instead of ffmpeg.wasm, and videos WebCodecs can't read (AVI, WMV, old codecs) are converted to MP4 once when dropped. The **Download** node fetches links with yt-dlp, which Toolbox downloads into its own folder the first time (or uses one from Homebrew).
- **Templates** in the toolbar start common jobs: video to ASCII MP4, link to GIF, sound as MP3, photos to PDF, watermark a PDF, Romanian text, webcam recording.
- Graphs save as `.toolbox` JSON files (⌘S / ⌘O). Dropped files are not stored in the graph, so drop them again after opening.

## Layout

| Path | What |
| --- | --- |
| `electron/` | Main process: window, menus, file dialogs, the `app://` protocol that serves `dist/`, native ffmpeg and yt-dlp (`tools.js`) |
| `src/runtime/` | Graph types, evaluator + cache (DOM-free, tested in Node), the worker and its client |
| `src/nodes/` | Node definitions, one file per engine: image, dither, ascii, media, video, audio, text, pdf, save |
| `src/ui/` | React components: graph node card, inspector, Dither Lab's stack editor |

Nodes: Image, Images, Video, Audio and PDF files, Webcam, Download (yt-dlp), Text; Resize / crop, Dither, ASCII, Draw ASCII, Encode image; Encode video (MP4, WebM, MOV, MKV, GIF); Extract audio, Convert audio; ASCII to text, Diacritics; Merge PDFs, Pick pages, Watermark / numbers, Protect, Compact, Images to PDF, Pages to images; Save image, Save file, Save text.

Video is decoded and encoded with Mediabunny (WebCodecs), so it uses the Mac's hardware encoders. In a browser tab, formats WebCodecs can't read (AVI, WMV…) need converting in Media Lab first; the desktop app converts them itself.
