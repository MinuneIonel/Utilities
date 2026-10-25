# Utilities

Small apps for useful things. Each one runs on its own in the browser, and **Toolbox** wires them all together in one desktop app.

| App | What it does |
| --- | --- |
| [toolbox](toolbox/) | **Toolbox**: a Mac desktop app (Electron) that wires every tool below together as a node graph, with live preview, Render, native ffmpeg and yt-dlp. |
| [dither](dither/) | Dither Lab: image, video and webcam dithering with an effect stack and shareable recipes. |
| [ascii](ascii/) | ASCII Lab: image, video and webcam to ASCII art, with braille, edge lines, color and text/HTML/ANSI/SVG export. |
| [diacritics](diacritics/) | Diacritice: restores Romanian diacritics (ă â î ș ț) in text typed without them, offline, no LLM. |
| [audio](audio/) | Audio Lab: convert, compress, resample and trim audio (and the audio of videos) locally with ffmpeg.wasm. |
| [media](media/) | Media Lab: resize, crop, rotate, compress and convert images and videos in batches (MozJPEG/WebP/AVIF/PNG, MP4/WebM/MOV/MKV/GIF), with trim and target file size. |
| [pdf](pdf/) | PDF Lab: merge, reorder, rotate and split pages, add text, highlights, drawings and images, fill forms, watermark, number pages, password-protect and compress PDFs. |

## Toolbox

Drop in files (images, videos, sound, PDFs, text), or a webcam or a web link, and wire them through nodes:

- **Inputs**: image, several images, video, webcam, Download (yt-dlp: YouTube, Vimeo, SoundCloud…), audio, PDF, text.
- **Image**: resize / crop / rotate, Dither (the full Dither Lab stack), ASCII (ASCII Lab), encode JPEG/WebP/AVIF/PNG.
- **Video**: any image node wired to a video runs on every frame; Encode video writes MP4, WebM, MOV, MKV or GIF with a choice of codec and keeps the sound.
- **Audio**: extract the sound of a video, convert / trim / fade / normalize (Audio Lab).
- **Text**: ASCII to text, Romanian diacritics.
- **PDF**: merge, pick pages, watermark and page numbers, protect, compact, images to PDF, pages to images.
- **Workflows** drop ready-made chains into the graph: download a YouTube video, extract audio from a video, video to GIF, photos to PDF, and more. A short tutorial shows on first launch.

Nodes marked `live` preview as you change settings, with the selected node's output shown behind the graph. **Render** (⌘R) runs everything at full size and saves the files; **Cancel** stops it. See [toolbox/README.md](toolbox/README.md) for how it works.

### Install on a Mac

```sh
npm install
npm run toolbox:dmg        # writes toolbox/release/Toolbox-<version>-arm64.dmg
```

Open the `.dmg` and drag Toolbox to Applications. The app isn't signed, so the first time, right-click it and choose **Open**. ffmpeg ships inside the app; yt-dlp downloads itself the first time a Download node runs (or uses one from Homebrew).

## Development

The apps share one npm workspace, so a single install at the repo root covers all of them:

```sh
npm install
npm run toolbox            # build and open Toolbox from source
npm run toolbox:web        # Toolbox UI in a browser tab (no native ffmpeg or yt-dlp)
npm run dev -w dither      # run any single app in the browser
npm run build              # build every app
npm run typecheck          # type-check every app
npm test -w toolbox        # tests: toolbox, audio and pdf have them
```

Each app keeps its engine in `src/engine` with no DOM code, so Toolbox imports the engines in place and the standalone apps keep working.
