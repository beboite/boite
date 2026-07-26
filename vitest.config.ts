import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Standalone config on purpose: pulling in the SvelteKit plugin would drag the
// whole route/manifest pipeline into the test run. What is worth testing here
// is pure logic — parsers, matchers, redaction — so tests never need a DOM.
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
