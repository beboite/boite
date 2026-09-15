import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function setNightlyVersion(version: string, root = '.') {
  if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(version)) throw new Error('invalid nightly version');
  for (const file of ['package.json', 'packages/core/package.json', 'apps/shell/src-tauri/tauri.nightly.conf.json']) {
    const path = join(root, file);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.version = version;
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  }
}
if (import.meta.main) setNightlyVersion(process.env.NIGHTLY_VERSION ?? '');
