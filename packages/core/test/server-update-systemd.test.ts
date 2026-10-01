import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { serverBundle } from '../bin/server-bundle.ts';
import { unpackPayload } from '../src/server-update/release.ts';
import { linuxServerUpdates } from '../src/platform/linux-server-update.ts';
import { connect } from '../src/client.ts';
import type { ServerUpdatePlan } from '../src/server-update/types.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Expected a local test port')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

/** Opt in after build:core:linux: this uses two disposable user units and a fresh data directory. */
test.skipIf(process.platform !== 'linux' || process.env.BOITE_E2E_SERVER_UPDATE !== '1')('the compiled update worker survives its core cgroup and restarts the same real systemd service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-systemd-update-'));
  const id = randomUUID();
  const unit = `boite-server-test-${id}.service`;
  const helper = `boite-update-${id}.service`;
  const install = join(root, 'install');
  const data = join(root, 'data');
  const operation = join(root, `.boite-update-${id}`);
  const executable = join(install, 'boite-core');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const run = async (command: string, args: string[]) => {
    const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${command}: ${error.trim()}`);
    return out.trim();
  };
  const until = async (check: () => Promise<boolean> | boolean, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (!await check()) { if (Date.now() > deadline) throw new Error('Native server update smoke timed out'); await Bun.sleep(50); }
  };
  try {
    mkdirSync(join(install, 'ui'), { recursive: true }); mkdirSync(data); mkdirSync(operation);
    copyFileSync(join(import.meta.dir, '../dist/boite-core-linux-x64'), executable); chmodSync(executable, 0o755);
    copyFileSync(join(import.meta.dir, '../shims/boite'), join(install, 'boite'));
    writeFileSync(join(install, 'ui', 'index.html'), '<!doctype html><title>Test server</title>');
    // A persistent unit survives the old process exiting, just like a deployed server service.
    const unitFile = join(root, unit);
    writeFileSync(unitFile, `[Service]\nExecStart=${executable} --host 127.0.0.1 --port ${port} --data-dir ${data}\nRestart=on-failure\nRestartSec=5\nEnvironment=BOITE_HOST_AGENTS=0 BOITE_SERVER_SERVICE=${unit}\n`, { mode: 0o600 });
    await run('systemctl', ['--user', 'link', unitFile]);
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'start', unit]);
    await until(async () => { try { return (await fetch(`${url}/health`)).ok; } catch { return false; } });
    const before = await (await fetch(`${url}/health`)).json() as { pid: number; version: string };
    const coreFile = JSON.parse(readFileSync(join(data, 'core.json'), 'utf8')) as { token: string };
    const owner = await connect(url, coreFile.token);
    try { expect((await owner.call('core.updateStatus', {})).mode).toBe('systemd'); }
    finally { owner.close(); }
    const next = join(root, 'next'); mkdirSync(join(next, 'ui'), { recursive: true });
    // An inert replacement proves the native switch without running real providers or migrating production data.
    writeFileSync(join(next, 'boite-core'), `#!${process.execPath}\nBun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>Response.json({ok:true,version:'2.1.0',pid:process.pid})});\n`);
    writeFileSync(join(next, 'ui', 'index.html'), '<!doctype html><title>Updated server</title>');
    const archive = serverBundle(join(next, 'boite-core'), join(next, 'ui'), '2.1.0');
    const payload = join(operation, 'payload.zip'); writeFileSync(payload, archive); unpackPayload(payload, join(operation, 'stage'), '2.1.0');
    const plan: ServerUpdatePlan = { id, installation: { directory: install, executable, service: unit }, dataDir: data,
      previousVersion: before.version, version: '2.1.0', originalPid: before.pid, healthUrl: `${url}/health`, archiveHash: createHash('sha256').update(archive).digest('hex') };
    const file = join(operation, 'plan.json'); writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
    await linuxServerUpdates().launch(run, executable, file);
    await until(() => existsSync(join(operation, 'ready')));
    await until(async () => {
      const response = await fetch(`${url}/shutdown-if-idle?pid=${before.pid}`, { method: 'POST', headers: { authorization: `Bearer ${coreFile.token}` } });
      if (response.status === 409) return false;
      expect(response.status).toBe(202);
      writeFileSync(join(operation, 'admitted'), id, { mode: 0o600 });
      return true;
    });
    await until(async () => { try { return (await (await fetch(`${url}/health`)).json() as { version: string }).version === '2.1.0'; } catch { return false; } });
    await until(() => existsSync(join(data, 'server-update-result.json')));
    expect(JSON.parse(readFileSync(join(data, 'server-update-result.json'), 'utf8')).error).toBeNull();
    expect(await run('systemctl', ['--user', 'is-active', unit])).toBe('active');
    expect(readFileSync(join(root, `.boite-backup-${id}`, 'data', 'core.json'), 'utf8')).toContain(before.version);
    console.log('SYSTEMD_SERVER_UPDATE_VERIFIED: separate worker, idle shutdown, complete backup, health and restart');
  } catch (error) {
    console.error(await run('journalctl', ['--user', '-u', unit, '-u', helper, '--no-pager', '-n', '60']).catch(() => 'No test journal available'));
    throw error;
  } finally {
    await run('systemctl', ['--user', 'stop', helper]).catch(() => undefined);
    await run('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
    await run('systemctl', ['--user', 'disable', unit]).catch(() => undefined);
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
