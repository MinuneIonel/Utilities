import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  build,
  compact,
  everyN,
  fromRaster,
  inspect,
  parseGroups,
  parseRanges,
  protect,
  split,
  toPdf,
  type Source,
} from "../src/engine";

const font = new Uint8Array(readFileSync(createRequire(import.meta.url).resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf")));

// 1x1 red PNG
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

async function makePdf(label: string, pages: number, opts: { form?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([600, 800]);
    p.drawText(`${label}${i + 1}`, { x: 50, y: 700, size: 24, font: helv });
  }
  if (opts.form) {
    const form = doc.getForm();
    form.createTextField("name").addToPage(doc.getPage(0), { x: 50, y: 500, width: 200, height: 24 });
    form.createCheckBox("agree").addToPage(doc.getPage(0), { x: 50, y: 450, width: 16, height: 16 });
    const dd = form.createDropdown("color");
    dd.addOptions(["red", "green"]);
    dd.addToPage(doc.getPage(0), { x: 50, y: 400, width: 100, height: 20 });
  }
  doc.setTitle(`${label} doc`);
  return doc.save();
}

async function pageTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), password });
  const doc = await task.promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(
      tc.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  await task.destroy();
  return out;
}

const pdf = (bytes: Uint8Array): Source => ({ kind: "pdf", bytes });

describe("ranges", () => {
  it("parses lists, open ends and reverse runs", () => {
    expect(parseRanges("1-3, 5", 6)).toEqual([0, 1, 2, 4]);
    expect(parseRanges("4-", 6)).toEqual([3, 4, 5]);
    expect(parseRanges("-2", 6)).toEqual([0, 1]);
    expect(parseRanges("3-1", 6)).toEqual([2, 1, 0]);
    expect(() => parseRanges("7", 6)).toThrow();
    expect(() => parseRanges("a", 6)).toThrow();
  });
  it("groups and chunks", () => {
    expect(parseGroups("1-2; 3-", 4)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(everyN(2, 5)).toEqual([[0, 1], [2, 3], [4]]);
  });
});

describe("geometry", () => {
  const frame = { x0: 0, y0: 0, width: 600, height: 800 };
  it("maps the visual top-left corner for every rotation", () => {
    expect(toPdf({ ...frame, rotation: 0 }, 0, 0)).toEqual({ x: 0, y: 800 });
    expect(toPdf({ ...frame, rotation: 90 }, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(toPdf({ ...frame, rotation: 180 }, 0, 0)).toEqual({ x: 600, y: 0 });
    expect(toPdf({ ...frame, rotation: 270 }, 0, 0)).toEqual({ x: 600, y: 800 });
  });
});

describe("build", () => {
  it("merges, reorders, duplicates and drops pages", async () => {
    const a = await makePdf("A", 3);
    const b = await makePdf("B", 2);
    const out = await build([pdf(a), pdf(b)], {
      pages: [
        { source: 1, page: 1 },
        { source: 0, page: 2 },
        { source: 0, page: 0 },
        { source: 0, page: 0 },
      ],
    });
    expect(await pageTexts(out)).toEqual(["B2", "A3", "A1", "A1"]);
  });

  it("rotates pages on top of their own rotation", async () => {
    const doc = await PDFDocument.load(await makePdf("A", 1));
    doc.getPage(0).setRotation(degrees(90));
    const out = await build([pdf(await doc.save())], { pages: [{ source: 0, page: 0, rotate: 90 }] });
    const info = await inspect(pdf(out));
    expect(info.pages[0].rotation).toBe(180);
  });

  it("turns images into pages", async () => {
    const out = await build([{ kind: "image", bytes: PNG, mime: "image/png" }], {
      pages: [{ source: 0, page: 0 }],
    });
    const info = await inspect(pdf(out));
    expect(info.pageCount).toBe(1);
    expect(info.pages[0].width).toBeCloseTo(0.75);
  });

  it("draws text overlays, watermark and page numbers, with Unicode when given a font", async () => {
    const a = await makePdf("A", 2);
    const out = await build([pdf(a)], {
      pages: [
        {
          source: 0,
          page: 0,
          overlays: [{ type: "text", x: 0.1, y: 0.1, text: "Hello", size: 12, color: [0, 0, 0] }],
        },
        {
          source: 0,
          page: 1,
          rotate: 90,
          overlays: [
            { type: "text", x: 0.1, y: 0.1, text: "Șase țânțari", size: 12, color: [0, 0, 0] },
            {
              type: "rect",
              box: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
              fill: [1, 1, 0],
              opacity: 0.4,
              blend: "multiply",
            },
            { type: "image", box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, image: 0 },
            {
              type: "ink",
              points: [
                [0.1, 0.9],
                [0.2, 0.8],
                [0.3, 0.9],
              ],
              color: [1, 0, 0],
              width: 2,
            },
          ],
        },
      ],
      images: [{ bytes: PNG, mime: "image/png" }],
      watermark: { text: "DRAFT", size: 60, color: [1, 0, 0], opacity: 0.2, angle: 45 },
      pageNumbers: {
        format: "{n} / {total}",
        position: "bottom-center",
        size: 10,
        color: [0, 0, 0],
        start: 1,
      },
      metadata: { title: "Merged" },
      font,
    });
    const texts = await pageTexts(out);
    expect(texts[0]).toContain("Hello");
    expect(texts[0]).toContain("DRAFT");
    expect(texts[0]).toContain("1 / 2");
    expect(texts[1]).toContain("Șase țânțari");
    expect((await inspect(pdf(out))).metadata.title).toBe("Merged");
  });

  it("refuses non Latin-1 text without a font", async () => {
    const a = await makePdf("A", 1);
    await expect(
      build([pdf(a)], {
        pages: [
          {
            source: 0,
            page: 0,
            overlays: [{ type: "text", x: 0, y: 0, text: "ș", size: 12, color: [0, 0, 0] }],
          },
        ],
      }),
    ).rejects.toThrow(/Unicode font/);
  });

  it("fills forms and keeps them editable, or flattens them", async () => {
    const a = await makePdf("A", 2, { form: true });
    const before = await inspect(pdf(a));
    expect(before.fields.map((f) => f.name).sort()).toEqual(["agree", "color", "name"]);

    const forms = { 0: { name: "Ana Popescu", agree: true, color: "green" } };
    const kept = await build([pdf(a)], { pages: [{ source: 0, page: 0 }], forms });
    const fields = Object.fromEntries((await inspect(pdf(kept))).fields.map((f) => [f.name, f.value]));
    expect(fields).toEqual({ name: "Ana Popescu", agree: true, color: "green" });

    const flat = await build([pdf(a)], { pages: [{ source: 0, page: 0 }], forms, flattenForms: true });
    expect((await inspect(pdf(flat))).fields).toEqual([]);
  });

  it("drops fields whose pages were removed", async () => {
    const a = await makePdf("A", 2, { form: true });
    const out = await build([pdf(a)], { pages: [{ source: 0, page: 1 }] });
    expect((await inspect(pdf(out))).fields).toEqual([]);
  });

  it("flattens forms of documents merged after the first", async () => {
    const a = await makePdf("A", 1);
    const b = await makePdf("B", 1, { form: true });
    const out = await build([pdf(a), pdf(b)], {
      pages: [
        { source: 0, page: 0 },
        { source: 1, page: 0 },
      ],
      forms: { 1: { name: "Ion" } },
    });
    expect((await inspect(pdf(out))).fields).toEqual([]);
    expect((await pageTexts(out))[1]).toContain("Ion");
  });
});

describe("whole-file tools", () => {
  it("splits into groups", async () => {
    const a = await makePdf("A", 4);
    const parts = await split(a, parseGroups("1-2; 4", 4));
    expect(await Promise.all(parts.map((p) => pageTexts(p)))).toEqual([["A1", "A2"], ["A4"]]);
  });

  it("password-protects and opens again with the password", async () => {
    const a = await makePdf("A", 1);
    const locked = await protect(a, { userPassword: "secret", allowCopying: false });
    await expect(inspect(pdf(locked))).rejects.toThrow(/password/i);
    expect(await pageTexts(locked, "secret")).toEqual(["A1"]);
    // Opening with the password and building again removes the protection.
    const open = await build([{ kind: "pdf", bytes: locked, password: "secret" }], {
      pages: [{ source: 0, page: 0 }],
    });
    expect(await pageTexts(open)).toEqual(["A1"]);
  });

  it("compacts without growing the file", async () => {
    const a = await makePdf("A", 3);
    const out = await compact(a);
    expect(out.length).toBeLessThanOrEqual(a.length);
    expect(await pageTexts(out)).toEqual(["A1", "A2", "A3"]);
  });

  it("builds a PDF from page pictures", async () => {
    const out = await fromRaster([{ bytes: PNG, mime: "image/png", width: 600, height: 800 }], {
      title: "Scan",
    });
    const info = await inspect(pdf(out));
    expect(info.pages[0]).toEqual({ width: 600, height: 800, rotation: 0 });
    expect(info.metadata.title).toBe("Scan");
  });
});
