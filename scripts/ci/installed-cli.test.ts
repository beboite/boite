import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const shell = process.env.BOITE_TEST_SH || Bun.which('sh');

test.skipIf(!shell).each(['separate resources', 'adjacent core', 'runtime bundle'])(
  'the installed CLI preserves arguments with %s', (layout) => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-cli-'));
  try {
    const resources = join(directory, "Boite's app", 'Resources');
    const binaries = layout === 'separate resources' ? join(directory, "Boite's app", 'MacOS') : resources;
    mkdirSync(resources, { recursive: true });
    mkdirSync(binaries, { recursive: true });
    const shim = join(resources, 'boite');
    const core = join(binaries, 'boite-core');
    copyFileSync(resolve('packages/core/shims/boite'), shim);
    writeFileSync(core, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(core, 0o755);
    const entry = join(binaries, 'core', 'main.js').replaceAll('\\', '/');
    if (layout === 'runtime bundle') {
      mkdirSync(join(binaries, 'core'));
      writeFileSync(entry, '// bundled core fixture\n');
    }
    const result = Bun.spawnSync([shell!, shim, 'panel', 'a file.txt'], {
      cwd: directory,
      env: {
        ...process.env,
        BOITE_DATA_DIR: join(directory, 'data'),
        BOITE_CORE_EXECUTABLE: layout === 'separate resources' ? core.replaceAll('\\', '/') : undefined,
      },
      stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().replaceAll('\\', '/')).toBe(
      `${layout === 'runtime bundle' ? `${entry}\n` : ''}cli\npanel\na file.txt\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
