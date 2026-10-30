// QR codes: what goes in them (a link, Wi-Fi details, an email…), the grid of squares,
// and that grid drawn as RGBA pixels or as an SVG. No DOM, so it runs in Node tests too.
import qrcode from "qrcode-generator";

export type QrLevel = "L" | "M" | "Q" | "H";

export interface QrContent {
  type: "text" | "wifi" | "email" | "phone" | "sms";
  text?: string;
  ssid?: string;
  password?: string;
  security?: "WPA" | "WEP" | "nopass";
  hidden?: boolean;
  to?: string;
  subject?: string;
  body?: string;
}

// Wi-Fi fields escape \ ; , : and " with a backslash (the format phones read).
const wifiEscape = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");

/** The text a phone reads out of the code for each kind of content. */
export function qrPayload(c: QrContent): string {
  switch (c.type) {
    case "wifi": {
      const security = c.security ?? "WPA";
      const pass = security === "nopass" ? "" : `P:${wifiEscape(c.password ?? "")};`;
      return `WIFI:T:${security};S:${wifiEscape(c.ssid ?? "")};${pass}${c.hidden ? "H:true;" : ""};`;
    }
    case "email": {
      const q = [
        c.subject ? `subject=${encodeURIComponent(c.subject)}` : "",
        c.body ? `body=${encodeURIComponent(c.body)}` : "",
      ].filter(Boolean);
      return `mailto:${(c.to ?? "").trim()}${q.length ? `?${q.join("&")}` : ""}`;
    }
    case "phone":
      return `tel:${(c.to ?? "").replace(/[^\d+*#]/g, "")}`;
    case "sms":
      return `SMSTO:${(c.to ?? "").replace(/[^\d+*#]/g, "")}:${c.body ?? ""}`;
    default:
      return c.text ?? "";
  }
}

/** The grid of squares: `dark[row * size + col]`. Picks the smallest QR version that fits. */
export interface QrMatrix {
  size: number;
  dark: Uint8Array;
}

export function qrMatrix(text: string, level: QrLevel = "M"): QrMatrix {
  const qr = qrcode(0, level);
  // The library reads one byte per character, so hand it the UTF-8 bytes that way:
  // accents, ș and emoji then scan back as typed.
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  qr.addData(binary, "Byte");
  try {
    qr.make();
  } catch {
    throw new Error(`Too much text for a QR code (${bytes.length} bytes). Use less text or a lower error correction.`);
  }
  const size = qr.getModuleCount();
  const dark = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark[r * size + c] = qr.isDark(r, c) ? 1 : 0;
  return { size, dark };
}

/** #rgb, #rrggbb or #rrggbbaa (the # is optional) to RGBA; `fallback` when it isn't one. */
export function parseColor(s: string, fallback: [number, number, number, number]): [number, number, number, number] {
  let h = s.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(h)) h = [...h].map((ch) => ch + ch).join("");
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return fallback;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

export interface QrDrawOptions {
  /** Width and height of the whole image, quiet zone included. Rounded down to whole pixels per square. */
  size: number;
  /** Blank squares around the code; scanners want 4, 2 usually works. */
  margin: number;
  dark: [number, number, number, number];
  light: [number, number, number, number];
}

/** Pixels per square: every square the same whole number of pixels, so edges stay sharp. */
export function cellSize(m: QrMatrix, o: Pick<QrDrawOptions, "size" | "margin">): number {
  return Math.max(1, Math.floor(o.size / (m.size + 2 * o.margin)));
}

export function qrToRgba(m: QrMatrix, o: QrDrawOptions): { width: number; height: number; data: Uint8ClampedArray } {
  const cell = cellSize(m, o);
  const side = (m.size + 2 * o.margin) * cell;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    const r = Math.floor(y / cell) - o.margin;
    for (let x = 0; x < side; x++) {
      const c = Math.floor(x / cell) - o.margin;
      const on = r >= 0 && c >= 0 && r < m.size && c < m.size && m.dark[r * m.size + c] === 1;
      data.set(on ? o.dark : o.light, (y * side + x) * 4);
    }
  }
  return { width: side, height: side, data };
}

const hex = (c: [number, number, number, number]) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
const opacity = (c: [number, number, number, number]) => (c[3] < 255 ? ` fill-opacity="${+(c[3] / 255).toFixed(3)}"` : "");

/** A scalable SVG: one path for every dark square, sized to `o.size` px. */
export function qrToSvg(m: QrMatrix, o: QrDrawOptions): string {
  const side = m.size + 2 * o.margin;
  const px = cellSize(m, o) * side;
  let d = "";
  for (let r = 0; r < m.size; r++) {
    // Runs of dark squares in a row become one rectangle.
    for (let c = 0; c < m.size; c++) {
      if (!m.dark[r * m.size + c]) continue;
      let end = c;
      while (end + 1 < m.size && m.dark[r * m.size + end + 1]) end++;
      d += `M${c + o.margin} ${r + o.margin}h${end - c + 1}v1h${-(end - c + 1)}z`;
      c = end;
    }
  }
  const bg = o.light[3] === 0 ? "" : `<rect width="${side}" height="${side}" fill="${hex(o.light)}"${opacity(o.light)}/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${px}" height="${px}" shape-rendering="crispEdges">` +
    `${bg}<path d="${d}" fill="${hex(o.dark)}"${opacity(o.dark)}/></svg>\n`
  );
}
