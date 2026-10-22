import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseModel, type Model } from "../src/engine/model.ts";

export function loadModel(path = fileURLToPath(new URL("../public/model.dat", import.meta.url))): Model {
  return parseModel(gunzipSync(readFileSync(path)).toString("utf8"));
}
