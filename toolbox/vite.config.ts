import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Engines are imported straight from the sibling app folders.
  server: { fs: { allow: [".."] } },
  worker: { format: "es" },
});
