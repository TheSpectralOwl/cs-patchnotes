import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// jsdom so hook tests (useDebounced via @testing-library/react) have a DOM.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
