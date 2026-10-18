import { expect, test } from 'bun:test';
import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { Database } from 'bun:sqlite';
import { downloadPayload, verifyPayload, unpackPayload } from '../src/server-update/release.ts';
import { applyServerUpdate, clearStaleUpdates, recoverServerUpdate, UNSAVED_DATA, type UpdateDisk } from '../src/server-update/apply.ts';
import { linuxServerUpdates, unitWord } from '../src/platform/linux-server-update.ts';
import { openDataDir, type FileLock, type RestoreMoves } from '../src/server-update/restore.ts';
import type { ServerUpdatePlan, ServerUpdatePlatform } from '../src/server-update/types.ts';
import { echoThread, holdAccountTurns, startTestCore, waitFor } from './harness.ts';
import { lockDataDir } from '../src/main.ts';

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
    lock: () => () => undefined,
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
    lock: () => () => undefined,
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

/** An exclusive lock per path within this process, standing for the kernel's `flock` the Linux platform takes. */
function memoryLock(): FileLock {
  const held = new Set<string>();
  return (file) => {
    if (held.has(file)) throw new Error(`a server update holds ${file}`);
    held.add(file);
    return () => { held.delete(file); };
  };
}

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
  const lock = memoryLock();
  const platform: ServerUpdatePlatform = { inspect: async () => null, launch: async () => undefined,
    mainPid: async () => state.pid, lock,
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
  return { root, install, data, id, operation, backup: join(root, `.boite-backup-${id}`), file, plan, state, controls, platform, lock, result, expectPrevious,
    stop: () => rmSync(root, { recursive: true, force: true }) };
}

const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;

const treeSize = (path: string): number => {
  const info = lstatSync(path);
  return info.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + treeSize(join(path, name)), 0) : info.isFile() ? info.size : 0;
};

/** Bytes the update snapshot copies out of `data`. */
const snapshotSize = (data: string) => readdirSync(data).filter(name => !UNSAVED_DATA.has(name)).reduce((sum, name) => sum + treeSize(join(data, name)), 0);

/**
 * Filesystems with `free[device]` bytes left. A path's device is the one
 * `devices` names for its first segment under `root`, `root` otherwise; a copy
 * past the room left fails as a full disk does, a rename across devices as the kernel refuses it.
 */
function lowDisk(root: string, free: Record<string, number>, devices: Record<string, string> = {}) {
  const left = { ...free };
  const device = (path: string) => devices[path.slice(root.length + 1).split(/[\\/]/)[0]!.replace(/\.(restore|failed)-.*$/, '')] ?? 'root';
  const disk: Partial<UpdateDisk> = {
    free: (path) => left[device(path)]!,
    device: (path) => device(path) === 'root' ? 1 : 2,
    copy: (source, target, filter) => {
      cpSync(source, target, { recursive: true, filter });
      const bytes = treeSize(target);
      if (bytes > left[device(target)]!) {
        rmSync(target, { recursive: true, force: true });
        throw Object.assign(new Error(`ENOSPC: no space left on device, copy '${source}'`), { code: 'ENOSPC' });
      }
      left[device(target)]! -= bytes;
    },
    rename: (source, target) => {
      if (device(source) !== device(target)) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${source}'`), { code: 'EXDEV' });
      renameSync(source, target);
    },
  };
  return { disk, left };
}

const APPLY_CASES = {
  installs: 'installs the complete bundle, checks the new process health and prunes only its own backups',
  fails: 'restores the previous binary, SQLite journal and pairing on a failed restart, on a disk left with only the spare room it checked',
  full: 'restarts the untouched server when the disk cannot hold the backup',
} as const;
for (const mode of ['installs', 'fails', 'full'] as const) test(`update helper ${APPLY_CASES[mode]}`, async () => {
  const fails = mode === 'fails';
  const f = await updateFixture();
  // Two older snapshots of this installation: a successful update keeps the newest two in all.
  const backup = (c: string, installation: string | null, day: number, snapshot = true) => {
    const path = join(f.root, `.boite-backup-${uuid(c)}`);
    mkdirSync(path);
    if (snapshot) mkdirSync(join(path, 'data'));
    if (installation) writeFileSync(join(path, 'backup.json'), JSON.stringify({ installation, at: new Date(2026, 0, day).getTime() }));
    utimesSync(path, new Date(2026, 0, day), new Date(2026, 0, day));
    return path;
  };
  const older = [backup('b', f.install, 1), backup('c', f.install, 2)];
  // Newer backups another installation in the same folder made, and one the user made, are not this update's to prune;
  // nor is the newest of this installation, whose snapshot a rollback used: it must not count as a kept one.
  const foreign = [backup('d', join(f.root, 'other-install'), 3), backup('e', join(f.root, 'other-install'), 4), backup('f', null, 5), backup('9', f.install, 6, false)];
  writeFileSync(join(f.operation, 'admitted'), f.id);
  const spare = 1024;
  // A failed restart finds only the spare room the update checked: the snapshot took the rest.
  const low = lowDisk(f.root, { root: snapshotSize(f.data) + spare });
  try {
    const run = applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35,
      spareBytes: mode === 'full' ? Number.MAX_SAFE_INTEGER : fails ? spare : 0, disk: fails ? low.disk : undefined,
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
      // The snapshot moved back instead of being copied a second time.
      expect(low.left.root).toBe(spare);
      expect([...older, ...foreign].every(path => existsSync(path))).toBe(true);
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
      // The oldest snapshot of this installation goes; this one and the newest older one stay, and nobody else's is touched.
      expect(older.map(path => existsSync(path))).toEqual([false, true]);
      expect(foreign.every(path => existsSync(path))).toBe(true);
      expect(JSON.parse(readFileSync(join(f.backup, 'backup.json'), 'utf8')).installation).toBe(f.install);
    }
    // The recovery that follows any worker exit has nothing left to do.
    const controls = f.controls.length;
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35 });
    expect(f.controls.length).toBe(controls);
  } finally { f.stop(); }
});

test('with the data on another filesystem, an update reserves room there for the rollback copy, which a failed restart then uses', async () => {
  const spare = 1024;
  for (const roomy of [false, true]) {
    const f = await updateFixture();
    writeFileSync(join(f.operation, 'admitted'), f.id);
    const need = snapshotSize(f.data) + spare;
    const low = lowDisk(f.root, { root: need, data: roomy ? need : need - 1 }, { data: 'data' });
    try {
      const run = applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, spareBytes: spare, disk: low.disk, health: async () => null });
      if (!roomy) {
        await expect(run).rejects.toThrow(`Not enough disk space beside ${f.data} for a rollback`);
        expect(f.controls).toEqual(['stop', 'start']);
        expect(existsSync(f.backup)).toBe(false);
        continue;
      }
      await expect(run).rejects.toThrow('healthy');
      f.expectPrevious();
      expect(f.controls).toEqual(['stop', 'start', 'stop', 'start']);
      // A rename cannot cross filesystems: one copy each way, each within the room checked.
      expect(low.left).toEqual({ root: spare, data: spare });
      expect(existsSync(f.backup)).toBe(false);
    } finally { f.stop(); }
  }
});

test('a rollback whose data restore fails after the new version ran keeps the server stopped until the recovery puts the data back', async () => {
  const f = await updateFixture();
  writeFileSync(join(f.operation, 'admitted'), f.id);
  const spare = 1024;
  const need = snapshotSize(f.data) + spare;
  const low = lowDisk(f.root, { root: need, data: need }, { data: 'data' });
  // An I/O error on the copy back across filesystems.
  const disk: Partial<UpdateDisk> = { ...low.disk, copy: (source, target, filter) => {
    if (target.includes('.restore-')) throw Object.assign(new Error(`EIO: i/o error, copy '${source}'`), { code: 'EIO' });
    low.disk.copy!(source, target, filter);
  } };
  try {
    await expect(applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, spareBytes: spare, disk, health: async () => null })).rejects.toThrow('EIO');
    // The previous core would open the data the rejected one migrated: nothing starts it.
    expect(f.controls).toEqual(['stop', 'start', 'stop']);
    expect(readFileSync(join(f.install, 'boite-core'), 'utf8')).toBe('old executable');
    expect(f.result().error).toContain('the previous data could not be put back yet (EIO');
    expect(f.result().error).toContain('the server stays stopped');
    expect(existsSync(join(f.backup, 'data', 'journal.db'))).toBe(true);
    // Recorded for a start after a power cut, and not finished: the recovery that follows the worker's exit retries.
    expect(JSON.parse(readFileSync(`${f.data}.rollback.json`, 'utf8')).id).toBe(f.id);
    expect(existsSync(join(f.operation, 'finished'))).toBe(false);
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, health: async () => null });
    f.expectPrevious();
    expect(f.controls.at(-1)).toBe('start');
    expect(existsSync(`${f.data}.rollback.json`)).toBe(false);
    expect(existsSync(f.operation)).toBe(false);
  } finally { f.stop(); }
});

test('a rollback whose only failure is deleting the used snapshot starts the previous version and finishes', async () => {
  const f = await updateFixture();
  writeFileSync(join(f.operation, 'admitted'), f.id);
  const spare = 1024;
  const need = snapshotSize(f.data) + spare;
  const low = lowDisk(f.root, { root: need, data: need }, { data: 'data' });
  const disk: Partial<UpdateDisk> = { ...low.disk, rename: (source, target) => {
    if (target.endsWith('.consumed')) throw Object.assign(new Error(`EIO: i/o error, rename '${source}'`), { code: 'EIO' });
    low.disk.rename!(source, target);
  } };
  try {
    await expect(applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, spareBytes: spare, disk, health: async () => null })).rejects.toThrow('healthy');
    f.expectPrevious();
    expect(f.controls).toEqual(['stop', 'start', 'stop', 'start']);
    expect(existsSync(join(f.operation, 'finished'))).toBe(true);
  } finally { f.stop(); }
});

/** A rollback a power cut stopped after the new version ran: its record, and the restored copy beside the data or the snapshot still in the backup. */
function cutRollback(f: Awaited<ReturnType<typeof updateFixture>>, moved: boolean, id = f.id) {
  const restored = `${f.data}.restore-${id}`;
  const snapshot = join(f.root, `.boite-backup-${id}`, 'data');
  cpSync(f.data, moved ? restored : snapshot, { recursive: true, filter: (source) => !source.includes('checkpoints') });
  if (moved) renameSync(join(f.data, 'checkpoints'), join(restored, 'checkpoints'));
  writeFileSync(`${f.data}.rollback.json`, JSON.stringify({ id, snapshot }));
  const migrated = new Database(join(f.data, 'journal.db')); migrated.run('ALTER TABLE saved ADD COLUMN newer_schema INTEGER'); migrated.close();
  writeFileSync(join(f.data, 'pairing.json'), 'new run changed pairing');
  return { restored, snapshot };
}

const prepare = (dataDir: string) => mkdirSync(dataDir, { recursive: true });
const open = (f: Awaited<ReturnType<typeof updateFixture>>, moves?: RestoreMoves) => openDataDir(f.data, prepare, f.lock, undefined, moves);

test('an ordinary start creates its data directory and parents, and writes nothing beside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-start-'));
  try {
    // As in the server image, where the data directory is a mount point in an unwritable `/`.
    const data = join(root, 'not-created', 'data');
    const untouchable: FileLock = (file) => { throw new Error(`took ${file}`); };
    openDataDir(data, prepare, untouchable)();
    expect(readdirSync(join(root, 'not-created'))).toEqual(['data']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const moved of [true, false]) test(`a core starting after a power cut cut off a rollback ${moved ? 'swap' : 'copy'} puts the previous data back before opening it, once`, async () => {
  const f = await updateFixture();
  try {
    const { snapshot } = cutRollback(f, moved);
    open(f)();
    f.expectPrevious();
    expect(readFileSync(join(`${f.data}.failed-${f.id}`, 'pairing.json'), 'utf8')).toBe('new run changed pairing');
    expect(f.result().error).toContain('rollback was cut off');
    expect(existsSync(snapshot)).toBe(false);
    expect(existsSync(`${f.data}.rollback.json`)).toBe(false);
    // The next start finds nothing to do.
    writeFileSync(join(f.data, 'pairing.json'), 'paired after the recovery');
    open(f)();
    expect(readFileSync(join(f.data, 'pairing.json'), 'utf8')).toBe('paired after the recovery');
  } finally { f.stop(); }
});

test('a starting core never moves the data under a live core or a restoring worker, and older restores never replay over a completed one', async () => {
  const f = await updateFixture();
  try {
    cutRollback(f, true);
    // An older interrupted rollback's copy, and one whose name is no valid id.
    const older = uuid('1');
    cpSync(`${f.data}.restore-${f.id}`, `${f.data}.restore-${older}`, { recursive: true });
    writeFileSync(join(`${f.data}.restore-${older}`, 'pairing.json'), 'older restore pairing');
    utimesSync(`${f.data}.restore-${older}`, new Date(2030, 0, 1), new Date(2030, 0, 1));
    mkdirSync(`${f.data}.restore-junk`);
    // A live core (a process that is not this one, wrote the lock after it started) holds the data.
    writeFileSync(join(f.data, 'core.lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    const live = (dataDir: string) => lockDataDir(dataDir, () => 0, () => 0, () => null);
    expect(() => openDataDir(f.data, prepare, f.lock, live)).toThrow('another core is already running');
    expect(readFileSync(join(f.data, 'pairing.json'), 'utf8')).toBe('new run changed pairing');
    rmSync(join(f.data, 'core.lock'));
    // A worker restoring holds the maintenance lock.
    const worker = f.lock(`${f.data}.maintenance.lock`);
    expect(() => open(f)).toThrow('a server update holds');
    expect(readFileSync(join(f.data, 'pairing.json'), 'utf8')).toBe('new run changed pairing');
    worker();
    // Both gone, the recorded restore goes in, not the one with the newest date, and every other is set aside.
    open(f)();
    f.expectPrevious();
    expect(readdirSync(f.root).filter(name => name.startsWith('data.restore-'))).toEqual([]);
    expect(readFileSync(join(`${f.data}.unused-restore-${older}`, 'pairing.json'), 'utf8')).toBe('older restore pairing');
    writeFileSync(join(f.data, 'pairing.json'), 'paired after the recovery');
    open(f)();
    expect(readFileSync(join(f.data, 'pairing.json'), 'utf8')).toBe('paired after the recovery');
  } finally { f.stop(); }
});

test('a recorded restore that fails to go in keeps the server closed and its record, and the next start finishes it', async () => {
  const f = await updateFixture();
  try {
    const { restored } = cutRollback(f, true);
    // A rejected-data folder already there: the rename aside cannot take its name.
    mkdirSync(`${f.data}.failed-${f.id}`); writeFileSync(join(`${f.data}.failed-${f.id}`, 'pairing.json'), 'earlier rejected pairing');
    // Then an I/O error on the rename that puts the restored copy in.
    const failing: RestoreMoves = { copy: () => { throw new Error('no copy here'); }, rename: (source, target) => {
      if (source === restored) throw Object.assign(new Error(`EIO: i/o error, rename '${source}'`), { code: 'EIO' });
      renameSync(source, target);
    } };
    for (let start = 0; start < 2; start++) expect(() => open(f, failing)).toThrow('the server stays stopped');
    expect(JSON.parse(readFileSync(`${f.data}.rollback.json`, 'utf8')).id).toBe(f.id);
    expect(existsSync(join(restored, 'journal.db'))).toBe(true);
    open(f)();
    f.expectPrevious();
    // The data in place when the start came, kept beside it.
    expect(readFileSync(join(`${f.data}.unused-data`, 'pairing.json'), 'utf8')).toBe('new run changed pairing');
    expect(existsSync(`${f.data}.rollback.json`)).toBe(false);
  } finally { f.stop(); }
});

test('a recorded restore that is no directory is set aside and redone from the snapshot, or the start is refused', async () => {
  const f = await updateFixture();
  try {
    cutRollback(f, false);
    writeFileSync(`${f.data}.restore-${f.id}`, 'not a directory');
    open(f)();
    f.expectPrevious();
    expect(readFileSync(`${f.data}.unused-restore-${f.id}`, 'utf8')).toBe('not a directory');
    // Without the snapshot, the data in place stays the rejected version's: nothing opens it.
    const next = uuid('2');
    rmSync(cutRollback(f, false, next).snapshot, { recursive: true, force: true });
    writeFileSync(`${f.data}.restore-${next}`, 'not a directory');
    expect(() => open(f)).toThrow('is missing');
    expect(readFileSync(join(f.data, 'pairing.json'), 'utf8')).toBe('new run changed pairing');
    expect(existsSync(`${f.data}.rollback.json`)).toBe(true);
  } finally { f.stop(); }
});

test('a start never opens a fresh data directory beside a restore whose record it cannot read', async () => {
  const f = await updateFixture();
  try {
    // A swap cut between its two renames, its record left empty.
    const { restored } = cutRollback(f, true);
    renameSync(f.data, `${f.data}.failed-${f.id}`);
    writeFileSync(`${f.data}.rollback.json`, '');
    expect(() => open(f)).toThrow('cannot be read');
    expect(existsSync(f.data)).toBe(false);
    expect(existsSync(join(restored, 'journal.db'))).toBe(true);
    expect(existsSync(`${f.data}.rollback.json`)).toBe(true);
  } finally { f.stop(); }
});

test('a rollback records its restore before the previous version can boot, so a power cut right after leaves it to the next start', async () => {
  const f = await updateFixture();
  writeFileSync(join(f.operation, 'admitted'), f.id);
  // The power goes the moment the previous installation is back in place.
  const disk: Partial<UpdateDisk> = { rename: (source, target) => {
    renameSync(source, target);
    if (target === f.install) throw new Error('power cut');
  } };
  try {
    await expect(applyServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, spareBytes: 0, disk, health: async () => null })).rejects.toThrow('power cut');
    expect(readFileSync(join(f.install, 'boite-core'), 'utf8')).toBe('old executable');
    // At boot the service starts the previous version.
    open(f)();
    f.expectPrevious();
    expect(f.result().error).toContain('rollback was cut off');
  } finally { f.stop(); }
});

test.skipIf(process.platform !== 'linux')('the Linux maintenance lock has one holder at a time, and a killed holder leaves it free', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-lock-'));
  const file = join(root, 'data.maintenance.lock');
  const { linuxFileLock } = await import('../src/platform/linux-server-update.ts');
  try {
    const release = linuxFileLock(file);
    expect(() => linuxFileLock(file)).toThrow('a server update holds');
    release();
    linuxFileLock(file)();
    const script = `const { linuxFileLock } = await import(${JSON.stringify(join(import.meta.dir, '../src/platform/linux-server-update.ts'))}); linuxFileLock(${JSON.stringify(file)}); console.log('held'); setInterval(() => {}, 1000);`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');
      expect(() => linuxFileLock(file)).toThrow('a server update holds');
    } finally { child.kill('SIGKILL'); await child.exited; }
    linuxFileLock(file)();
  } finally { rmSync(root, { recursive: true, force: true }); }
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
  restore: 'during its own rollback, once the snapshot had moved back and taken the live checkpoints',
  // Across filesystems the snapshot is copied back, then deleted, which a kill can cut short.
  cleanup: 'during its own rollback across filesystems, while it deleted the snapshot it had copied back',
} as const;
for (const point of Object.keys(KILLED_AT) as (keyof typeof KILLED_AT)[]) test(`the recovery of a worker killed ${KILLED_AT[point]} restores the previous version and starts it`, async () => {
  const f = await updateFixture();
  const link = join(f.root, `.boite-recover-${f.id}`);
  try {
    writeFileSync(join(f.operation, 'admitted'), f.id);
    writeFileSync(link, 'recovery executable');
    f.state.pid = 0;
    mkdirSync(f.backup);
    writeFileSync(join(f.backup, 'backup.json'), JSON.stringify({ installation: f.install, at: Date.now() }));
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
      if (point === 'rejected' || point === 'restore' || point === 'cleanup') {
        writeFileSync(join(f.operation, 'rolling-back'), '');
        await f.platform.control(f.plan.installation.service, 'stop');
      }
      if (point === 'restore' || point === 'cleanup') {
        renameSync(f.install, join(f.operation, 'failed-installation'));
        renameSync(join(f.backup, 'installation'), f.install);
        const restored = `${f.data}.restore-${f.id}`;
        writeFileSync(`${f.data}.rollback.json`, JSON.stringify({ id: f.id, snapshot: join(f.backup, 'data') }));
        if (point === 'restore') renameSync(join(f.backup, 'data'), restored);
        else {
          cpSync(join(f.backup, 'data'), restored, { recursive: true });
          rmSync(join(f.backup, 'data', 'journal.db'));
        }
        renameSync(join(f.data, 'checkpoints'), join(restored, 'checkpoints'));
      }
    }
    f.controls.length = 0;
    await recoverServerUpdate(f.file, f.platform, { pollMs: 5, healthTimeoutMs: 35, health: async () => point === 'rejected' ? { ok: true, version: '2.1.0', pid: 456 } : null,
      env: { SERVICE_RESULT: 'oom-kill', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' } });
    f.expectPrevious();
    expect(f.controls.at(-1)).toBe('start');
    expect(f.state.pid).toBe(456);
    expect(f.result().error).toBe('Server update failed; the previous version was restored. The update worker ended before it finished (oom-kill, killed, KILL)');
    // A snapshot cut short goes, and so does one that became the data again; one never used stays with the failure.
    expect(existsSync(f.backup)).toBe(point === 'switch');
    expect(existsSync(`${f.data}.rollback.json`)).toBe(false);
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

test('the next update clears what a worker of this installation cut off with its recovery left, keeps a handled failure and never touches another installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-stale-'));
  const install = join(root, 'install');
  const other = join(root, 'install-dev');
  const operation = (c: string, record: 'owner' | 'plan' | null, installation = install) => {
    const path = join(root, `.boite-update-${uuid(c)}`);
    mkdirSync(join(path, 'stage'), { recursive: true });
    if (record === 'owner') writeFileSync(join(path, 'owner.json'), JSON.stringify({ installation }));
    if (record === 'plan') writeFileSync(join(path, 'plan.json'), JSON.stringify({ installation: { directory: installation } }));
    return path;
  };
  const backup = (c: string, part: 'data' | 'data.partial' | 'data.consumed', installation: string | null) => {
    const path = join(root, `.boite-backup-${uuid(c)}`);
    mkdirSync(join(path, part), { recursive: true });
    if (installation) writeFileSync(join(path, 'backup.json'), JSON.stringify({ installation, at: 1 }));
  };
  try {
    mkdirSync(install);
    // This installation's worker cut off mid-copy, and a failure it handled.
    operation('a', 'owner'); backup('a', 'data.partial', install);
    writeFileSync(join(root, `.boite-recover-${uuid('a')}`), '');
    writeFileSync(join(operation('b', 'owner'), 'finished'), ''); backup('b', 'data', install);
    // An older release's operation records only its plan, and its snapshot no marker.
    operation('c', 'plan'); backup('c', 'data.partial', null);
    // Another installation in the same folder is updating right now, and an operation names nobody yet.
    operation('d', 'owner', other); backup('d', 'data.partial', other);
    writeFileSync(join(root, `.boite-recover-${uuid('d')}`), '');
    operation('e', null);
    // A rollback put this snapshot back and was killed while it deleted the used copy.
    writeFileSync(join(operation('f', 'owner'), 'finished'), ''); backup('f', 'data.consumed', install);
    writeFileSync(join(root, `.boite-backup-${uuid('f')}`, 'data.consumed', 'journal.db'), 'used journal');
    clearStaleUpdates(root, install);
    expect(readdirSync(root).sort()).toEqual([`.boite-backup-${uuid('b')}`, `.boite-backup-${uuid('d')}`, `.boite-recover-${uuid('d')}`,
      `.boite-update-${uuid('b')}`, `.boite-update-${uuid('d')}`, `.boite-update-${uuid('e')}`, `.boite-update-${uuid('f')}`, 'install']);
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
