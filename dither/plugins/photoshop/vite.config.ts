import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Bundles the panel and the shared engine into one classic script for UXP.
// The plugin folder to load in Photoshop is plugins/photoshop/dist.
export default defineConfig({
  publicDir: here("./static"),
  build: {
    outDir: here("./dist"),
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    lib: {
      entry: here("./src/panel.ts"),
      formats: ["iife"],
      name: "DitherLab",
      fileName: () => "index.js",
    },
    // Provided by Photoshop at runtime; keep the require() call as is.
    rollupOptions: { external: ["photoshop"] },
  },
});
