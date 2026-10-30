import assert from "node:assert/strict";
import { test } from "node:test";
import jsQR from "jsqr";
import { parseColor, qrMatrix, qrPayload, qrToRgba, qrToSvg } from "../src/nodes/qr-code.ts";

const BW = { dark: [0, 0, 0, 255], light: [255, 255, 255, 255] } as const;

function scan(text: string, level: "L" | "M" | "Q" | "H" = "M") {
  const m = qrMatrix(text, level);
  const img = qrToRgba(m, { size: 400, margin: 4, dark: [...BW.dark], light: [...BW.light] });
  return jsQR(img.data, img.width, img.height)?.data;
}

test("a link scans back as typed", () => {
  assert.equal(scan("https://github.com/MinuneIonel/Utilities"), "https://github.com/MinuneIonel/Utilities");
});

test("accents, Romanian letters and emoji survive as UTF-8", () => {
  const text = "Șapte țânțari în cămară 🎉";
  for (const level of ["L", "M", "Q", "H"] as const) assert.equal(scan(text, level), text);
});

test("every square is the same whole number of pixels", () => {
  const m = qrMatrix("hi");
  assert.equal(m.size, 21);
  const img = qrToRgba(m, { size: 1000, margin: 4, dark: [...BW.dark], light: [...BW.light] });
  // 21 + 2×4 = 29 squares; 1000 / 29 rounds down to 34 px each.
  assert.equal(img.width, 29 * 34);
  assert.equal(img.width, img.height);
  // The top-left finder starts right after the margin.
  assert.deepEqual([...img.data.slice(0, 4)], [255, 255, 255, 255]);
  const at = (4 * 34 * img.width + 4 * 34) * 4;
  assert.deepEqual([...img.data.slice(at, at + 4)], [0, 0, 0, 255]);
});

test("too much text says so", () => {
  assert.throws(() => qrMatrix("x".repeat(4000), "H"), /Too much text/);
});

test("Wi-Fi details in the format phones join from", () => {
  assert.equal(qrPayload({ type: "wifi", ssid: "Casa", password: "p;a:ss", security: "WPA" }), "WIFI:T:WPA;S:Casa;P:p\\;a\\:ss;;");
  assert.equal(qrPayload({ type: "wifi", ssid: "Cafe", password: "ignored", security: "nopass", hidden: true }), "WIFI:T:nopass;S:Cafe;H:true;;");
});

test("email, phone and text message links", () => {
  assert.equal(qrPayload({ type: "email", to: " a@b.ro ", subject: "Salut ce faci", body: "" }), "mailto:a@b.ro?subject=Salut%20ce%20faci");
  assert.equal(qrPayload({ type: "phone", to: "+40 721 000 000" }), "tel:+40721000000");
  assert.equal(qrPayload({ type: "sms", to: "0721-000-000", body: "Hi" }), "SMSTO:0721000000:Hi");
});

test("colours: #rgb, #rrggbb, #rrggbbaa, or the fallback", () => {
  assert.deepEqual(parseColor("#f00", [0, 0, 0, 255]), [255, 0, 0, 255]);
  assert.deepEqual(parseColor("e8ff59", [0, 0, 0, 255]), [232, 255, 89, 255]);
  assert.deepEqual(parseColor("#00000080", [0, 0, 0, 255]), [0, 0, 0, 128]);
  assert.deepEqual(parseColor("blue", [1, 2, 3, 4]), [1, 2, 3, 4]);
});

test("SVG has a background unless it's transparent", () => {
  const m = qrMatrix("hi");
  const svg = qrToSvg(m, { size: 290, margin: 4, dark: [255, 0, 0, 255], light: [255, 255, 255, 255] });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29" width="290" height="290"/);
  assert.match(svg, /<rect width="29" height="29" fill="#ffffff"\/>/);
  assert.match(svg, /<path d="M4 4h7v1h-7z/);
  assert.match(svg, /fill="#ff0000"/);
  assert.doesNotMatch(qrToSvg(m, { size: 290, margin: 4, dark: [0, 0, 0, 255], light: [0, 0, 0, 0] }), /<rect/);
});
