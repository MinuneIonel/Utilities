// Restore diacritics from the command line.
//   npm run restore -- file.txt > out.txt
//   echo "si asa mai departe" | npm run restore --silent
import { readFileSync } from "node:fs";
import { restoreText } from "../src/engine/restore.ts";
import { loadModel } from "./load.ts";

const args = process.argv.slice(2);
const keepExisting = !args.includes("--overwrite");
const file = args.find((a) => !a.startsWith("--"));
const text = readFileSync(file ?? 0, "utf8");
process.stdout.write(restoreText(text, loadModel(), { keepExisting }));
