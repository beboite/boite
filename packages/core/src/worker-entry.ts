import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Locate a worker in sources, a bundle, beside the executable, or embedded as a compile entry. */
export function workerEntry(base: string, name: string, embeddedRelativePath?: string): string {
  const besideExecutable = join(dirname(process.execPath), `${name}.js`);
  if (existsSync(besideExecutable)) return pathToFileURL(besideExecutable).href;
  for (const candidate of [`./${name}.ts`, `./${name}.js`, ...(embeddedRelativePath ? [embeddedRelativePath] : [])]) {
    const url = new URL(candidate, base);
    if (existsSync(fileURLToPath(url))) return url.href;
  }
  // Compiled JS entries are visible to Bun's Worker loader, not node:fs.
  if (embeddedRelativePath && (base.startsWith('file:///$bunfs/root/') || base.startsWith('file:///B:/~BUN/root/'))) {
    return new URL(embeddedRelativePath, base).href;
  }
  throw new Error(`no ${name} beside ${base} and none next to ${process.execPath}`);
}
