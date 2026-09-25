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

/** A core stand-in that answers `body` on /health and counts the requests it got. */
function healthServer(body: unknown) {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      hits.push(new URL(request.url).pathname);
      return Response.json(body);
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port, hits };
}

async function check(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, SCRIPT], {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test('checks the port the running core wrote to core.json', async () => {
  const server = healthServer({ ok: true });
  const dir = dataDir();
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ port: server.port, host: '0.0.0.0', token: 'x' }));
  expect((await check({ BOITE_DATA_DIR: dir })).code).toBe(0);
  expect(server.hits).toEqual(['/health']);
});

test('fails when the core on that port is not healthy', async () => {
  const server = healthServer({ ok: false });
  const dir = dataDir();
  writeFileSync(join(dir, 'core.json'), JSON.stringify({ port: server.port, token: 'x' }));
  const result = await check({ BOITE_DATA_DIR: dir });
  expect(result.code).not.toBe(0);
  expect(server.hits).toEqual(['/health']);
  expect(result.stderr).toContain('invalid core health response');
});
