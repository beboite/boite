import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Where a Worker file is on disk, which is not the same place in the three ways
 * the core runs. A compiled core is checked first: its embedded copy is visible
 * to `existsSync` but a Worker cannot read it, so `build:exe` leaves the `.js`
 * next to the executable and that copy is the only loadable one. Running under
 * `bun`, nothing sits next to `bun.exe`, and the file beside the calling module
 * is the source `.ts` or the bundled `.js`.
 *
 * `base` is the caller's `import.meta.url`, `name` the worker's file name
 * without an extension.
 */
export function workerEntry(base: string, name: string): string {
  const besideExecutable = join(dirname(process.execPath), `${name}.js`);
  if (existsSync(besideExecutable)) return pathToFileURL(besideExecutable).href;
  for (const candidate of [`./${name}.ts`, `./${name}.js`]) {
    const url = new URL(candidate, base);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  throw new Error(`no ${name} beside ${base} and none next to ${process.execPath}`);
}
