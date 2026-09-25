import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', 'docker', 'healthcheck.ts');
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boite-healthcheck-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function healthServer(body: unknown) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(body) });
  cleanups.push(() => server.stop(true));
  return server;
}

async function check(env: Record<string, string>): Promise<number> {
  const child = Bun.spawn(['bun', SCRIPT], {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  });
  return await child.exited;
}

test('checks the port the running core wrote to core.json', async () => {
  const server = healthServer({ ok: true });
  const dir = dataDir();
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ port: server.port, host: '0.0.0.0', token: 'x' }));
  expect(await check({ BOITE_DATA_DIR: dir })).toBe(0);
});

test('fails when the core on that port is not healthy', async () => {
  const server = healthServer({ ok: false });
  const dir = dataDir();
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ port: server.port, token: 'x' }));
  expect(await check({ BOITE_DATA_DIR: dir })).not.toBe(0);
});
