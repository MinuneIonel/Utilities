import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseModel, type Model } from "../src/engine/model.ts";
import { parseNeural } from "../src/engine/neural.ts";

const publicFile = (name: string) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/** Loads public/model.dat, plus public/neural.dat unless `neural` is false. */
export function loadModel(neural = true): Model {
  const model = parseModel(gunzipSync(readFileSync(publicFile("model.dat"))).toString("utf8"));
  if (neural && existsSync(publicFile("neural.dat"))) {
    const buf = gunzipSync(readFileSync(publicFile("neural.dat")));
    model.neural = parseNeural(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return model;
}
