// Builds the GPU check page (see run.mjs).
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  build: { outDir: process.env.GPU_CHECK_OUT ?? "dist", emptyOutDir: true },
  logLevel: "warn",
});
