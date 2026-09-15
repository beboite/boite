import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setNightlyVersion } from './nightly-build.ts';
test('nightly build stamps the core and installer without changing the stable config', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-nightly-version-'));
  const files = ['package.json', 'packages/core/package.json', 'apps/shell/src-tauri/tauri.nightly.conf.json', 'apps/shell/src-tauri/tauri.conf.json'];
  try {
    for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), JSON.stringify({ version: '2.0.0-beta.1' })); }
    setNightlyVersion('2.0.0-nightly.20260915.2', root);
    for (const file of files.slice(0, 3)) expect(JSON.parse(readFileSync(join(root, file), 'utf8')).version).toBe('2.0.0-nightly.20260915.2');
    expect(JSON.parse(readFileSync(join(root, files[3]!), 'utf8')).version).toBe('2.0.0-beta.1');
    expect(() => setNightlyVersion('2.0.0', root)).toThrow('invalid nightly version');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
