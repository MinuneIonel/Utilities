# Utilities

Small apps for useful things.

| App | What it does |
| --- | --- |
| [dither](dither/) | Dither Lab: image, video and webcam dithering with an effect stack and shareable recipes. |
| [ascii](ascii/) | ASCII Lab: image, video and webcam to ASCII art, with braille, edge lines, color and text/HTML/ANSI/SVG export. |
| [diacritics](diacritics/) | Diacritice: restores Romanian diacritics (ă â î ș ț) in text typed without them, offline, no LLM. |
| [audio](audio/) | Audio Lab: convert, compress, resample and trim audio (and the audio of videos) locally with ffmpeg.wasm. |
| [media](media/) | Media Lab: resize, crop, rotate, compress and convert images and videos in batches (MozJPEG/WebP/AVIF/PNG, MP4/WebM/MOV/MKV/GIF), with trim and target file size. |
| [pdf](pdf/) | PDF Lab: merge, reorder, rotate and split pages, add text, highlights, drawings and images, fill forms, watermark, number pages, password-protect and compress PDFs. |
| [toolbox](toolbox/) | Toolbox: a desktop app (Electron) that wires the tools above together as a node graph, with live preview and Render. |

## Setup

The apps share one npm workspace, so a single install at the repo root covers all of them:

```sh
npm install
npm run toolbox            # build and open the Toolbox desktop app
npm run dev -w dither      # or run any single app in the browser
```
