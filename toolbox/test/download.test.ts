import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadJobs } from "../src/nodes/download-jobs.ts";

// A fetch that never finishes on its own, like a long download: it only ends when stopped.
function setup() {
  const jobs = new DownloadJobs<string>();
  const started: string[] = [];
  const killed: string[] = [];
  const get = (key: string, mode: "preview" | "render" = "preview", signal?: AbortSignal) =>
    jobs.get(key, mode, signal, (s) => {
      started.push(key);
      return new Promise<string>((_resolve, reject) => s.addEventListener("abort", () => (killed.push(key), reject(new Error("killed")))));
    });
  return { jobs, started, killed, get };
}

test("one fetch per link, shared by everyone asking", () => {
  const { started, get } = setup();
  get("a").catch(() => undefined);
  get("a").catch(() => undefined);
  assert.deepEqual(started, ["a"]);
});

test("changing the link stops the old download", async () => {
  const { jobs, killed, get } = setup();
  const first = get("a");
  jobs.prune(new Set(["b"]));
  await assert.rejects(first, /Cancelled/);
  assert.deepEqual(killed, ["a"]);
});

test("a download still wanted keeps going", () => {
  const { jobs, killed, get } = setup();
  get("a").catch(() => undefined);
  jobs.prune(new Set(["a"]));
  assert.deepEqual(killed, []);
});

test("a stopped download stays stopped in preview until Render asks for it", async () => {
  const { jobs, started, get } = setup();
  const p = get("a");
  jobs.stop();
  await assert.rejects(p, /Download stopped/);
  await assert.rejects(get("a"), /Download stopped/);
  assert.equal(started.length, 1);
  get("a", "render").catch(() => undefined);
  assert.equal(started.length, 2);
});

test("Render's Cancel stops a download a preview started", async () => {
  const { jobs, killed, get } = setup();
  const p = get("a");
  const cancel = new AbortController();
  get("a", "render", cancel.signal).catch(() => undefined);
  // Render now owns it: changing the preview doesn't drop it.
  jobs.prune(new Set());
  assert.deepEqual(killed, []);
  cancel.abort();
  await assert.rejects(p, /Cancelled/);
  assert.deepEqual(killed, ["a"]);
});
