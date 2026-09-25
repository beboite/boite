import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { stampWorkerCache } from './src/lib/worker-stamp';

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

export default defineConfig({
  plugins: [svelte(), precompress()],
  base: './',
  // AudioWorklet modules must be same-origin files, never data URLs under the shell CSP.
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: (file) => file.endsWith('speech-worklet.js') ? false : undefined },
  server: { port: 5173, strictPort: true }
});
