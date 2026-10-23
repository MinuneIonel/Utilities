import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // ffmpeg.wasm spawns its own worker from a relative URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"] },
});
