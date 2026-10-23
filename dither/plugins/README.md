# Dither Lab plugins

| Host | File | What you get |
| --- | --- | --- |
| Resolume Arena / Avenue 7.8+ | `resolume/DitherLab.fs` | Live effect (ISF) |
| TouchDesigner | `touchdesigner/create_dither_lab.py` | A `dither_lab` component with custom parameters |
| DaVinci Resolve Studio | `resolve/DitherLab.dctl` | DCTL effect |
| Photoshop 2024 (25.0)+ | `photoshop/dist/` | Panel that applies Dither Lab recipes to a layer |

The three video plugins share one shader core with the app's 17 palettes and halftone curves. They include Bayer 2/4/8/16, interleaved-gradient (blue-ish) noise, white noise, halftone dots/lines/squares/diamonds and threshold, plus brightness, contrast, gamma, saturation and invert. Resolume and TouchDesigner also take a custom palette of up to 8 colors.

Error diffusion (Floyd–Steinberg, Atkinson and the rest) processes pixels one after another, so it can't run as a GPU shader. It's available in the app and in the Photoshop panel.

## Resolume

Copy `resolume/DitherLab.fs` into your Extra Effects folder and restart Resolume:

- macOS: `~/Documents/Resolume Arena/Extra Effects/`
- Windows: `Documents\Resolume Arena\Extra Effects\`

(Use `Resolume Avenue` in the path for Avenue.) It appears in the Effects browser as **DitherLab**. The same file also works in other ISF hosts such as VDMX and Millumin.

## TouchDesigner

1. Open the Textport (Dialogs → Textport and DATs).
2. Run `exec(open('/full/path/to/create_dither_lab.py').read())`.
3. A `dither_lab` component appears in the current network. Wire a TOP into it; the controls are on its **Dither** and **Custom Palette** parameter pages.
4. To reuse it, right-click the component and choose **Save Component .tox…**.

`touchdesigner/dither_lab.glsl` is the bare GLSL TOP pixel shader, if you'd rather wire it up yourself.

## DaVinci Resolve

DCTL effects need Resolve Studio.

1. Copy `resolve/DitherLab.dctl` into the LUT folder:
   - macOS: `/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/`
   - Windows: `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\LUT\`
2. Restart Resolve, or click **Update Lists** in Project Settings → Color Management.
3. On the Color page, add the **DCTL** effect to a node and pick **DitherLab** from its DCTL list.

## Photoshop

1. Install Adobe's **UXP Developer Tool** from the Creative Cloud app.
2. Click **Add Plugin**, choose `photoshop/dist/manifest.json`, then **Load**.
3. Open it from Plugins → Dither Lab.

Pick a starter recipe, or paste a **Share link** or exported recipe JSON from the app under "Import from the app". **Apply to layer** dithers the selected pixel layer, onto a new copy by default. It runs on the main thread, so very large images take a few seconds.

To package it for installing without the Developer Tool, use **Package** in the UXP Developer Tool to make a `.ccx` file.

## Rebuilding

The shader files and the Photoshop bundle are generated. After changing the engine or palettes:

```sh
npm run plugins
```
