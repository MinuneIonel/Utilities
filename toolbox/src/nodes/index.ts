import type { Converter, NodeDef } from "../runtime/types";
import { ASCII_CONVERTERS, asciiConvert, asciiRender, asciiText } from "./ascii";
import { ditherRecipe } from "./dither";
import { fileInput } from "./file";
import { imageEncode, imageTransform } from "./media";
import { saveFile, saveImage } from "./save";
import { diacritics, saveText, textInput } from "./text";

export const NODE_DEFS: NodeDef[] = [
  fileInput,
  textInput,
  imageTransform,
  ditherRecipe,
  asciiConvert,
  asciiRender,
  imageEncode,
  asciiText,
  diacritics,
  saveImage,
  saveFile,
  saveText,
];

export const REGISTRY: ReadonlyMap<string, NodeDef> = new Map(NODE_DEFS.map((d) => [d.type, d]));

export const CONVERTERS: readonly Converter[] = [...ASCII_CONVERTERS];
