import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../apps/shell/src-tauri/windows/stop-core.ps1');
const fixture = `
const [directory, mode] = process.argv.slice(2);
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  if (request.headers.get('authorization') !== 'Bearer fixture') return new Response('no', {status:401});
  if (url.pathname === '/shutdown-if-idle') {
    if (mode === 'busy') return new Response('busy', {status:409});
    if (mode === 'legacy') return new Response('missing', {status:404});
    if (mode === 'wrong-pid') return Response.json({ok:true,pid:process.pid + 1}, {status:202});
    if (url.searchParams.get('pid') !== String(process.pid)) return new Response('wrong pid', {status:412});
  } else if (url.pathname !== '/shutdown') return new Response('missing', {status:404});
  setTimeout(() => process.exit(0), 20);
  return Response.json({ok:true,pid:process.pid}, {status:202});
}});
await Bun.write(directory + '/core.json', JSON.stringify({pid:process.pid,port:server.port,token:'fixture'}));
`;

async function withCore(mode: string, action: (directory: string, child: Bun.Subprocess) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'boite-stop-'));
  const executable = join(directory, 'boite-core.exe');
  copyFileSync(process.execPath, executable);
  writeFileSync(join(directory, 'core.ts'), fixture);
  const child = Bun.spawn([executable, join(directory, 'core.ts'), directory, mode], { stdout: 'ignore', stderr: 'pipe', windowsHide: true });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(directory, 'core.json'))) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('fixture did not publish core.json');
      await Bun.sleep(20);
    }
    await action(directory, child);
  } finally {
    child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

async function stop(directory: string, idleOnly: boolean) {
  return Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, BOITE_STOP_DIR: directory, BOITE_STOP_EXE: join(directory, 'boite-core.exe'), BOITE_STOP_IDLE: idleOnly ? '1' : '0' },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  }).exited;
}

describe.skipIf(process.platform !== 'win32')('manual installer admission', () => {
  test('busy, legacy and incorrect acknowledgements leave the exact core running', async () => {
    for (const mode of ['busy', 'legacy', 'wrong-pid']) {
      await withCore(mode, async (directory, child) => {
        const before = readFileSync(join(directory, 'boite-core.exe'));
        expect(await stop(directory, true)).not.toBe(0);
        expect(child.exitCode).toBeNull();
        expect(readFileSync(join(directory, 'boite-core.exe'))).toEqual(before);
      });
    }
  }, 60_000);

  test('an idle core exits on its own before the manual installer proceeds', async () => {
    await withCore('idle', async (directory, child) => {
      expect(await stop(directory, true)).toBe(0);
      expect(await child.exited).toBe(0);
    });
  }, 30_000);

  test('explicit uninstall still requests the ordinary shutdown', async () => {
    await withCore('busy', async (directory, child) => {
      expect(await stop(directory, false)).toBe(0);
      expect(await child.exited).toBe(0);
    });
  }, 30_000);
});
