import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { stampWorkerCache } from './src/lib/worker-stamp';
import { tooNewForFloor } from './src/lib/browser-floor';
import { localePreloadScript } from './src/lib/locale-preload';

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
 * chunk before it folds those branches away, so a release build still wrote it,
 * unreferenced, beside the app. This drops that orphan before compression, and
 * fails the build if a shipped chunk still reaches it. The e2e's fake bundle
 * (`tests/e2e/lib/warm.ts`) defines DEV as true and keeps it.
 */
function dropFakeClient(): Plugin {
  let dev = false;
  return {
    name: 'boite-drop-fake-client',
    apply: 'build',
    configResolved(config) {
      // A build under NODE_ENV=test (bun test runs one in tests/e2e/ui.test.ts) is a dev build too.
      dev = config.define?.['import.meta.env.DEV'] === 'true' || config.env.DEV === true;
    },
    generateBundle(_options, bundle) {
      if (dev) return;
      const fake = Object.values(bundle).filter((file) => file.type === 'chunk' && /[\\/]src[\\/]lib[\\/]fake-client\.ts$/.test(file.facadeModuleId ?? ''));
      for (const chunk of fake) {
        const users = Object.values(bundle).filter((file) => file !== chunk && (file.type === 'chunk' ? file.code : String(file.source)).includes(chunk.fileName.replace(/^assets\//, '')));
        if (users.length) this.error(`${users.map((file) => file.fileName).join(', ')} reaches the dev-only fake client (${chunk.fileName}); guard the import with import.meta.env.DEV`);
        delete bundle[chunk.fileName];
      }
    },
  };
}

/**
 * Each language but English is a chunk of its own (`src/lib/i18n.svelte.ts`).
 * index.html gets a small inline script that preloads the one the device
 * speaks (`src/lib/locale-preload.ts`), so the boot finds it already on its way.
 * A build where the French catalogue is no chunk of its own fails here.
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
          if (code && code !== 'en') chunks[code] = `./${file.fileName}`;
        }
        if (!chunks['fr']) throw new Error('src/lib/strings.fr.ts is not a chunk of its own: i18n.svelte.ts must import it dynamically');
        return [{ tag: 'script', children: localePreloadScript(chunks), injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig({
  plugins: [svelte(), browserFloor(), dropFakeClient(), localePreload(), precompress()],
  base: './',
  // AudioWorklet modules must be same-origin files, never data URLs under the shell CSP.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: (file) => file.endsWith('speech-worklet.js') ? false : undefined },
  server: { port: 5173, strictPort: true }
});
