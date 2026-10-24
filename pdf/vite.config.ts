import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

// pdf.js loads its standard fonts and CMaps by URL at render time. Serve them
// from node_modules in dev and copy them next to the build. Resolved through
// Node so it works whether npm installed pdfjs-dist here or at the repo root.
const PDFJS = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const ASSETS = ["standard_fonts", "cmaps"];

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
        import("node:fs").then((fs) =>
          fs
            .createReadStream(resolve(PDFJS, m[1], m[2]))
            .on("error", () => next())
            .pipe(res),
        );
      });
    },
    closeBundle() {
      for (const dir of ASSETS)
        cpSync(resolve(PDFJS, dir), resolve(outDir, "pdfjs", dir), { recursive: true });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [pdfjsAssets()],
});
