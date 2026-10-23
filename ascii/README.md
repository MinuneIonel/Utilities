# ASCII Lab

A browser app that turns images, video files and webcam input into ASCII art. Pick a character set, tune tone and color, then copy the text or export it as TXT, HTML, ANSI, SVG, PNG or video.

```sh
cd ascii
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## Features

- **Sources:** open, drop or paste an image; open a video file; or use the webcam. Video renders live.
- **Characters:** Classic, Detailed (70 characters), Minimal, Blocks, Dots, Lines, Digits, Katakana, or your own set. *Sort by ink* reorders any set by how much ink each character really uses in the chosen font.
- **Braille mode:** each character holds 2×4 dots, for four times the detail of a normal ramp.
- **Edge lines:** draws `- | / \` along edges so outlines read like hand-drawn ASCII. *Edges only* leaves everything else blank, for line art.
- **Tone:** brightness, contrast, gamma, invert, auto levels, and dithering across the character ramp (Bayer, Floyd–Steinberg, Atkinson), which keeps detail at low column counts.
- **Color:** one ink color with themes (terminal green, amber, paper, blueprint…), or the source's own colors per character. Background can be any color or transparent. Dark ink on a light background flips the ramp automatically.
- **Presets:** 10 starters, save your own (stored in the browser), share as a link, or export/import JSON.
- **Export:** copy as text; download TXT, a colored HTML page, ANSI with 24-bit color (`cat file.ans` in a terminal), SVG with real text, PNG at 1×, 2× or 4× (re-rendered, so text stays sharp), and video recording (MP4 or WebM, depending on the browser).
- Hold <kbd>Space</kbd> to compare with the original. Ctrl/⌘ + scroll zooms.

## Layout

```
src/engine/   pure TypeScript, no DOM: settings, character sets, conversion, text exports
src/render.ts glyph atlas and canvas drawing
src/ui/       settings panel
src/main.ts   sources, viewer, presets menu, export
```

The engine takes an RGBA frame and returns a grid of character codes and colors (`convert` in `src/engine/convert.ts`), with no browser dependencies, so it can later run as one stage of a bigger pipeline.
