import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverBundle } from '../../packages/core/bin/server-bundle.ts';
import pkg from '../../package.json';

export { serverBundle };

if (import.meta.main) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Server bundles are built on Linux x64 or ARM64');
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: server-bundle.ts <artifact directory>');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `boite-server_${pkg.version}_${process.arch}.zip`);
  writeFileSync(file, serverBundle('packages/core/dist/boite-core', 'packages/ui/dist', pkg.version));
  console.log(file);
}
