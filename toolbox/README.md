# Toolbox

One desktop app for all the Utilities tools. Drop in inputs, wire them through nodes, and render files out.

```sh
# from the repo root
npm install
npm run toolbox        # builds the UI and opens the Electron window
npm run toolbox:web    # the UI in a browser tab, for development (no ffmpeg, yt-dlp or file memory)
npm test -w toolbox    # graph runtime tests
npm run check:gpu -w toolbox      # WebGPU against CPU output (add -- --bench for timings)
npm run check:encode -w toolbox   # Encode video through the app: ProRes, HEVC, H.264 (add -- --bench for 1080p)
npm run toolbox:dmg       # on a Mac: release/Toolbox-<version>-mac-arm64.dmg
npm run toolbox:exe       # on Windows: release/Toolbox-<version>-win-x64.exe
npm run toolbox:appimage  # on Linux: release/Toolbox-<version>-linux-x86_64.AppImage
```

Each installer bundles the ffmpeg for its own system, so build each one on that system. GitHub Actions does all three (`.github/workflows/toolbox-release.yml`): pull requests and manual runs attach the installers to the run, and pushing a tag publishes them on a Release:

```sh
git tag toolbox-v0.2.0 && git push origin toolbox-v0.2.0
```

Or run the workflow from the Actions tab with a version (`0.2.0`) filled in, which creates the tag itself.

The installers aren't signed with a paid certificate (the Mac app is ad-hoc signed), so the first launch takes an extra click. [INSTALL.md](INSTALL.md) has the steps for friends; it's also the Release's description.

## How it works

- **Nodes** wrap the existing engines (`../dither/src/engine`, …) without changing them. Each node declares typed inputs and outputs, so only matching ports can be wired.
- **Add node menu**, like TouchDesigner's: press **Tab** (or right-click the canvas) to open it at the pointer, type to search, use the arrows or Tab to move between categories, and press Enter to place the node under the pointer. Drop a wire on empty canvas to get only the nodes that can take it, already wired.
- **Editing**: ⌘Z / ⇧⌘Z undo and redo (settings, wires, moves, deletes, whole workflows); ⌘C, ⌘X, ⌘V and ⌘D copy, cut, paste and duplicate nodes. Text fields keep their own undo and clipboard.
- **Live preview**: frame nodes re-run on a downscaled frame (max 1280 px) whenever a setting changes. A node's eye button (or ⌥-click) shows its output large behind the graph, with a playhead scrubber when it comes from a video.
- **Render** (⌘R): runs everything at full size and writes the files of the Save nodes whose result changed since they last saved; a Save node's own **Save** button renders just its chain and writes it again. Pick a folder on a Save node to skip the save dialog; files there are never overwritten (`name (2).png`). With no Save node, Render adds one after the selected node.
- **Save** takes images (as PNG), text, ASCII, sound, PDFs and encoded files. Fed a list (Several images), it writes one file per image, named after the originals, into one folder.
- A **cache** keyed on node type, settings and inputs means only the nodes downstream of a change re-run.
- **Video**: a Video file, Webcam or Pages to images node outputs a video. Image nodes wired after it (Resize, Dither, ASCII, Overlay…) run on every frame: live preview shows the frame at the playhead, Render streams every frame through them into Encode video, Images to PDF or a GIF. Video file trims (Start, End) and changes speed (the sound is left out at other speeds). With a Webcam, Render records (with the microphone's sound) until you press Stop; several encoders after one webcam all record at once.
- **Progress and cancel**: long nodes show a progress bar during Render; Cancel stops them without writing half files.
- **Native tools** (desktop app only): ffmpeg ships inside the app and runs in its own process, reading dropped files where they are on disk. Convert audio uses it instead of ffmpeg.wasm, and videos WebCodecs can't read (AVI, WMV, old codecs) are converted to MP4 once when dropped. The **Download from link** node fetches links with yt-dlp, which Toolbox downloads into its own folder the first time (or uses one from Homebrew), refreshes weekly, and updates once more when a download fails. iPhone photos (HEIC) open through macOS's `sips` in the Mac app.
- **GPU**: Dither and Resize / crop run on the GPU through WebGPU when there is one. Dither runs its resize, adjustments, filters and ordered, halftone and noise dithers as compute shaders; error diffusion (Floyd–Steinberg and friends) is sequential, so a recipe hands over to the CPU at that step. Resize / crop runs Media Lab's Lanczos3 filter (linear light, premultiplied alpha) there. On an M5 at 1080p: Lanczos resize 55 → 6 ms, halftone recipes 139 → 8 ms, Bayer 36 → 5 ms; recipes ending in error diffusion gain little. (ASCII already takes 1–2 ms a frame, and the GPU didn't beat that, so it stays on the CPU.) Without WebGPU, or after a GPU error, the same CPU code as the web apps runs. `npm run check:gpu` compares the two.
- **Hardware video encoding** (desktop app): Encode video can write ProRes (Proxy, LT, 422, HQ, 4444) to MOV with ffmpeg, using Apple Silicon's ProRes engine (`prores_videotoolbox`) and falling back to `prores_ks` (the only ProRes encoder on Windows and Linux). H.264 and HEVC stay with WebCodecs, which already encodes on VideoToolbox and measured as fast as ffmpeg's encoders; HEVC goes to ffmpeg only where WebCodecs can't write it: `hevc_videotoolbox` on a Mac, NVIDIA, Intel or AMD (`hevc_nvenc`, `hevc_qsv`, `hevc_amf`) on a PC, each falling through to the next when the GPU isn't there, then `libx265`. The converter for unreadable files uses `libx264`: on an M5, software H.264 is faster than VideoToolbox. 10 s of 1080p renders to ProRes HQ through a Dither node in 4.5 s, or straight from the file in 2.3 s. Frames after image nodes reach ffmpeg as raw RGBA on its stdin; untouched files go to ffmpeg directly, decoded with VideoToolbox.
- **Workflows** (toolbar button, or the last tab of the Tab menu) drop a ready-made chain into the graph: download a video, download the sound as MP3, extract audio from a video, shrink a video, video or link to GIF, compress an image, compress many photos, watermark photos, video to ASCII MP4, photos to PDF, watermark a PDF, Romanian text, webcam recording. A graph with nothing of yours in it yet is replaced (⌘Z brings it back); otherwise the workflow goes under what's there.
- A four-step **tutorial** shows on first launch. Reopen it with the **?** button or Help > Tutorial.
- Graphs save as `.toolbox` JSON files (⌘S / ⌘O). The desktop app remembers where dropped files are and reads them again after a restart or when a graph is opened; in a browser, drop them again.
- The settings panel resizes (drag its edge) or hides (double-click it). The Outputs tray keeps the last 30 files; click one to open it. Once a day the desktop app checks GitHub and says when a newer Toolbox is out.

## Layout

| Path | What |
| --- | --- |
| `electron/` | Main process: window, menus, file dialogs, the `app://` protocol that serves `dist/`, native ffmpeg and yt-dlp (`tools.js`) |
| `src/runtime/` | Graph types, evaluator + cache (DOM-free, tested in Node), the worker and its client |
| `src/nodes/gpu.ts` | The WebGPU device shared by the GPU halves of the engines (`../dither/src/engine/gpu.ts`, `../media/src/engine/gpu-resize.ts`) |
| `src/nodes/ffmpeg-video.ts` | Which ffmpeg encoder to use (hardware first where it's faster) and its arguments |
| `src/nodes/` | Node definitions, one file per engine: image, dither, ascii, media, video, audio, text, pdf, save. The heavy libraries (Mediabunny, gifenc, ffmpeg.wasm, pdf-lib, pdf.js, jsquash) sit behind `import()` in `*-codec.ts`/`pdf-render.ts` or the engine itself, so the window only parses node metadata and the worker loads each library the first time a node needs it |
| `src/ui/` | React components: graph node card, inspector, Dither Lab's stack editor |
| `build/` | App icon: `icon.svg` is the source, `icon.png` (1024 px) and `icon.icns` are rendered from it |

Nodes: Image file, Several images, Video, Audio and PDF files, Webcam, Download from link, Text; Resize / crop, Text / logo overlay, Dither, ASCII, ASCII to image, Encode image; Encode video (MP4, WebM, MOV, MKV, GIF; ProRes and HEVC through ffmpeg under Advanced); Extract audio, Convert audio; ASCII to text, Romanian diacritics; Merge PDFs, Pick pages, Watermark / numbers, Protect, Compact, Images to PDF, Pages to images; Save. (Save image and Save text still open in older graphs.)

Video is decoded and encoded with Mediabunny (WebCodecs), except ProRes and HEVC in the desktop app (see above). In a browser tab, formats WebCodecs can't read (AVI, WMV…) need converting in Media Lab first; the desktop app converts them itself.
