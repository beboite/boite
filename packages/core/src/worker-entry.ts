import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Locate a worker in sources, a bundle, beside the executable, or embedded as a compile entry. */
export function workerEntry(base: string, name: string): string {
  const besideExecutable = join(dirname(process.execPath), `${name}.js`);
  if (existsSync(besideExecutable)) return pathToFileURL(besideExecutable).href;
  for (const candidate of [`./${name}.ts`, `./${name}.js`]) {
    const url = new URL(candidate, base);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  throw new Error(`no ${name} beside ${base} and none next to ${process.execPath}`);
}
