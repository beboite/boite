import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForCoreEndpoint } from './desktop-smoke-endpoint.ts';

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
      exitCode: () => null,
    })).resolves.toEqual({ pid: 123, port: 456, token: 'secret' });
  });

  test('fails as soon as the shell exits', async () => {
    await expect(waitForCoreEndpoint('missing-core.json', {
      deadline: Date.now() + 30_000,
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
      exitCode: () => null,
    })).rejects.toThrow('within 30 seconds');
  });
});
