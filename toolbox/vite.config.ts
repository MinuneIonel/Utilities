import { cpSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// pdf.js loads its standard fonts and CMaps by URL: serve them in dev, copy them into the build.
const PDFJS = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
function pdfjsAssets(): Plugin {
  let outDir = "dist";
  return {
    name: "pdfjs-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/(standard_fonts|cmaps)\/([\w.-]+)$/.exec(req.url ?? "");
        if (!m) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(resolve(PDFJS, m[1], m[2])).on("error", () => next()).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of ["standard_fonts", "cmaps"]) cpSync(resolve(PDFJS, dir), resolve(outDir, "pdfjs", dir), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  // Engines are imported straight from the sibling app folders.
  server: { fs: { allow: [".."] } },
  // The codec packages load their .wasm files relative to their own modules, which breaks if Vite pre-bundles them.
  optimizeDeps: { exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util", "@jsquash/avif", "@jsquash/jpeg", "@jsquash/png", "@jsquash/webp", "@jsquash/oxipng", "@jsquash/resize"] },
  worker: { format: "es" },
  // A desktop app loads from disk, so one large chunk costs nothing.
  build: { chunkSizeWarningLimit: 2000 },
});
