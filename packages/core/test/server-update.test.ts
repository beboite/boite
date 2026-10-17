import { expect, test } from 'bun:test';
import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { Database } from 'bun:sqlite';
import { downloadPayload, verifyPayload, unpackPayload } from '../src/server-update/release.ts';
import { applyServerUpdate, clearStaleUpdates, recoverServerUpdate } from '../src/server-update/apply.ts';
import { linuxServerUpdates, unitWord } from '../src/platform/linux-server-update.ts';
import type { ServerUpdatePlan, ServerUpdatePlatform } from '../src/server-update/types.ts';
import { echoThread, holdAccountTurns, startTestCore, waitFor } from './harness.ts';

/** A publisher key and a Minisign packet over `bytes`, in the shape Tauri publishes. */
function publisher() {
  const keys = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const rawKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKey = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, rawKey]).toString('base64')}\n`).toString('base64');
  const signs = (bytes: Uint8Array, algorithm: 'Ed' | 'ED', comment = 'version:2.0.0') => {
    const data = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
    const signature = sign(null, data, keys.privateKey);
    const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64');
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), keys.privateKey).toString('base64');
    return `untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${global}\n`;
  };
  return { publicKey, signs };
}

test('publisher signatures reject altered bytes, a different key and changed trusted comments', () => {
  const { publicKey, signs } = publisher();
  const bytes = Buffer.from('a signed server bundle');
  for (const algorithm of ['Ed', 'ED'] as const) {
    const comment = 'version:2.0.0';
    const plain = signs(bytes, algorithm, comment);
    const encoded = Buffer.from(plain).toString('base64');
    expect(() => verifyPayload(bytes, encoded, publicKey)).not.toThrow();
    expect(() => verifyPayload(Buffer.from('altered bytes'), encoded, publicKey)).toThrow('verification failed');
    expect(() => verifyPayload(bytes, Buffer.from(plain.replace(comment, 'version:9.0.0')).toString('base64'), publicKey)).toThrow('verification failed');
    expect(() => verifyPayload(bytes, encoded, Buffer.from('invalid key').toString('base64'))).toThrow('signing key');
  }
});

test('a downloaded archive is verified over every byte, refused when altered, and unpacks the files it holds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-download-'));
  const { publicKey, signs } = publisher();
  // Large enough to arrive in many chunks and inflate in several steps.
  const core = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.concat([randomBytes(16 * 1024), Buffer.alloc(16 * 1024, i)])));
  const entries = { 'boite-core': core, 'boite': Buffer.from('shim'), 'ui/index.html': Buffer.from('UI'), 'ui/assets/app.js': Buffer.from('app'), 'server-release.json': Buffer.from('{"version":"2.1.0"}') };
  const archive = zipSync(entries, { level: 6 });
  let served: Uint8Array = archive;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(served) });
  try {
    for (const algorithm of ['ED', 'Ed'] as const) {
      const offer = { version: '2.1.0', publishedAt: '', url: `http://127.0.0.1:${server.port}/payload.zip`, signature: Buffer.from(signs(archive, algorithm)).toString('base64') };
      const directory = join(root, algorithm === 'ED' ? 'prehashed' : 'legacy');
      mkdirSync(directory);
      served = archive;
      let last = 0;
      const hash = await downloadPayload(offer, join(directory, 'payload.zip'), AbortSignal.timeout(10_000), (received) => { last = received; }, publicKey);
      expect(hash).toBe(createHash('sha256').update(archive).digest('hex'));
      expect(last).toBe(archive.length);
      await unpackPayload(join(directory, 'payload.zip'), join(directory, 'stage'), '2.1.0');
      for (const [name, bytes] of Object.entries(entries)) expect(readFileSync(join(directory, 'stage', name)).equals(bytes)).toBe(true);
      // One byte changed at the very end: the signature covers the whole payload.
      const altered = Buffer.from(archive);
      altered[altered.length - 1]! ^= 1;
      served = altered;
      await expect(downloadPayload(offer, join(directory, 'altered.zip'), AbortSignal.timeout(10_000), () => {}, publicKey)).rejects.toThrow('verification failed');
    }
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('signed server archives cannot escape staging or disagree with their offered version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-archive-'));
  try {
    const zip = join(root, 'payload.zip');
    const entries = { 'boite-core': Buffer.from('executable'), 'boite': Buffer.from('shim'), 'ui/index.html': Buffer.from('UI'), 'server-release.json': Buffer.from('{"version":"2.1.0"}') };
    writeFileSync(zip, zipSync(entries));
    await expect(unpackPayload(zip, join(root, 'stage'), '2.0.0')).rejects.toThrow('version');
    writeFileSync(zip, zipSync({ ...entries, 'ui/../../escaped': Buffer.from('unsafe') }));
    await expect(unpackPayload(zip, join(root, 'stage'), '2.1.0')).rejects.toThrow('Unsafe');
    expect(readdirSync(root)).not.toContain('escaped');
    writeFileSync(zip, zipSync({ ...entries, 'other': Buffer.from('extra') }));
    await expect(unpackPayload(zip, join(root, 'stage-other'), '2.1.0')).rejects.toThrow('Unexpected');
    expect(readdirSync(join(root, 'stage-other'))).not.toContain('other');
    const { 'boite': _, ...missing } = entries;
    writeFileSync(zip, zipSync(missing));
    await expect(unpackPayload(zip, join(root, 'stage-missing'), '2.1.0')).rejects.toThrow('missing boite');
    // A cancelled update stops unpacking.
    writeFileSync(zip, zipSync(entries));
    await expect(unpackPayload(zip, join(root, 'stage-cancelled'), '2.1.0', AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A test core whose updater stages instantly; `agentUpdating` stands in for an agent install under way. */
async function updatingCore(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const state = { stops: 0, planFile: '', agentUpdating: false };
  const platform: ServerUpdatePlatform = {
    inspect: async () => ({ directory: join(root, 'install'), executable: join(root, 'install', 'boite-core'), service: 'test.service' }),
    launch: async (_run, _executable, plan) => { state.planFile = plan; writeFileSync(join(dirname(plan), 'ready'), ''); },
    control: async () => undefined,
    mainPid: async () => process.pid,
  };
  const h = await startTestCore({ onShutdown: () => { state.stops++; }, serverUpdates: { platform, pollMs: 5,
    findOffer: async () => ({ version: '2.0.0-beta.2', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.test/signed.zip', signature: 'signed' }),
    prepare: async () => 'a'.repeat(64) } });
  Object.defineProperty(h.core.updates, 'busy', { get: () => state.agentUpdating, configurable: true });
  const admitted = () => { try { return readFileSync(join(dirname(state.planFile), 'admitted'), 'utf8'); } catch { return null; } };
  return { root, state, h, admitted, stop: async () => { await h.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test('a busy server hands running and queued turns to the next core at once; only an agent install holds it, and cancel stops nothing', async () => {
  const { state, h, admitted, stop } = await updatingCore('boite-server-controller-');
  let release: (() => void) | undefined;
  try {
    const client = await h.connect();
    expect((await client.call('core.updateStatus', { refresh: true })).phase).toBe('available');
    await expect(client.call('core.updateInstall', { version: '2.0.0-beta.3' })).rejects.toThrow('version');
    const first = await echoThread(h, client, 'first');
    const second = await echoThread(h, client, 'queued');
    release = holdAccountTurns(h, second.accountId);
    await client.call('turns.start', { threadId: first.threadId, prompt: '[sleep:60000] work for hours' });
    expect((await client.call('turns.start', { threadId: second.threadId, prompt: 'queued work' })).status).toBe('queued');
    // A half-written agent install holds the restart, and the wait can be cancelled.
    state.agentUpdating = true;
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'waiting');
    await Bun.sleep(50);
    expect(h.core.serverUpdates.snapshot().phase).toBe('waiting');
    expect(state.stops).toBe(0);
    expect(h.core.stopping).toBe(false);
    expect((await client.call('core.updateCancel', {})).phase).toBe('available');
    expect(h.core.stopping).toBe(false);
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'waiting');
    // The install done, a busy server no longer waits for its work to end.
    state.agentUpdating = false;
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'installing');
    expect(admitted()).toBe(JSON.parse(readFileSync(state.planFile, 'utf8')).id);
    const record = h.core.journal.getSetting('restart-handoff') as { turns: { threadId: string; was: string }[] };
    // Both turns wait on the held account; the next core puts them back in line.
    expect(record.turns.map(turn => turn.threadId).sort()).toEqual([first.threadId, second.threadId].sort());
    await waitFor(() => state.stops === 1, 15_000);
  } finally { release?.(); await stop(); }
});

test('an idle server installs through the idle gate and hands nothing over', async () => {
  const { state, h, admitted, stop } = await updatingCore('boite-server-idle-');
  try {
    const client = await h.connect();
    await client.call('core.updateStatus', { refresh: true });
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'installing');
    expect(admitted()).not.toBeNull();
    expect(h.core.journal.getSetting('restart-handoff')).toBeUndefined();
    await waitFor(() => state.stops === 1);
  } finally { await stop(); }
});

test('a failed update admission write leaves the server running and reports the error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-admission-'));
  let stops = 0;
  const platform: ServerUpdatePlatform = {
    inspect: async () => ({ directory: join(root, 'install'), executable: join(root, 'install', 'boite-core'), service: 'test.service' }),
    launch: async (_run, _executable, plan) => {
      // A directory at the marker path makes the acknowledgement fail deterministically.
      mkdirSync(join(dirname(plan), 'admitted'));
      mkdirSync(join(dirname(plan), 'cancelled'));
      writeFileSync(join(dirname(plan), 'ready'), '');
    },
    control: async () => undefined,
    mainPid: async () => process.pid,
  };
  const h = await startTestCore({ onShutdown: () => { stops++; }, serverUpdates: { platform, pollMs: 5,
    findOffer: async () => ({ version: '2.0.0-beta.2', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.test/signed.zip', signature: 'signed' }),
    prepare: async () => 'a'.repeat(64) } });
  try {
    const client = await h.connect();
    await client.call('core.updateStatus', { refresh: true });
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'error');
    expect(stops).toBe(0);
    expect(h.core.stopping).toBe(false);
    expect(h.core.serverUpdates.snapshot().phase).toBe('error');
    expect(h.core.serverUpdates.snapshot().error).toContain('EISDIR');
    expect((await client.call('core.updateStatus', {})).phase).toBe('error');
  } finally { await h.stop(); rmSync(root, { recursive: true, force: true }); }
});

/** An installation, its data and a staged update, as the core leaves them for the worker. */
async function updateFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-server-apply-')));
  const install = join(root, 'install');
  const data = join(root, 'data');
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const operation = join(root, `.boite-update-${id}`);
  mkdirSync(install); mkdirSync(data); mkdirSync(operation);
  writeFileSync(join(install, 'boite-core'), 'old executable');
  writeFileSync(join(data, 'pairing.json'), 'test pairing survives');
  // A bulk store the snapshot leaves out: a rollback keeps the live one.
  mkdirSync(join(data, 'checkpoints', 'thr_a'), { recursive: true });
  writeFileSync(join(data, 'checkpoints', 'thr_a', 'object'), 'checkpoint bytes');
  const db = new Database(join(data, 'journal.db'));
  db.run('CREATE TABLE saved (message TEXT)'); db.run("INSERT INTO saved VALUES ('conversation')"); db.close();
  const entries = { 'boite-core': Buffer.from('new executable'), 'boite': Buffer.from('new shim'), 'ui/index.html': Buffer.from('new UI'), 'server-release.json': Buffer.from('{"version":"2.1.0"}') };
  const archive = zipSync(entries);
  writeFileSync(join(operation, 'payload.zip'), archive);
  await unpackPayload(join(operation, 'payload.zip'), join(operation, 'stage'), '2.1.0');
  const plan: ServerUpdatePlan = { id, installation: { directory: install, executable: join(install, 'boite-core'), service: 'test.service' }, dataDir: data,
    version: '2.1.0', previousVersion: '2.0.0', originalPid: 123, healthUrl: 'http://127.0.0.1:7337/health', archiveHash: createHash('sha256').update(archive).digest('hex') };
  const file = join(operation, 'plan.json');
  writeFileSync(file, JSON.stringify(plan));
  const state = { pid: 123 };
  const controls: string[] = [];
  const platform: ServerUpdatePlatform = { inspect: async () => null, launch: async () => undefined,
    mainPid: async () => state.pid,
    control: async (_unit, action) => {
      controls.push(action); state.pid = action === 'start' ? 456 : 0;
      if (action === 'start' && readFileSync(join(install, 'boite-core'), 'utf8') === 'new executable') {
        const migrated = new Database(join(data, 'journal.db')); migrated.run('ALTER TABLE saved ADD COLUMN newer_schema INTEGER'); migrated.close();
        writeFileSync(join(data, 'pairing.json'), 'new run changed pairing');
        writeFileSync(join(data, 'checkpoints', 'thr_a', 'object2'), 'written by the new run');
      }
    } };
  const result = () => JSON.parse(readFileSync(join(data, 'server-update-result.json'), 'utf8')) as { version: string; error: string | null };
  /** The previous binary, journal, pairing and live checkpoints, as a rollback must leave them. */
  const expectPrevious = () => {
    expect(readFileSync(join(install, 'boite-core'), 'utf8')).toBe('old executable');
    expect(readFileSync(join(data, 'pairing.json'), 'utf8')).toBe('test pairing survives');
    const restored = new Database(join(data, 'journal.db'));
    expect(restored.query('SELECT * FROM saved').all()).toEqual([{ message: 'conversation' }]); restored.close();
    expect(readFileSync(join(data, 'checkpoints', 'thr_a', 'object'), 'utf8')).toBe('checkpoint bytes');
  };
  return { root, install, data, id, operation, backup: join(root, `.boite-backup-${id}`), file, plan, state, controls, platform, result, expectPrevious,
    stop: () => rmSync(root, { recursive: true, force: true }) };
}

const APPLY_CASES = {
  installs: 'installs the complete bundle and checks the new process health',
  fails: 'restores the previous binary, SQLite journal and pairing on a failed restart',
  full: 'restarts the untouched server when the disk cannot hold the backup',
} as const;
for (const mode of ['installs', 'fails', 'full'] as const) test(`update helper ${APPLY_CASES[mode]}`, async () => {
  const fails = mode === 'fails';
  const f = await updateFixture();
  // Two older snapshots: a successful update keeps the newest two in all.
  const older = ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc'].map((name, index) => {
    const path = join(f.root, `.boite-backup-${name}`);
    mkdirSync(path); utimesSync(path, new Date(2026, 0, 1 + index), new Date(2026, 0, 1 + index));
    return path;
  });
  writeFileSync(join(f.operation, 'admitted'), f.id);
  try {
    const run = applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35,
      spareBytes: mode === 'full' ? Number.MAX_SAFE_INTEGER : 0,
      health: async () => fails ? null : { ok: true, version: '2.1.0', pid: 456 } });
    if (mode === 'full') {
      await expect(run).rejects.toThrow('Not enough disk space');
      // The core admitted the update and exits by itself; it is started again as it was.
      expect(f.controls).toEqual(['stop', 'start']);
      expect(existsSync(f.backup)).toBe(false);
      expect(readFileSync(join(f.install, 'boite-core'), 'utf8')).toBe('old executable');
      expect(f.result().error).toContain('Server update was not installed. Not enough disk space');
    } else if (fails) {
      await expect(run).rejects.toThrow('healthy');
      f.expectPrevious();
      expect(f.controls).toEqual(['stop', 'start', 'stop', 'start']);
      expect(older.every(path => existsSync(path))).toBe(true);
      // The failure stays for diagnosis, marked as handled for the recovery and the next update.
      expect(existsSync(join(f.operation, 'finished'))).toBe(true);
    } else {
      await run;
      expect(readFileSync(join(f.install, 'boite-core'), 'utf8')).toBe('new executable');
      expect(readFileSync(join(f.install, 'ui', 'index.html'), 'utf8')).toBe('new UI');
      expect(readFileSync(join(f.backup, 'installation', 'boite-core'), 'utf8')).toBe('old executable');
      expect(existsSync(join(f.backup, 'data', 'pairing.json'))).toBe(true);
      expect(existsSync(join(f.backup, 'data', 'checkpoints'))).toBe(false);
      expect(existsSync(join(f.backup, 'data.partial'))).toBe(false);
      expect(f.controls).toEqual(['stop', 'start']);
      // The oldest snapshot goes; this one and the newest older one stay.
      expect(older.map(path => existsSync(path))).toEqual([false, true]);
    }
    // The recovery that follows any worker exit has nothing left to do.
    const controls = f.controls.length;
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35 });
    expect(f.controls.length).toBe(controls);
  } finally { f.stop(); }
});

/**
 * Where a worker killed mid-update (the memory controller once did it 30 s
 * into the snapshot copy) leaves the disk, rebuilt step by step.
 */
const KILLED_AT = {
  copy: 'during the snapshot copy',
  switch: 'between moving the installation aside and moving the new one in',
  health: 'while the new version was starting, and it never became healthy',
  // A version the worker rejected stays rejected, even if it answers health once restarted.
  rejected: 'between stopping the rejected version and moving it aside',
  restore: 'during its own rollback, once the restored data had been copied',
} as const;
for (const point of Object.keys(KILLED_AT) as (keyof typeof KILLED_AT)[]) test(`the recovery of a worker killed ${KILLED_AT[point]} restores the previous version and starts it`, async () => {
  const f = await updateFixture();
  const link = join(f.root, `.boite-recover-${f.id}`);
  try {
    writeFileSync(join(f.operation, 'admitted'), f.id);
    writeFileSync(link, 'recovery executable');
    f.state.pid = 0;
    mkdirSync(f.backup);
    if (point === 'copy') {
      mkdirSync(join(f.backup, 'data.partial'));
      writeFileSync(join(f.backup, 'data.partial', 'pairing.json'), 'test pairing survives');
    } else {
      cpSync(f.data, join(f.backup, 'data'), { recursive: true, filter: (source) => !source.includes('checkpoints') });
      renameSync(f.install, join(f.backup, 'installation'));
      if (point !== 'switch') {
        renameSync(join(f.operation, 'stage'), f.install);
        await f.platform.control(f.plan.installation.service, 'start');
      }
      if (point === 'rejected' || point === 'restore') {
        writeFileSync(join(f.operation, 'rolling-back'), '');
        await f.platform.control(f.plan.installation.service, 'stop');
      }
      if (point === 'restore') {
        renameSync(f.install, join(f.operation, 'failed-installation'));
        renameSync(join(f.backup, 'installation'), f.install);
        const restored = `${f.data}.restore-${f.id}`;
        cpSync(join(f.backup, 'data'), restored, { recursive: true });
        renameSync(join(f.data, 'checkpoints'), join(restored, 'checkpoints'));
        renameSync(f.data, `${f.data}.failed-${f.id}`);
      }
    }
    f.controls.length = 0;
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, health: async () => point === 'rejected' ? { ok: true, version: '2.1.0', pid: 456 } : null,
      env: { SERVICE_RESULT: 'oom-kill', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' } });
    f.expectPrevious();
    expect(f.controls.at(-1)).toBe('start');
    expect(f.state.pid).toBe(456);
    expect(f.result().error).toBe('Server update failed; the previous version was restored. The update worker ended before it finished (oom-kill, killed, KILL)');
    // A snapshot cut short goes; a complete one stays with the failure.
    expect(existsSync(f.backup)).toBe(point !== 'copy');
    expect(existsSync(f.operation)).toBe(false);
    expect(existsSync(link)).toBe(false);
  } finally { f.stop(); }
});

test('the recovery of a worker killed before it saw the new version healthy keeps that version', async () => {
  const f = await updateFixture();
  try {
    writeFileSync(join(f.operation, 'admitted'), f.id);
    // A health check that never answers holds the worker where a kill would have cut it.
    const worker = applyServerUpdate(f.file, f.platform, { pollMs: 5, spareBytes: 0, health: () => new Promise(() => undefined) });
    await waitFor(() => f.state.pid === 456);
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 1000, health: async () => ({ ok: true, version: '2.1.0', pid: 456 }) });
    void worker;
    expect(readFileSync(join(f.install, 'boite-core'), 'utf8')).toBe('new executable');
    expect(f.result().error).toBeNull();
    expect(f.controls).toEqual(['stop', 'start']);
    expect(existsSync(join(f.backup, 'data', 'journal.db'))).toBe(true);
    expect(existsSync(f.operation)).toBe(false);
  } finally { f.stop(); }
});

test('the recovery of a worker that never had the core stop closes admission and leaves the server alone', async () => {
  const f = await updateFixture();
  try {
    await recoverServerUpdate(f.file, f.platform);
    expect(f.controls).toEqual([]);
    expect(existsSync(f.operation)).toBe(false);
    // The core's acknowledgement now fails, so it keeps running instead of stopping for a worker that is gone.
    expect(() => writeFileSync(join(f.operation, 'admitted'), f.id)).toThrow();
    expect(existsSync(join(f.root, 'data', 'server-update-result.json'))).toBe(false);
  } finally { f.stop(); }
});

test('the next update clears what a worker cut off with its recovery left, and keeps a handled failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-stale-'));
  const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
  try {
    const unfinished = join(root, `.boite-update-${uuid('a')}`);
    const handled = join(root, `.boite-update-${uuid('b')}`);
    mkdirSync(join(unfinished, 'stage'), { recursive: true });
    mkdirSync(handled); writeFileSync(join(handled, 'finished'), '');
    writeFileSync(join(root, `.boite-recover-${uuid('a')}`), '');
    const partial = join(root, `.boite-backup-${uuid('a')}`);
    const complete = join(root, `.boite-backup-${uuid('b')}`);
    mkdirSync(join(partial, 'data.partial'), { recursive: true });
    mkdirSync(join(complete, 'data'), { recursive: true });
    mkdirSync(join(root, 'install'));
    clearStaleUpdates(root);
    expect(readdirSync(root).sort()).toEqual([`.boite-backup-${uuid('b')}`, `.boite-update-${uuid('b')}`, 'install']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the Linux worker is throttled rather than capped and its unit recovers the service however it ends', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-server-launch-')));
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  try {
    const executable = join(root, 'install', 'boite-core');
    mkdirSync(dirname(executable)); writeFileSync(executable, 'core');
    const plan = join(root, `.boite-update-${id}`, 'plan.json');
    let args: string[] = [];
    await linuxServerUpdates().launch(async (_command, given) => { args = given; return ''; }, executable, plan);
    const link = join(root, `.boite-recover-${id}`);
    expect(readFileSync(link, 'utf8')).toBe('core');
    expect(args).toContain('--property=MemoryHigh=1G');
    expect(args.some(arg => arg.includes('MemoryMax'))).toBe(false);
    expect(args).toContain(`--property=ExecStopPost=-${unitWord(link)} update-recover ${unitWord(plan)}`);
    expect(args.slice(-3)).toEqual([executable, 'update-apply', plan]);
    // A refused launch takes its link back.
    rmSync(link);
    await expect(linuxServerUpdates().launch(async () => { throw new Error('systemd-run: refused'); }, executable, plan)).rejects.toThrow('refused');
    expect(existsSync(link)).toBe(false);
    expect(unitWord('/srv/my "boite"')).toBe(String.raw`"/srv/my \"boite\""`);
    expect(() => unitWord('/srv/$HOME/boite')).toThrow('must not contain');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
