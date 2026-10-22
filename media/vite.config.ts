import { defineConfig } from "vite";

export default defineConfig({
  // The codec packages load their .wasm files relative to their own modules, which breaks if Vite pre-bundles them.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@jsquash/avif", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/oxipng", "@jsquash/resize"] },
  worker: { format: "es" },
});
