// Text and/or a logo on top of an image: a watermark, a caption, a credit. As a frame
// node it also goes on every frame of a video and every image of a list.
import type { ImageValue, NodeDef } from "../runtime/types";

const POSITIONS = [
  ["top-left", "Top left"],
  ["top", "Top"],
  ["top-right", "Top right"],
  ["left", "Left"],
  ["center", "Centre"],
  ["right", "Right"],
  ["bottom-left", "Bottom left"],
  ["bottom", "Bottom"],
  ["bottom-right", "Bottom right"],
] as const;

const COLORS: Record<string, string> = { white: "#ffffff", black: "#000000", yellow: "#e8ff59", red: "#ff3b30" };

function canvasOf(img: ImageValue) {
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return { c, g };
}

export const overlay: NodeDef = {
  type: "image.overlay",
  title: "Text / logo overlay",
  category: "image",
  description:
    "Puts text, a logo (wire an image into Logo), or both on top of the image: a watermark, a caption, a credit. Sizes are a share of the image, so the preview matches the render. On a video or a list of images it goes on every one.",
  inputs: [
    { key: "image", label: "Image", type: "image" },
    { key: "logo", label: "Logo", type: "image", optional: true },
  ],
  outputs: [{ key: "image", label: "Image", type: "image" }],
  params: [
    { key: "text", label: "Text", kind: "text" },
    { key: "position", label: "Position", kind: "select", options: POSITIONS.map(([value, label]) => ({ value, label })) },
    { key: "size", label: "Text size %", kind: "number", min: 1, max: 30, step: 0.5 },
    {
      key: "color",
      label: "Colour",
      kind: "select",
      options: [
        { value: "white", label: "White" },
        { value: "black", label: "Black" },
        { value: "yellow", label: "Yellow" },
        { value: "red", label: "Red" },
      ],
    },
    { key: "opacity", label: "Opacity %", kind: "number", min: 5, max: 100, step: 1 },
    { key: "logoSize", label: "Logo width %", kind: "number", min: 2, max: 100, step: 1 },
    { key: "margin", label: "Margin %", kind: "number", min: 0, max: 20, step: 0.5 },
    { key: "shadow", label: "Shadow", kind: "toggle" },
  ],
  defaults: () => ({ text: "© Your name", position: "bottom-right", size: 4, color: "white", opacity: 85, logoSize: 15, margin: 3, shadow: true }),
  kind: "frame",
  async run(inputs, params) {
    const img = inputs.image as ImageValue;
    const logo = inputs.logo as ImageValue | undefined;
    const { c, g } = canvasOf(img);
    // One unit is 1% of the shorter side, so portrait and landscape look alike.
    const u = Math.min(img.width, img.height) / 100;
    const margin = Number(params.margin ?? 3) * u;
    const fontPx = Math.max(4, Number(params.size ?? 4) * u);
    const lines = String(params.text ?? "").split("\n").filter((l) => l.trim());
    g.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const lineH = fontPx * 1.2;
    const textW = Math.max(0, ...lines.map((l) => g.measureText(l).width));
    const textH = lines.length * lineH;
    const logoW = logo ? (img.width * Number(params.logoSize ?? 15)) / 100 : 0;
    const logoH = logo ? (logoW * logo.height) / logo.width : 0;
    const gap = logo && lines.length ? fontPx * 0.4 : 0;
    const blockW = Math.max(textW, logoW);
    const blockH = logoH + gap + textH;
    if (!blockW || !blockH) return { image: img };

    const pos = String(params.position || "bottom-right");
    const h = pos.endsWith("left") || pos === "left" ? "left" : pos.endsWith("right") || pos === "right" ? "right" : "center";
    const v = pos.startsWith("top") ? "top" : pos.startsWith("bottom") ? "bottom" : "middle";
    const x0 = h === "left" ? margin : h === "right" ? img.width - margin - blockW : (img.width - blockW) / 2;
    const y0 = v === "top" ? margin : v === "bottom" ? img.height - margin - blockH : (img.height - blockH) / 2;
    const alignX = (w: number) => (h === "left" ? x0 : h === "right" ? x0 + blockW - w : x0 + (blockW - w) / 2);

    g.globalAlpha = Math.min(1, Math.max(0.05, Number(params.opacity ?? 85) / 100));
    if (params.shadow !== false) {
      g.shadowColor = "rgba(0, 0, 0, 0.55)";
      g.shadowBlur = fontPx * 0.25;
      g.shadowOffsetY = fontPx * 0.05;
    }
    if (logo) {
      g.imageSmoothingQuality = "high";
      g.drawImage(canvasOf(logo).c, alignX(logoW), y0, logoW, logoH);
    }
    g.fillStyle = COLORS[String(params.color)] ?? COLORS.white;
    g.textBaseline = "top";
    g.textAlign = h;
    const tx = h === "left" ? x0 : h === "right" ? x0 + blockW : x0 + blockW / 2;
    lines.forEach((l, i) => g.fillText(l, tx, y0 + logoH + gap + i * lineH + (lineH - fontPx) / 2));
    return { image: { kind: "image", width: img.width, height: img.height, data: g.getImageData(0, 0, c.width, c.height).data, scale: img.scale } };
  },
};
