import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Static SPA build → `dist/` (deployed by Cloudflare Pages). The browser talks
// only to the API (`VITE_API_URL`); it never imports the Meili SDK or a key.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
