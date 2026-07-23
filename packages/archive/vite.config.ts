import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ configPath: "../../wrangler.jsonc", viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
  ],
});
