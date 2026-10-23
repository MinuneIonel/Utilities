# Media Lab

A browser app to resize, crop, rotate, compress and convert images and videos, one file or a whole batch at a time. Everything runs locally in the browser; nothing is uploaded.

```sh
cd media
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Works best in Chrome or Edge (fastest video encoding). Safari and Firefox work too, with fewer video codecs.

## Built on

Instead of writing codecs from scratch, the app wires together existing open-source projects:

| Library | Used for |
| --- | --- |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) | Video: reads and writes MP4, MOV, WebM, MKV; crop, resize, rotate, trim and re-encode with the browser's hardware encoders (WebCodecs). Fast. |
| [jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0) | Images: the codecs from Google's [Squoosh](https://github.com/GoogleChromeLabs/squoosh): MozJPEG, libwebp, libavif, oxipng, and its Lanczos resizer. |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (core is GPL-2.0) | Fallback for anything Mediabunny can't read (AVI, WMV, FLV, MPEG-4 Part 2, GIF input…) and for animated GIF output. Loaded only when needed (~32 MB, slower). |
| [fflate](https://github.com/101arrowz/fflate) (MIT) | "Download all" as a .zip. |

## Features

- **Batch:** add, drop or paste many files. Settings apply to every image or every video; crop, rotate and trim belong to each file. *Apply to all* copies one file's crop to the rest.
- **Crop:** drag the box or its handles, or type X/Y/W/H. Aspect presets: 1:1, 4:3, 3:2, 16:9, 9:16, 4:5, 21:9, original.
- **Rotate and flip** in 90° steps.
- **Resize:** by percent, to a width and/or height (fit inside, fill and trim, or stretch), or by longest side. Never enlarges unless you allow it.
- **Image output:** JPEG (MozJPEG), WebP, AVIF, PNG (oxipng optimized), or same as input. Quality slider, lossless WebP/AVIF, background color for transparent areas in JPEG, and **max file size**: it searches for the highest quality that fits.
- **Video output:** MP4, WebM, MOV, MKV or animated GIF. Codec H.264, HEVC, AV1, VP9, VP8 or automatic. Compress by quality level, **target file size**, or bitrate; or *no re-encode* for instant trims and container changes. Frame rate, keep/remove audio, audio bitrate.
- **Trim:** type start and end, or play the video and press <kbd>I</kbd> / <kbd>O</kbd>. Preview loops inside the trim.
- **Compare:** switch between *Original* and *Result*; sizes and the % saved are shown for every file.

## Layout

```
src/engine/       no UI code; typed inputs and outputs
  types.ts        job types, geometry planner (crop → rotate → flip → resize)
  raster.ts       crop / rotate / flip on RGBA frames
  decode.ts       Blob → RGBA (createImageBitmap + OffscreenCanvas, works in workers)
  image.ts        RGBA + ImageJob → encoded image (jSquash)
  video.ts        Blob + VideoJob → encoded video (Mediabunny, falls back to ffmpeg.ts)
  ffmpeg.ts       ffmpeg.wasm fallback and GIF output
src/image-worker.ts  runs image jobs off the main thread (a small pool)
src/ui/crop.ts    crop box
src/main.ts       queue, viewer, settings panel
```

Each engine function (`decodeImage`, `transformImage`, `processImage`, `probeVideo`, `processVideo`) is a self-contained step with plain data in and out, so it can become a stage of a larger pipeline later.

## Notes

- HEIC photos open only in Safari (other browsers can't decode them).
- In the ffmpeg.wasm fallback, WebM uses VP8 (its VP9 encoder crashes in the single-threaded build) and AV1 is not available.
