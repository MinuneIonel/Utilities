# PDF Lab

A PDF editor that runs entirely in the browser. Nothing is uploaded.

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build    # static site in dist/
```

## What it does

- **Pages**: merge any number of PDFs and images (PNG, JPEG, WebP, GIF, BMP), reorder by dragging, rotate, duplicate, delete, extract a selection.
- **Edit a page** (double-click it): add text, highlights, whiteout, boxes, freehand drawing, and images or signatures. Move, resize, restyle, undo.
- **Forms**: fill text fields, checkboxes, radio groups and dropdowns, optionally flatten them.
- **Whole document**: watermark, page numbers, title/author/subject/keywords, password and permissions, compression, split into a zip by every N pages or by ranges (`1-3; 4-6; 7-`).
- **Unlocks** password-protected PDFs: open with the password, download without one.
- Text outside Latin-1 (ș, ț, Cyrillic, Greek…) is drawn with an embedded subset of DejaVu Sans.

Whiteout only covers content visually; the text underneath is still in the file. It is not a redaction tool.

## Built on

We looked for existing projects before writing anything. Full editors like [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) (Java server) and BentoPDF (browser-only, built on the same libraries) are whole apps rather than parts we can plug into this repo's small Vite apps, so PDF Lab is a thin UI over the libraries those tools use:

| Library | License | Used for |
| --- | --- | --- |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | MIT | Building and changing PDFs: merging, rotating, drawing, forms, encryption. A maintained fork of pdf-lib that adds encryption and decryption. |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 | Rendering pages to thumbnails and to images for strong compression. |
| [@cantoo/fontkit](https://github.com/cantoo-scribe/fontkit) | MIT | Embedding the Unicode font. |
| [fflate](https://github.com/101arrowz/fflate) | MIT | Zipping split output. |
| [DejaVu Sans](https://dejavu-fonts.github.io/) | Bitstream Vera / public domain | Unicode text. |

## Layout

```
src/engine/   PDF engine: pure TypeScript over byte arrays, no DOM
src/render.ts pdf.js rendering (needs a canvas, so it lives outside the engine)
src/state.ts  app state, and toPlan() which turns it into engine input
src/ui/       page grid, page editor, side panel
test/         engine tests (vitest)
```

The engine is the part meant to be reused as a pipeline stage. Its input is a list of sources plus a plain-data `Plan`, its output is PDF bytes:

```ts
import { build, split, protect, compact, inspect, parseGroups } from "./src/engine";

const bytes = await build(
  [{ kind: "pdf", bytes: a }, { kind: "image", bytes: png, mime: "image/png" }],
  {
    pages: [
      { source: 0, page: 2 },
      { source: 1, page: 0, rotate: 90 },
      { source: 0, page: 0, overlays: [{ type: "text", x: 0.1, y: 0.1, text: "Approved", size: 14, color: [0, 0.5, 0] }] },
    ],
    watermark: { text: "DRAFT", size: 60, color: [1, 0, 0], opacity: 0.2, angle: 45 },
  },
);
const parts = await split(bytes, parseGroups("1-2; 3", 3));
const locked = await protect(bytes, { userPassword: "secret" });
```

Overlay positions are fractions (0 to 1) of the page as it is displayed, origin at the top-left, so they do not depend on page size or rotation.

Form fields stay editable on pages from the document the first page comes from. Forms in other merged documents are flattened, because a PDF can only carry one form.
