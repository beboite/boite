import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidServerBundle } from '../../packages/core/bin/server-bundle.ts';
import pkg from '../../package.json';

export { androidServerBundle };

// The core's scripts run on any Bun, so one runner builds the Android bundle (docs/android-server.md).
if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: android-server-bundle.ts <artifact directory>');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `boite-server_${pkg.version}_android.zip`);
  writeFileSync(file, androidServerBundle('packages/core/dist', 'packages/ui/dist', 'apps/android-server/termux', pkg.version));
  console.log(file);
}
