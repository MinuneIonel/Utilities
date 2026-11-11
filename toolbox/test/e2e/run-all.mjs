// Runs every end-to-end check in this folder against the built desktop app, one after another,
// and exits non-zero if any failed. `npm run check:all` builds first. On Linux run it under xvfb-run.
//   TOOLBOX_E2E_NETWORK=1  also runs checks that download from the internet (Remove background's model).
//   TOOLBOX_E2E_ONLY=a,b   runs just those scripts (names without .mjs).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
/** Checks that need the internet, skipped unless TOOLBOX_E2E_NETWORK=1. */
const NETWORK = new Set(["removebg"]);
const only = process.env.TOOLBOX_E2E_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);

const scripts = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .map((f) => f.replace(/\.mjs$/, ""))
  .filter((n) => (only ? only.includes(n) : !NETWORK.has(n) || process.env.TOOLBOX_E2E_NETWORK === "1"))
  .sort();

const results = [];
for (const name of scripts) {
  const t0 = Date.now();
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(process.execPath, [path.join(here, `${name}.mjs`)], { stdio: "inherit", env: process.env });
  results.push({ name, ok: r.status === 0, s: ((Date.now() - t0) / 1000).toFixed(0) });
}

console.log("\n=== summary ===");
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name} (${r.s} s)`);
const skipped = NETWORK.size && process.env.TOOLBOX_E2E_NETWORK !== "1" && !only ? [...NETWORK] : [];
if (skipped.length) console.log(`skipped (need the internet): ${skipped.join(", ")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
