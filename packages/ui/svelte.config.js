import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    runes: true,
    // Keep Svelte's full scope hash while reducing its repeated class prefix.
    cssHash: ({ css, filename, hash }) => `b${hash(filename === '(unknown)' ? css : filename ?? css)}`
  }
};
