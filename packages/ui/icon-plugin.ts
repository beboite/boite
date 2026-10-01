import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Every `@lucide/svelte` icon imports `../Icon.svelte`; this hands it
 * `src/components/LucideGlyph.svelte` instead, which draws the same svg
 * without Lucide's per-shape spread (`src/lib/glyph.ts` says what that cost).
 * The build and the tests both run it, so what a test renders is what ships.
 */
export function lucideGlyph(): Plugin {
  const glyph = fileURLToPath(new URL('./src/components/LucideGlyph.svelte', import.meta.url));
  return {
    name: 'boite-lucide-glyph',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../Icon.svelte' && importer && /[\\/]@lucide[\\/]svelte[\\/]dist[\\/]icons[\\/]/.test(importer)) return glyph;
      return null;
    },
  };
}
