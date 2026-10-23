# Dither Lab

A browser app for dithering images, video files and webcam input. Build a stack of effects, save it as a recipe, and export PNG, SVG or video.

```sh
cd dither
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## Features

- **Sources:** open, drop or paste an image; open a video file; or use the webcam. Video renders live.
- **Effect stack:** Adjust, Blur, Sharpen, Posterize, Grain, Edges, Gradient map and Dither. Steps can be reordered by dragging, toggled, duplicated and reset. Double-click a slider to reset it.
- **Dithering:** Floyd–Steinberg, False Floyd–Steinberg, Atkinson, Jarvis–Judice–Ninke, Stucki, Burkes, Sierra, Sierra two-row, Sierra Lite, Bayer 2/4/8/16, blue noise (void-and-cluster), white noise, halftone dots/lines/squares/diamonds, and plain threshold.
- **Palettes:** 17 presets (1-bit, Mac, Game Boy, CGA, EGA, PICO-8, C64, ZX Spectrum, e-ink, Riso and more), custom palettes (paste hex codes), or extract one from the source with median cut.
- **Recipes:** 8 starters, save your own (stored in the browser), share as a link, or export/import JSON.
- **Export:** PNG at 1×–8× or source size, SVG with one path per palette color, and video recording (MP4 or WebM, depending on the browser).
- Hold <kbd>Space</kbd> to compare with the original. Ctrl/⌘ + scroll zooms.

## Layout

```
src/engine/   pure TypeScript, no DOM: palettes, color matching, filters, dither algorithms, recipes
src/worker.ts runs the engine off the main thread
src/ui/       effect stack panel
src/main.ts   sources, viewer, recipes menu, export
plugins/      Resolume, TouchDesigner, Resolve and Photoshop versions
```

The engine has no browser dependencies; the Photoshop plugin bundles it directly.

## Plugins

Resolume, TouchDesigner, DaVinci Resolve and Photoshop versions live in [`plugins/`](plugins/). See the [plugin README](plugins/README.md) for install steps.
