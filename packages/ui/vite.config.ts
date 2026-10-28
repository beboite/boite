import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { stampWorkerCache } from './src/lib/worker-stamp.ts';
import { tooNewForFloor } from './src/lib/browser-floor.ts';
import { localePreloadScript } from './src/lib/locale-preload.ts';
import { colorsBootScript } from './src/lib/theme-colors.ts';
import { lucideGlyph } from './icon-plugin.ts';
import { completeCatalogues } from './catalogue-plugin.ts';
import { prepaintMinify } from './prepaint.ts';
import { releaseVersion } from './release-version.ts';

const COMPRESSIBLE = /\.(?:html|js|css|svg|json|webmanifest)$/;

/**
 * Names the service worker's cache after the hashed files this build emitted
 * (`src/lib/worker-stamp.ts` says why). Runs before the compression below, so
 * `sw.js.br` and `sw.js.gz` carry the stamped bytes.
 */
function stampWorker(outDir: string): void {
  const worker = join(outDir, 'sw.js');
  const assets = join(outDir, 'assets');
  if (!existsSync(worker) || !existsSync(assets)) return;
  const names = readdirSync(assets).sort();
  const buildId = createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
  writeFileSync(worker, stampWorkerCache(readFileSync(worker, 'utf8'), buildId));
}

/**
 * Every text file of the build gets a `.br` and a `.gz` beside it, at the
 * highest level, once, here. The core serves the one the browser accepts and
 * never compresses anything itself (`packages/core/src/server.ts`). Fonts and
 * images are already compressed and are left alone.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const full = join(directory, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return {
    name: 'boite-precompress',
    apply: 'build',
    configResolved(config) {
      // resolve, not join: a caller may pass an absolute --outDir.
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      stampWorker(outDir);
      for (const file of walk(outDir)) {
        if (!COMPRESSIBLE.test(file)) continue;
        const bytes = readFileSync(file);
        if (bytes.byteLength < 1024) continue;
        writeFileSync(`${file}.br`, brotliCompressSync(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength },
        }));
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      }
    },
  };
}

/**
 * Refuses a build whose chunks use what the browser floor lacks
 * (`src/lib/browser-floor.ts`): a lookbehind in a startup chunk blanks the app
 * on Safari before 16.4, and no build target lowers a regex.
 */
function browserFloor(): Plugin {
  return {
    name: 'boite-browser-floor',
    apply: 'build',
    generateBundle(_options, bundle) {
      const hits = Object.values(bundle).flatMap((file) => file.type === 'chunk' ? tooNewForFloor(file.code).map((hit) => `${file.fileName}: ${hit}`) : []);
      if (hits.length) this.error(`the build uses what Safari 15.4 cannot run (docs/phone.md):\n${hits.join('\n')}`);
    },
  };
}

/**
 * The fake client and its seeded fixtures are for the dev server and the tests.
 * Its three imports sit behind `import.meta.env.DEV`, but Rolldown splits the
 * graph before it folds those branches away: the fake client's helpers (the
 * `boite view` kit among them) landed in shared startup chunks. A release
 * build therefore resolves those imports to an empty module before the graph
 * is built, drops the empty chunk it may leave, and fails if a shipped chunk
 * still holds a fake-client module. The e2e's fake bundle
 * (`tests/e2e/lib/warm.ts`) defines DEV as true and keeps it.
 */
const NO_FAKE_CLIENT = '\0boite-no-fake-client';

function dropFakeClient(): Plugin {
  let dev = false;
  return {
    name: 'boite-drop-fake-client',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      // A build under NODE_ENV=test (bun test runs one in tests/e2e/ui.test.ts) is a dev build too.
      dev = config.define?.['import.meta.env.DEV'] === 'true' || config.env.DEV === true;
    },
    resolveId(source) {
      return !dev && /(?:^|\/)fake-client$/.test(source) ? NO_FAKE_CLIENT : null;
    },
    load(id) {
      return id === NO_FAKE_CLIENT ? 'export {};' : null;
    },
    generateBundle(_options, bundle) {
      if (dev) return;
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        if (file.facadeModuleId === NO_FAKE_CLIENT) {
          delete bundle[file.fileName];
          continue;
        }
        const fake = Object.keys(file.modules).find((id) => /[\\/]src[\\/]lib[\\/]fake-client(?:\.ts$|[\\/])/.test(id));
        if (fake) this.error(`${file.fileName} carries the dev-only fake client (${fake}); import it as a dynamic import('./fake-client') behind import.meta.env.DEV`);
      }
    },
  };
}

/**
 * Each language, English included, is a chunk of its own
 * (`src/lib/i18n.svelte.ts`). index.html gets a small inline script that
 * preloads the one the device speaks (`src/lib/locale-preload.ts`), so the
 * boot finds it already on its way. A build where a catalogue is no chunk of
 * its own fails here.
 */
function localePreload(): Plugin {
  return {
    name: 'boite-locale-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const chunks: Record<string, string> = {};
        for (const file of Object.values(context.bundle ?? {})) {
          const code = file.type === 'chunk' ? /[\\/]src[\\/]lib[\\/]strings\.([a-z]{2})\.ts$/.exec(file.facadeModuleId ?? '')?.[1] : undefined;
          if (code) chunks[code] = `./${file.fileName}`;
        }
        for (const code of ['en', 'fr']) {
          if (!chunks[code]) throw new Error(`src/lib/strings.${code}.ts is not a chunk of its own: i18n.svelte.ts must import it dynamically`);
        }
        return [{ tag: 'script', children: localePreloadScript(chunks), injectTo: 'head' }];
      },
    },
  };
}

/**
 * The phone's navigation is a chunk the page imports outside the shell
 * (`src/lib/mobile-navigation.ts`), not a file index.html names, so the service
 * worker would not store it at install and an offline phone would open with
 * no header. index.html gets its static graph, JavaScript and styles, in a
 * meta tag the browser fetches nothing for and `public/sw.js` precaches.
 */
function offlineParts(): Plugin {
  return {
    name: 'boite-offline-parts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const bundle = context.bundle ?? {};
        const navigation = Object.values(bundle).find(
          (file) => file.type === 'chunk' && /[\\/]src[\\/]components[\\/]MobileNavigation\.svelte$/.test(file.facadeModuleId ?? '')
        );
        if (!navigation) throw new Error('src/components/MobileNavigation.svelte is not a chunk of its own: lib/mobile-navigation.ts must import it dynamically');
        const files = new Set<string>();
        const visit = (name: string) => {
          const file = bundle[name];
          if (file?.type !== 'chunk' || files.has(name)) return;
          files.add(name);
          for (const css of file.viteMetadata?.importedCss ?? []) files.add(css);
          for (const imported of file.imports) visit(imported);
        };
        visit(navigation.fileName);
        return [{ tag: 'meta', attrs: { name: 'boite-offline', content: [...files].map((name) => `./${name}`).join(' ') }, injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [lucideGlyph(), completeCatalogues(), svelte(), { name: 'boite-colors-prepaint', transformIndexHtml: () => [{ tag: 'script', children: colorsBootScript(), injectTo: 'head' }] }, browserFloor(), dropFakeClient(), localePreload(), offlineParts(), prepaintMinify(), precompress()],
  base: './',
  define: { __BOITE_VERSION__: JSON.stringify(releaseVersion()) },
  // AudioWorklet modules must be same-origin files, never data URLs under the shell CSP.
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: (file) => file.endsWith('speech-worklet.js') ? false : undefined,
    // The core speaks HTTP/1.1, so a browser fetches six files at a time: the
    // modules the boot shares with a lazy chunk (Svelte, the store, Lucide
    // icons) are one chunk rather than dozens of small ones. A module only the
    // boot uses stays in the entry, and one no boot module imports stays lazy.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'boot', tags: ['$initial'], minShareCount: 2 }] } } }
  },
  server: { port: 5173, strictPort: true }
});
