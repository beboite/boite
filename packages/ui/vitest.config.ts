import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Vitest 5 runs on the same Vite 8 the app builds on, so the tests use the real
 * svelte plugin and `svelte.config.js` (vitePreprocess, runes) instead of a
 * hand-rolled one. Nothing here touches the TypeScript JS API, which version 7
 * no longer ships.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    maxWorkers: 8,
    fsModuleCache: true,
    environment: 'jsdom',
    setupFiles: ['./test-setup.ts'],
    include: ['src/**/*.test.ts'],
    globals: false,
    /* The app suite runs the fake on the wall clock (install steps, probes,
       retitles), and one long list renders for seconds on a CI runner: 5 s
       left too little room. app.test.ts's waits stop at 8 s, inside this. */
    testTimeout: 15_000,
    /* lucide ships .svelte sources; inlined so the plugin above compiles them too */
    server: { deps: { inline: ['@lucide/svelte'] } }
  }
});
