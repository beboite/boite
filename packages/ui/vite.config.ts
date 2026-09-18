import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  base: './',
  // AudioWorklet modules must be same-origin files, never data URLs under the shell CSP.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: (file) => file.endsWith('speech-worklet.js') ? false : undefined },
  server: { port: 5173, strictPort: true }
});
