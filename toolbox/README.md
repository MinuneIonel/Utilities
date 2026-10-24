# Toolbox

One desktop app for all the Utilities tools. Drop in inputs, wire them through nodes, and render files out.

```sh
# from the repo root
npm install
npm run toolbox        # builds the UI and opens the Electron window
npm run toolbox:web    # the same UI in a browser tab (saving uses downloads)
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

The installers aren't signed with a paid certificate (the Mac app is ad-hoc signed), so the first launch takes an extra click. [INSTALL.md](INSTALL.md) has the steps for friends; it's also the Release's description.

## How it works

- **Nodes** wrap the existing engines (`../dither/src/engine`, …) without changing them. Each node declares typed inputs and outputs, so only matching ports can be wired.
- **Add node menu**, like TouchDesigner's: press **Tab** (or right-click the canvas) to open it at the pointer, type to search, use the arrows or Tab to move between categories, and press Enter to place the node under the pointer. Drop a wire on empty canvas to get only the nodes that can take it, already wired.
- **Live preview**: nodes marked `live` re-run on a downscaled frame (max 1280 px) whenever a setting changes. The selected node shows full size in the Preview panel.
- **Render** (⌘R): runs everything at full size, including `render` nodes such as Save image, and writes the files. Pick a folder on a Save node to skip the save dialog.
- A **cache** keyed on node type, settings and inputs means only the nodes downstream of a change re-run.
- **Video**: a Video file, Webcam or Pages to images node outputs a video. Image nodes wired after it (Resize, Dither, ASCII…) run on every frame: live preview shows the frame at the playhead, Render streams every frame through them into Encode video, Images to PDF or a GIF. With a Webcam, Render records until you press Stop.
- **Progress and cancel**: long nodes show a progress bar during Render; Cancel stops them without writing half files.
- **Native tools** (desktop app only): ffmpeg ships inside the app and runs in its own process. Convert audio uses it instead of ffmpeg.wasm, and videos WebCodecs can't read (AVI, WMV, old codecs) are converted to MP4 once when dropped. The **Download** node fetches links with yt-dlp, which Toolbox downloads into its own folder the first time (or uses one from Homebrew).
- **GPU**: Dither and Resize / crop run on the GPU through WebGPU when there is one. Dither runs its resize, adjustments, filters and ordered, halftone and noise dithers as compute shaders; error diffusion (Floyd–Steinberg and friends) is sequential, so a recipe hands over to the CPU at that step. Resize / crop runs Media Lab's Lanczos3 filter (linear light, premultiplied alpha) there. On an M5 at 1080p: Lanczos resize 55 → 6 ms, halftone recipes 139 → 8 ms, Bayer 36 → 5 ms; recipes ending in error diffusion gain little. (ASCII already takes 1–2 ms a frame, and the GPU didn't beat that, so it stays on the CPU.) Without WebGPU, or after a GPU error, the same CPU code as the web apps runs. `npm run check:gpu` compares the two.
- **Hardware video encoding** (desktop app): Encode video can write ProRes (Proxy, LT, 422, HQ, 4444) to MOV with ffmpeg, using Apple Silicon's ProRes engine (`prores_videotoolbox`) and falling back to `prores_ks` (the only ProRes encoder on Windows and Linux). H.264 and HEVC stay with WebCodecs, which already encodes on VideoToolbox and measured as fast as ffmpeg's encoders; HEVC goes to ffmpeg only where WebCodecs can't write it: `hevc_videotoolbox` on a Mac, NVIDIA, Intel or AMD (`hevc_nvenc`, `hevc_qsv`, `hevc_amf`) on a PC, each falling through to the next when the GPU isn't there, then `libx265`. The converter for unreadable files uses `libx264`: on an M5, software H.264 is faster than VideoToolbox. 10 s of 1080p renders to ProRes HQ through a Dither node in 4.5 s, or straight from the file in 2.3 s. Frames after image nodes reach ffmpeg as raw RGBA on its stdin; untouched files go to ffmpeg directly, decoded with VideoToolbox.
- **Templates** in the toolbar start common jobs: video to ASCII MP4, link to GIF, sound as MP3, photos to PDF, watermark a PDF, Romanian text, webcam recording.
- Graphs save as `.toolbox` JSON files (⌘S / ⌘O). Dropped files are not stored in the graph, so drop them again after opening.

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

Nodes: Image, Images, Video, Audio and PDF files, Webcam, Download (yt-dlp), Text; Resize / crop, Dither, ASCII, Draw ASCII, Encode image; Encode video (MP4, WebM, MOV, MKV, GIF; ProRes and HEVC through ffmpeg); Extract audio, Convert audio; ASCII to text, Diacritics; Merge PDFs, Pick pages, Watermark / numbers, Protect, Compact, Images to PDF, Pages to images; Save image, Save file, Save text.

Video is decoded and encoded with Mediabunny (WebCodecs), except ProRes and HEVC in the desktop app (see above). In a browser tab, formats WebCodecs can't read (AVI, WMV…) need converting in Media Lab first; the desktop app converts them itself.
