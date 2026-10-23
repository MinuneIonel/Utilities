import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Engines are imported straight from the sibling app folders.
  server: { fs: { allow: [".."] } },
  // The codec packages load their .wasm files relative to their own modules, which breaks if Vite pre-bundles them.
  optimizeDeps: { exclude: ["@jsquash/avif", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/oxipng", "@jsquash/resize"] },
  worker: { format: "es" },
  // A desktop app loads from disk, so one large chunk costs nothing.
  build: { chunkSizeWarningLimit: 2000 },
});
