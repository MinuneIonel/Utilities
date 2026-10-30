// QR code generator: a link, text, Wi-Fi login, email, phone number or text message
// as a QR image (and as an SVG), ready for Save, Overlay, Dither or a PDF.
import type { NodeDef, Params, TextValue } from "../runtime/types";
import { PREVIEW_MAX } from "./file";
import { cellSize, parseColor, qrMatrix, qrPayload, qrToRgba, qrToSvg, type QrContent, type QrLevel } from "./qr-code";

const FIELDS: Record<QrContent["type"], string[]> = {
  text: ["text"],
  wifi: ["ssid", "password", "security", "hidden"],
  email: ["to", "subject", "body"],
  phone: ["to"],
  sms: ["to", "body"],
};
const CONTENT_KEYS = new Set(Object.values(FIELDS).flat());

function contentOf(p: Params, wired?: TextValue): QrContent {
  const type = (String(p.content) in FIELDS ? p.content : "text") as QrContent["type"];
  return {
    type,
    text: wired ? wired.text : String(p.text ?? ""),
    ssid: String(p.ssid ?? ""),
    password: String(p.password ?? ""),
    security: (["WPA", "WEP", "nopass"].includes(String(p.security)) ? p.security : "WPA") as QrContent["security"],
    hidden: p.hidden === true,
    to: String(p.to ?? ""),
    subject: String(p.subject ?? ""),
    body: String(p.body ?? ""),
  };
}

export const qrCode: NodeDef = {
  type: "input.qr",
  title: "QR code",
  category: "input",
  description:
    "Makes a QR code from a link or text, Wi-Fi details (phones join the network), an email, a phone number or a text message. Wire text into it to encode that instead. Save writes the image as a PNG, or the SVG output as a scalable .svg.",
  inputs: [{ key: "text", label: "Text", type: "text", optional: true }],
  outputs: [
    { key: "image", label: "Image", type: "image" },
    { key: "svg", label: "SVG", type: "text" },
  ],
  params: [
    {
      key: "content",
      label: "Content",
      kind: "select",
      options: [
        { value: "text", label: "Link or text" },
        { value: "wifi", label: "Wi-Fi network" },
        { value: "email", label: "Email" },
        { value: "phone", label: "Phone number" },
        { value: "sms", label: "Text message" },
      ],
    },
    { key: "text", label: "Link or text", kind: "text", multiline: true, placeholder: "https://…" },
    { key: "ssid", label: "Network name", kind: "text" },
    { key: "password", label: "Password", kind: "text" },
    {
      key: "security",
      label: "Security",
      kind: "select",
      options: [
        { value: "WPA", label: "WPA / WPA2 / WPA3" },
        { value: "WEP", label: "WEP" },
        { value: "nopass", label: "None (open)" },
      ],
    },
    { key: "hidden", label: "Hidden network", kind: "toggle" },
    { key: "to", label: "To", kind: "text", placeholder: "name@example.com or +40…" },
    { key: "subject", label: "Subject", kind: "text" },
    { key: "body", label: "Message", kind: "text", multiline: true },
    { key: "size", label: "Size px", kind: "number", min: 64, max: 4096, step: 16 },
    {
      key: "level",
      label: "Error correction",
      kind: "select",
      options: [
        { value: "L", label: "Low (7%): smallest code" },
        { value: "M", label: "Medium (15%)" },
        { value: "Q", label: "Quartile (25%)" },
        { value: "H", label: "High (30%): survives a logo on top" },
      ],
    },
    { key: "margin", label: "Margin (squares)", kind: "number", min: 0, max: 10, step: 1, advanced: true },
    { key: "dark", label: "Colour", kind: "text", commit: true, placeholder: "#000000", advanced: true },
    { key: "light", label: "Background", kind: "text", commit: true, placeholder: "#ffffff", advanced: true },
    { key: "transparent", label: "Transparent background", kind: "toggle", advanced: true },
  ],
  defaults: () => ({
    content: "text",
    text: "https://github.com/MinuneIonel/Utilities",
    ssid: "",
    password: "",
    security: "WPA",
    hidden: false,
    to: "",
    subject: "",
    body: "",
    size: 1024,
    level: "M",
    margin: 4,
    dark: "#000000",
    light: "#ffffff",
    transparent: false,
  }),
  visible(key, p) {
    if (!CONTENT_KEYS.has(key)) return key !== "light" || p.transparent !== true;
    const fields = FIELDS[(String(p.content) in FIELDS ? p.content : "text") as QrContent["type"]];
    if (!fields.includes(key)) return false;
    return key !== "password" || p.security !== "nopass";
  },
  kind: "frame",
  // Preview draws a smaller image when Size is above the preview cap.
  cacheKey: (_p, ctx) => ctx.mode,
  async run(inputs, params, ctx) {
    const payload = qrPayload(contentOf(params, inputs.text as TextValue | undefined));
    if (!payload.trim()) throw new Error("Nothing to put in the QR code yet: fill in the content.");
    const matrix = qrMatrix(payload, (["L", "M", "Q", "H"].includes(String(params.level)) ? params.level : "M") as QrLevel);
    const full = Math.max(16, Number(params.size) || 1024);
    const opts = {
      size: full,
      margin: Math.max(0, Math.round(Number(params.margin ?? 4))),
      dark: parseColor(String(params.dark ?? ""), [0, 0, 0, 255]),
      light: params.transparent === true ? ([0, 0, 0, 0] as [number, number, number, number]) : parseColor(String(params.light ?? ""), [255, 255, 255, 255]),
    };
    const svg = qrToSvg(matrix, opts);
    const preview = ctx.mode === "preview" && full > PREVIEW_MAX;
    const img = qrToRgba(matrix, preview ? { ...opts, size: PREVIEW_MAX } : opts);
    const fullWidth = cellSize(matrix, opts) * (matrix.size + 2 * opts.margin);
    return {
      image: { kind: "image", ...img, ...(preview ? { scale: img.width / fullWidth } : {}) },
      svg: { kind: "text", text: svg, format: "svg" },
    };
  },
};
