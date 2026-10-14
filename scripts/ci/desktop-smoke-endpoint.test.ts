import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupSeconds, waitForCoreEndpoint } from './desktop-smoke-endpoint.ts';

describe('desktop smoke endpoint', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  test('waits for a partially written or malformed endpoint to become valid', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-endpoint-'));
    directories.push(directory);
    const file = join(directory, 'core.json');
    writeFileSync(file, '{"pid":123,');
    setTimeout(() => writeFileSync(file, '{"pid":0,"port":70000,"token":""}'), 50);
    setTimeout(() => writeFileSync(file, '{"pid":123,"port":456,"token":"secret"}'), 150);

    await expect(waitForCoreEndpoint(file, {
      deadline: Date.now() + 1_000,
      seconds: 1,
      exitCode: () => null,
    })).resolves.toEqual({ pid: 123, port: 456, token: 'secret' });
  });

  test('fails as soon as the shell exits', async () => {
    await expect(waitForCoreEndpoint('missing-core.json', {
      deadline: Date.now() + 30_000,
      seconds: 30,
      exitCode: () => 17,
    })).rejects.toThrow('Shell exited with 17');
  });

  test('keeps the startup deadline while the endpoint is incomplete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-endpoint-'));
    directories.push(directory);
    const file = join(directory, 'core.json');
    writeFileSync(file, '{"pid":123,');

    await expect(waitForCoreEndpoint(file, {
      deadline: Date.now() - 1,
      seconds: 90,
      exitCode: () => null,
    })).rejects.toThrow('within 90 seconds');
  });

  test('the startup budget is 30 s unless the environment names a positive number', () => {
    expect(startupSeconds(undefined)).toBe(30);
    expect(startupSeconds('')).toBe(30);
    expect(startupSeconds('abc')).toBe(30);
    expect(startupSeconds('-5')).toBe(30);
    expect(startupSeconds('90')).toBe(90);
  });
});

describe('desktop smoke evidence', () => {
  test('keeps the ps header and only the rows of the shell process group', async () => {
    const { groupRows } = await import('./desktop-smoke-evidence.ts');
    const ps = [
      '  PID  PPID  PGID STAT  %CPU     ELAPSED COMMAND',
      '  400     1   400 S      0.0       00:31 /tmp/Boite.app/Contents/MacOS/boite-shell',
      '  401   400   400 R     98.0       00:30 /tmp/Boite.app/Contents/MacOS/boite-core',
      '  402     1   402 S      0.0       01:00 /usr/sbin/unrelated',
    ].join('\n');
    expect(groupRows(ps, 400).split('\n')).toEqual([
      '  PID  PPID  PGID STAT  %CPU     ELAPSED COMMAND',
      '  400     1   400 S      0.0       00:31 /tmp/Boite.app/Contents/MacOS/boite-shell',
      '  401   400   400 R     98.0       00:30 /tmp/Boite.app/Contents/MacOS/boite-core',
    ]);
  });
});
