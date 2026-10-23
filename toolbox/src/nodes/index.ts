import type { NodeDef } from "../runtime/types";
import { ditherRecipe } from "./dither";
import { fileInput } from "./file";
import { saveImage } from "./save";

export const NODE_DEFS: NodeDef[] = [fileInput, ditherRecipe, saveImage];

export const REGISTRY: ReadonlyMap<string, NodeDef> = new Map(NODE_DEFS.map((d) => [d.type, d]));
