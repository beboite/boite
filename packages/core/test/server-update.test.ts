import { expect, test } from 'bun:test';
import { generateKeyPairSync, createHash, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { Database } from 'bun:sqlite';
import { verifyPayload, unpackPayload } from '../src/server-update/release.ts';
import { applyServerUpdate } from '../src/server-update/apply.ts';
import type { ServerUpdatePlan, ServerUpdatePlatform } from '../src/server-update/types.ts';
import { echoThread, holdAccountTurns, startTestCore, waitFor } from './harness.ts';

test('publisher signatures reject altered bytes, a different key and changed trusted comments', () => {
  const keys = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const rawKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKey = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, rawKey]).toString('base64')}\n`).toString('base64');
  const bytes = Buffer.from('a signed server bundle');
  for (const algorithm of ['Ed', 'ED']) {
    const data = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
    const signature = sign(null, data, keys.privateKey);
    const comment = 'version:2.0.0';
    const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64');
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), keys.privateKey).toString('base64');
    const plain = `untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${global}\n`;
    const encoded = Buffer.from(plain).toString('base64');
    expect(() => verifyPayload(bytes, encoded, publicKey)).not.toThrow();
    expect(() => verifyPayload(Buffer.from('altered bytes'), encoded, publicKey)).toThrow('verification failed');
    expect(() => verifyPayload(bytes, Buffer.from(plain.replace(comment, 'version:9.0.0')).toString('base64'), publicKey)).toThrow('verification failed');
    expect(() => verifyPayload(bytes, encoded, Buffer.from('invalid key').toString('base64'))).toThrow('signing key');
  }
});

test('signed server archives cannot escape staging or disagree with their offered version', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-archive-'));
  try {
    const zip = join(root, 'payload.zip');
    const entries = { 'boite-core': Buffer.from('executable'), 'boite': Buffer.from('shim'), 'ui/index.html': Buffer.from('UI'), 'server-release.json': Buffer.from('{"version":"2.1.0"}') };
    writeFileSync(zip, zipSync(entries));
    expect(() => unpackPayload(zip, join(root, 'stage'), '2.0.0')).toThrow('version');
    writeFileSync(zip, zipSync({ ...entries, 'ui/../../escaped': Buffer.from('unsafe') }));
    expect(() => unpackPayload(zip, join(root, 'stage'), '2.1.0')).toThrow('Unsafe');
    expect(readdirSync(root)).not.toContain('escaped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('server updates wait for running and queued work, cancel without stopping it, and reject stale versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-server-controller-'));
  let stops = 0;
  const platform: ServerUpdatePlatform = {
    inspect: async () => ({ directory: join(root, 'install'), executable: join(root, 'install', 'boite-core'), service: 'test.service' }),
    launch: async (_run, _executable, plan) => { writeFileSync(join(dirname(plan), 'ready'), ''); },
    control: async () => undefined,
    mainPid: async () => process.pid,
  };
  const h = await startTestCore({ onShutdown: () => { stops++; }, serverUpdates: { platform, pollMs: 5,
    findOffer: async () => ({ version: '2.0.0-beta.2', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.test/signed.zip', signature: 'signed' }),
    prepare: async () => 'a'.repeat(64) } });
  let release: (() => void) | undefined;
  try {
    const client = await h.connect();
    expect((await client.call('core.updateStatus', { refresh: true })).phase).toBe('available');
    await expect(client.call('core.updateInstall', { version: '2.0.0-beta.3' })).rejects.toThrow('version');
    const first = await echoThread(h, client, 'running');
    const second = await echoThread(h, client, 'queued');
    release = holdAccountTurns(h, second.accountId);
    await client.call('turns.start', { threadId: first.threadId, prompt: '[sleep:300] finish my work' });
    expect((await client.call('turns.start', { threadId: second.threadId, prompt: 'queued work' })).status).toBe('queued');
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'waiting');
    expect(stops).toBe(0);
    expect(h.core.stopping).toBe(false);
    expect((await client.call('core.updateCancel', {})).phase).toBe('available');
    expect(h.core.stopping).toBe(false);
    await client.call('core.updateInstall', { version: '2.0.0-beta.2' });
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'waiting');
    release(); release = undefined;
    await waitFor(() => h.core.serverUpdates.snapshot().phase === 'installing');
    await waitFor(() => stops === 1);
    expect(h.core.journal.listTurns(first.threadId)[0]?.status).toBe('done');
    expect(h.core.journal.listTurns(second.threadId)[0]?.status).toBe('done');
  } finally { release?.(); await h.stop(); rmSync(root, { recursive: true, force: true }); }
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

for (const fails of [false, true]) test(`update helper ${fails ? 'restores the previous binary, SQLite journal and pairing on a failed restart' : 'installs the complete bundle and checks the new process health'}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'boite-server-apply-')));
  const install = join(root, 'install');
  const data = join(root, 'data');
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const operation = join(root, `.boite-update-${id}`);
  mkdirSync(install); mkdirSync(data); mkdirSync(operation);
  writeFileSync(join(install, 'boite-core'), 'old executable');
  writeFileSync(join(data, 'pairing.json'), 'test pairing survives');
  const db = new Database(join(data, 'journal.db'));
  db.run('CREATE TABLE saved (message TEXT)'); db.run("INSERT INTO saved VALUES ('conversation')"); db.close();
  const entries = { 'boite-core': Buffer.from('new executable'), 'boite': Buffer.from('new shim'), 'ui/index.html': Buffer.from('new UI'), 'server-release.json': Buffer.from('{"version":"2.1.0"}') };
  const archive = zipSync(entries);
  writeFileSync(join(operation, 'payload.zip'), archive);
  unpackPayload(join(operation, 'payload.zip'), join(operation, 'stage'), '2.1.0');
  const plan: ServerUpdatePlan = { id, installation: { directory: install, executable: join(install, 'boite-core'), service: 'test.service' }, dataDir: data,
    version: '2.1.0', previousVersion: '2.0.0', originalPid: 123, healthUrl: 'http://127.0.0.1:7337/health', archiveHash: createHash('sha256').update(archive).digest('hex') };
  writeFileSync(join(operation, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(operation, 'admitted'), id);
  let pid = 123;
  const controls: string[] = [];
  const platform: ServerUpdatePlatform = { inspect: async () => null, launch: async () => undefined,
    mainPid: async () => pid,
    control: async (_unit, action) => {
      controls.push(action); pid = action === 'start' ? 456 : 0;
      if (action === 'start' && readFileSync(join(install, 'boite-core'), 'utf8') === 'new executable') {
        const migrated = new Database(join(data, 'journal.db')); migrated.run('ALTER TABLE saved ADD COLUMN newer_schema INTEGER'); migrated.close();
        writeFileSync(join(data, 'pairing.json'), 'new run changed pairing');
      }
    } };
  try {
    const run = applyServerUpdate(join(operation, 'plan.json'), platform, { pollMs: 5, healthTimeoutMs: 35,
      health: async () => fails ? null : { ok: true, version: '2.1.0', pid: 456 } });
    if (fails) {
      await expect(run).rejects.toThrow('healthy');
      expect(readFileSync(join(install, 'boite-core'), 'utf8')).toBe('old executable');
      expect(readFileSync(join(data, 'pairing.json'), 'utf8')).toBe('test pairing survives');
      const restored = new Database(join(data, 'journal.db'));
      expect(restored.query('SELECT * FROM saved').all()).toEqual([{ message: 'conversation' }]); restored.close();
      expect(controls).toEqual(['stop', 'start', 'stop', 'start']);
    } else {
      await run;
      expect(readFileSync(join(install, 'boite-core'), 'utf8')).toBe('new executable');
      expect(readFileSync(join(install, 'ui', 'index.html'), 'utf8')).toBe('new UI');
      expect(readFileSync(join(root, `.boite-backup-${id}`, 'installation', 'boite-core'), 'utf8')).toBe('old executable');
      expect(controls).toEqual(['stop', 'start']);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
