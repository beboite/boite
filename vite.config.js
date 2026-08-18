import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig(async () => ({
  plugins: [tailwindcss(), sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  build: {
    // Single known webview target (Tauri WebView2 / server-mode Chromium);
    // no need to transpile down or polyfill module preload.
    target: "esnext",
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      allow: ["."],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // `.boite/worktrees` holds whole checkouts of this repository, made and
      // rewritten by the worktree pool while the dev server is up. Watched,
      // every spare warm is a source tree appearing under the root and the page
      // reloads on work nobody did.
      // `target/**` holds Rust build outputs and DLLs that Windows locks while compiling.
      ignored: ["**/src-tauri/**", "**/.boite/**", "**/target/**", "**/crates/**"],
    },
  },
}));
