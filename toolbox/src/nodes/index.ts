import type { Converter, NodeDef } from "../runtime/types";
import { ASCII_CONVERTERS, asciiConvert, asciiRender, asciiText } from "./ascii";
import { AUDIO_CONVERTERS, audioConvert, audioInput } from "./audio";
import { ditherRecipe } from "./dither";
import { download } from "./download";
import { fileInput, imagesInput } from "./file";
import { imageEncode, imageTransform } from "./media";
import { imagesToPdf, PDF_CONVERTERS, pdfCompact, pdfInput, pdfMerge, pdfPages, pdfProtect, pdfStamp, pdfToImages } from "./pdf";
import { saveFile, saveImage } from "./save";
import { diacritics, saveText, textInput } from "./text";
import { extractAudio, videoEncode, videoInput, webcam } from "./video";

export const NODE_DEFS: NodeDef[] = [
  fileInput,
  imagesInput,
  videoInput,
  webcam,
  download,
  audioInput,
  pdfInput,
  textInput,
  imageTransform,
  ditherRecipe,
  asciiConvert,
  asciiRender,
  imageEncode,
  videoEncode,
  extractAudio,
  audioConvert,
  asciiText,
  diacritics,
  pdfMerge,
  pdfPages,
  pdfStamp,
  pdfProtect,
  pdfCompact,
  imagesToPdf,
  pdfToImages,
  saveImage,
  saveFile,
  saveText,
];

export const REGISTRY: ReadonlyMap<string, NodeDef> = new Map(NODE_DEFS.map((d) => [d.type, d]));

export const CONVERTERS: readonly Converter[] = [...ASCII_CONVERTERS, ...AUDIO_CONVERTERS, ...PDF_CONVERTERS];

/** Which input node takes a dropped file. */
export function inputNodeFor(file: { type: string; name: string }): string | undefined {
  const t = file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (t === "application/pdf" || ext === "pdf") return "input.pdf";
  if (t.startsWith("image/")) return "input.file";
  if (t.startsWith("video/") || ["mp4", "m4v", "mov", "webm", "mkv"].includes(ext)) return "input.video";
  if (t.startsWith("audio/") || ["mp3", "wav", "flac", "m4a", "ogg", "opus", "aac"].includes(ext)) return "input.audio";
  if (t.startsWith("text/") || ["txt", "md", "csv", "srt"].includes(ext)) return "input.text";
  return undefined;
}

/** File chooser filter for each input node. */
export const INPUT_ACCEPT: Record<string, string> = {
  "input.file": "image/*",
  "input.images": "image/*",
  "input.video": "video/*,.mkv",
  "input.audio": "audio/*",
  "input.pdf": "application/pdf,.pdf",
};
