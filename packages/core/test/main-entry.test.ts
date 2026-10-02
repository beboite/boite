import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCore } from '../../../tests/e2e/lib/core.ts';

const entry = join(import.meta.dir, '../src/main.ts');
let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-main-entry-'));
  dataDir = join(dir, 'data');
  mkdirSync(dataDir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.each(['cli', 'pair', 'update-apply'])('%s reaches its command path without loading the server runtime', (command) => {
  const guard = join(dir, 'runtime-guard.ts');
  writeFileSync(guard, String.raw`
    import { plugin } from 'bun';
    plugin({ name: 'command-runtime-guard', setup(build) {
      build.onLoad({ filter: /packages[\\/]core[\\/]src[\\/](core|server|journal)\.ts$/ }, () => {
        throw new Error('server runtime loaded on command path');
      });
    } });
  `);
  const args = command === 'cli' ? ['--help'] : command === 'pair' ? ['--data-dir', dataDir] : [];
  const run = Bun.spawnSync([process.execPath, '--preload', guard, entry, command, ...args], {
    env: { ...process.env, BOITE_DATA_DIR: dataDir, BOITE_HOST_AGENTS: '0', BOITE_UI_DIR: join(dir, 'missing-ui'), BOITE_TELEMETRY_URL: '' },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  expect(run.exitCode).toBe(command === 'cli' ? 0 : 1);
  expect(run.stdout.toString()).toBe('');
  const error = run.stderr.toString();
  if (command === 'cli') {
    expect(error).toStartWith('usage: boite');
    expect(error).toEndWith('drive a thread from outside it, as the owner\n');
  } else if (command === 'pair') {
    expect(error).toBe(`boite-core pair: no core has run on ${dataDir}: ${join(dataDir, 'core.json')} does not exist. Start the core first.\n`);
  } else {
    expect(error).toBe('boite-core update: update-apply expects a private server update plan on Linux\n');
  }
  expect(readdirSync(dataDir)).toEqual([]);
});

test('a refused listen closes the initialized core and releases its data lock', async () => {
  const busy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
  const child = Bun.spawn([process.execPath, entry, '--host', '127.0.0.1', '--port', String(busy.port), '--data-dir', dataDir], {
    env: { ...process.env, BOITE_HOST_AGENTS: '0', BOITE_UI_DIR: '', BOITE_TELEMETRY_URL: '', BOITE_ECHO: '1' },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const deadline = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(out).not.toContain('boite-core ready');
    expect(err).toMatch(/Failed to start server|EADDRINUSE|address.*in use/i);
    expect(existsSync(join(dataDir, 'core.lock'))).toBe(false);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
    await child.exited;
    busy.stop(true);
  }
}, 15_000);

test('the bytecode compiled launcher runs commands and starts a core that shuts down cleanly', async () => {
  const binary = join(dir, process.platform === 'win32' ? 'core.exe' : 'core');
  const targets: Record<string, string> = { win32: 'bun-windows-x64-baseline', linux: 'bun-linux-x64-baseline' };
  const target = process.arch === 'x64' ? targets[process.platform] : undefined;
  const build = Bun.spawnSync([
    process.execPath, 'build', '--compile', ...(target ? [`--target=${target}`] : []),
    '--minify-whitespace', '--minify-syntax', '--bytecode', '--format=esm', '--env=BOITE_RELEASE_*',
    'src/compiled-main.ts', 'src/artifact-retention-worker.ts', 'src/platform/linux-tcp-worker.ts', '--outfile', binary,
  ], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  expect(build.exitCode).toBe(0);
  if (process.platform === 'win32') {
    const workers = Bun.spawnSync([
      process.execPath, 'build', 'src/platform/windows/jobs-worker.ts', 'src/platform/windows/guard-worker.ts',
      '--target=bun', '--outdir', dir, '--entry-naming', '[name].[ext]', '--minify-whitespace', '--minify-syntax',
    ], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(workers.exitCode).toBe(0);
  }
  for (const [args, code, message] of [
    [['cli', '--help'], 0, 'usage: boite'],
    [['pair', '--data-dir', dataDir], 1, 'boite-core pair: no core has run'],
    [['update-apply'], 1, 'boite-core update: update-apply expects'],
  ] as const) {
    const run = Bun.spawnSync([binary, ...args], {
      env: { ...process.env, BOITE_DATA_DIR: dataDir, BOITE_HOST_AGENTS: '0', BOITE_UI_DIR: join(dir, 'missing-ui'), BOITE_TELEMETRY_URL: '' },
      stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    expect(run.exitCode).toBe(code);
    expect(run.stdout.toString()).toBe('');
    expect(run.stderr.toString()).toStartWith(message);
  }
  for (const mode of process.platform === 'win32' ? ['http'] : ['signal', 'http']) {
    const shutdownDataDir = join(dir, mode);
    const core = await startCore({ command: [binary], dataDir: shutdownDataDir });
    let stopped = false;
    const deadline = setTimeout(() => { if (!stopped) process.kill(core.pid, 'SIGKILL'); }, 10_000);
    try {
      expect((await fetch(`${core.url}/health`)).status).toBe(200);
      if (mode === 'http') {
        const response = await fetch(`${core.url}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${core.token}` } });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ ok: true, pid: core.pid });
      } else process.kill(core.pid, 'SIGTERM');
      const code = await core.exited;
      stopped = true;
      expect(code).toBe(0);
      expect(core.output()).toContain('boite-core ready');
      expect(existsSync(join(shutdownDataDir, 'core.lock'))).toBe(false);
    } finally {
      clearTimeout(deadline);
      if (!stopped) await core.stop();
    }
  }
}, 60_000);

test('normal core startup does not load the CLI command graph', async () => {
  const guard = join(dir, 'cli-guard.ts');
  writeFileSync(guard, String.raw`
    import { plugin } from 'bun';
    plugin({ name: 'server-cli-guard', setup(build) {
      build.onLoad({ filter: /packages[\\/]core[\\/]src[\\/]cli\.ts$/ }, () => {
        throw new Error('CLI command graph loaded on server path');
      });
    } });
  `);
  const core = await startCore({ command: [process.execPath, '--preload', guard, entry], dataDir });
  try {
    expect((await fetch(`${core.url}/health`)).status).toBe(200);
  } finally {
    await core.stop();
  }
}, 35_000);
