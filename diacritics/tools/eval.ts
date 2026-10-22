// Strip diacritics from correctly written text, restore them, and count the differences.
//   npm run eval -- test.txt [more.txt ...] [--lines 3000] [--errors]
import { readFileSync } from "node:fs";
import { restore } from "../src/engine/restore.ts";
import { fold } from "../src/engine/text.ts";
import { loadModel } from "./load.ts";

const args = process.argv.slice(2);
const maxLines = args.includes("--lines") ? Number(args[args.indexOf("--lines") + 1]) : Infinity;
const showErrors = args.includes("--errors");
const temperature = args.includes("--temperature") ? Number(args[args.indexOf("--temperature") + 1]) : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--lines" && args[i - 1] !== "--temperature");

const t0 = performance.now();
const model = loadModel();
if (temperature !== null) model.temperature = temperature;
console.log(`model loaded in ${Math.round(performance.now() - t0)} ms`);

const strip = (s: string) => s.replace(/\p{L}+/gu, (w) => [...w].map((c, i) => (c === c.toLowerCase() ? fold(w)[i] : fold(w)[i].toUpperCase())).join(""));

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, maxLines);
  let words = 0, wrong = 0, withDiacritics = 0, found = 0, ambiguous = 0, ambiguousWrong = 0;
  const errors = new Map<string, number>();
  // calibration: how often the top choice is right, by the confidence shown
  const buckets = [0.5, 0.8, 0.95, 0.99, 1.01].map((max) => ({ max, n: 0, right: 0 }));
  const t1 = performance.now();
  for (const line of lines) {
    const gold = line.normalize("NFC");
    const res = restore(strip(gold), model, { keepExisting: false });
    for (const w of res.words) {
      const want = gold.slice(w.start, w.end).toLowerCase();
      const got = w.output.toLowerCase();
      words++;
      if (want !== fold(want)) {
        withDiacritics++;
        if (got === want) found++;
      }
      if (w.alternatives.length > 1) {
        ambiguous++;
        const b = buckets.find((b) => w.alternatives[0].p < b.max)!;
        b.n++;
        if (got === want) b.right++;
        if (got !== want) ambiguousWrong++;
      }
      if (got !== want) {
        wrong++;
        const k = `${want} → ${got}`;
        errors.set(k, (errors.get(k) ?? 0) + 1);
      }
    }
  }
  const ms = performance.now() - t1;
  const pct = (a: number, b: number) => ((100 * a) / b).toFixed(2) + "%";
  console.log(`\n${file}`);
  console.log(`  words correct        ${pct(words - wrong, words)}  (${wrong} wrong of ${words})`);
  console.log(`  diacritic words      ${pct(found, withDiacritics)} restored`);
  console.log(`  ambiguous words      ${pct(ambiguous - ambiguousWrong, ambiguous)} right (${ambiguous} decided by context)`);
  console.log(`  speed                ${Math.round(words / (ms / 1000)).toLocaleString()} words/s`);
  let lo = 0;
  for (const b of buckets) {
    if (b.n) console.log(`  shown ${Math.round(lo * 100)}–${Math.min(100, Math.round(b.max * 100))}%`.padEnd(23) + `${pct(b.right, b.n)} right (${b.n} words)`);
    lo = b.max;
  }
  if (showErrors) {
    const top = [...errors].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log("  most common errors:\n" + top.map(([k, n]) => `    ${n}\t${k}`).join("\n"));
  }
}
