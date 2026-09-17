import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const shell = process.env.BOITE_TEST_SH || Bun.which('sh');

test.skipIf(!shell)('ARM64 packaging preserves the core and refuses unexpected dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-patchelf-'));
  try {
    const fake = join(directory, 'patchelf');
    writeFileSync(fake, '#!/bin/sh\nif [ "$1" = --print-needed ]; then printf "%s\\n" "$TEST_DEPENDENCIES"; else printf "%s\\n" "$@"; exit 7; fi\n');
    chmodSync(fake, 0o755);
    const run = (args: string[], dependencies = 'libc.so.6\nlibm.so.6') => Bun.spawnSync([
      shell!, resolve('apps/shell/scripts/patchelf-sidecar.sh'), ...args,
    ], {
      env: { ...process.env, BOITE_PATCHELF: fake.replaceAll('\\', '/'), TEST_DEPENDENCIES: dependencies },
      stdout: 'pipe', stderr: 'pipe',
    });
    const core = '/tmp/Boite.AppDir/usr/bin/boite-core';
    expect(run(['--set-rpath', '$ORIGIN/../lib', core]).exitCode).toBe(0);
    const unexpected = run(['--set-rpath', '$ORIGIN/../lib', core], 'libcustom.so');
    expect(unexpected.exitCode).toBe(1);
    expect(unexpected.stderr.toString()).toContain('unexpected dependency libcustom.so');
    const query = run(['--print-rpath', core]);
    expect(query.exitCode).toBe(7);
    expect(query.stdout.toString()).toContain('--print-rpath');
    const other = run(['--set-rpath', '$ORIGIN/../lib', '/tmp/Boite.AppDir/usr/bin/boite-shell']);
    expect(other.exitCode).toBe(7);
    expect(other.stdout.toString()).toContain('--set-rpath');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
