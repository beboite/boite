import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestCore, echoThread, removeDir, rolledBackArchive, waitFor, type TestCore } from './harness.ts';
import { holdTurn, openCard, saveSecret, secretValue, SpyVault, stopTurn } from './secret-fixture.ts';
import { thrown } from './settle.ts';
import { DpapiVault } from '../src/platform/windows/dpapi-vault.ts';
import { KeychainVault, SecretServiceVault } from '../src/platform/posix-vault.ts';

let h: TestCore;
afterEach(async () => { await h?.stop(); });
const quiet = { action: 'run' as const, as: 'API_KEY', command: process.execPath, args: ['-e', ''] };

test('Secret Drop never opens a persistent vault and refuses an old client asking to keep a key', async () => {
  let opened = 0;
  const vault = new SpyVault(true);
  h = await startTestCore({ secretVault: async () => { opened += 1; return vault; } });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const card = await openCard(h, owner, threadId, 'API_KEY');
  expect(await thrown(owner.call('secrets.answer', { threadId, requestId: card.requestId, value: secretValue(), keep: true } as never))).toThrow('keep');
  await owner.call('secrets.answer', { threadId, requestId: card.requestId, value: secretValue() });
  expect(await card.asked).toMatchObject({ outcome: 'saved', storage: 'memory' });
  expect(opened).toBe(0);
  expect(await vault.ids()).toEqual([]);
});

test('a transit ref is consumed atomically: two simultaneous commands cannot use the same secret', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', secretValue());
  const results = await Promise.allSettled([0, 1].map(() => owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});

test('an unused ref expires after ten minutes even without a sweep', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', secretValue());
  h.core.secrets.now = () => Date.now() + 10 * 60_000 + 1;
  expect(await thrown(owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } }))).toThrow('expired');
});

test('an archive that rolls back leaves the running turn its ref', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', secretValue());
  rolledBackArchive(h, threadId);
  expect(h.core.threads.require(threadId).archived).toBe(false);
  expect(await owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } })).toMatchObject({ exitCode: 0 });
});

test('ending a turn erases an unused ref before another turn starts', async () => {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  await holdTurn(h, owner, threadId);
  const ref = await saveSecret(h, owner, threadId, 'API_KEY', secretValue());
  await stopTurn(h, owner, threadId);
  await holdTurn(h, owner, threadId);
  expect(await thrown(owner.call('secrets.use', { threadId, ref, use: { ...quiet, cwd: h.dataDir } }))).toThrow('erased');
});

test('legacy project keys and transit copies are erased at startup without reading their values', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-secret-migration-'));
  const vault = new SpyVault(true);
  try {
    h = await startTestCore({ dataDir, secretVault: async () => vault });
    const owner = await h.connect();
    const { threadId } = await echoThread(h, owner);
    const projectId = h.core.threads.get(threadId).projectId!;
    const createdAt = Date.now();
    h.core.secrets.index.update(data => {
      data.version = 1;
      data.kept.push({ id: 'key_legacy12345678', projectId, name: 'API_KEY', createdAt, lastUsedAt: null });
      data.transit.push({ id: 'sec_legacy12345678', threadId, projectId, name: 'TOKEN', createdAt, expiresAt: createdAt + 86_400_000 });
    });
    for (const id of ['key_legacy12345678', 'sec_legacy12345678', 'sec_orphan12345678']) await vault.put(id, new TextEncoder().encode(secretValue()));
    await h.stop();
    h = await startTestCore({ dataDir, secretVault: async () => vault });
    await waitFor(() => vault.taken.length > 0 || h.core.secrets.index.data.kept.length === 0);
    expect(await vault.ids()).toEqual([]);
    expect(vault.taken).toEqual([]);
    expect(h.core.secrets.index.data.transit).toEqual([]);
    expect((await (await h.connect()).call('secrets.list', { projectId })).secrets).toEqual([]);
  } finally {
    await h.stop();
    await removeDir(dataDir);
  }
});

test('a failed legacy deletion keeps its cleanup record and retries without exposing or reusing the key', async () => {
  let unavailable = true;
  let attempts = 0;
  h = await startTestCore({ secretVault: async () => new SecretServiceVault() });
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const projectId = h.core.threads.get(threadId).projectId!;
  h.core.secrets.index.update(data => {
    data.version = 1;
    for (const id of ['key_retry12345678', 'key_other12345678']) {
      data.kept.push({ id, projectId, name: 'API_KEY', createdAt: Date.now(), lastUsedAt: null });
    }
  });
  const spawn = Bun.spawn;
  const helper = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
    const options = args[0] as { cmd?: string[] };
    if (options?.cmd?.[0] === 'secret-tool' || options?.cmd?.[0] === 'security') {
      const linux = options.cmd[0] === 'secret-tool';
      if (linux) attempts += 1;
      // Neither native helper runs: a locked Linux keyring exits silently; macOS reports a missing item.
      const code = linux ? (unavailable && options.cmd.at(-1) === 'key_retry12345678' ? 1 : 0) : 44;
      return Reflect.apply(spawn, Bun, [{ ...options, cmd: [process.execPath, '-e', `process.exit(${code})`] }]);
    }
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn);
  try {
    expect(await thrown(h.core.secrets.sweep(false))).toThrow('secret-tool could not erase a legacy secret (exit 1)');
    expect(h.core.secrets.index.data).toMatchObject({ version: 1, kept: [{ id: 'key_retry12345678' }] });
    expect((await owner.call('secrets.list', { projectId })).secrets).toEqual([]);
    await new KeychainVault().delete('key_missing12345678');
    unavailable = false;
    await h.core.secrets.sweep(false);
    expect(attempts).toBe(3);
    expect(h.core.secrets.index.data).toMatchObject({ version: 2, kept: [], transit: [] });
  } finally { helper.mockRestore(); }
});

test('legacy Windows blobs are deleted without decryption and unrelated files remain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-secret-blobs-'));
  try {
    writeFileSync(join(dir, 'key_legacy12345678.bin'), 'synthetic sealed bytes');
    writeFileSync(join(dir, 'index.json'), '{}');
    const vault = new DpapiVault(dir);
    expect(await vault.ids()).toEqual(['key_legacy12345678']);
    await vault.delete('key_legacy12345678');
    expect(existsSync(join(dir, 'key_legacy12345678.bin'))).toBe(false);
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
    expect(await thrown(vault.delete('../outside'))).toThrow('secret id');
  } finally { await removeDir(dir); }
});

test('startup erases orphaned legacy blobs even when their index was lost', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'boite-secret-orphans-'));
  try {
    const dir = join(dataDir, 'secrets');
    mkdirSync(dir);
    const blob = join(dir, 'sec_orphan12345678.bin');
    writeFileSync(blob, 'synthetic sealed bytes');
    h = await startTestCore({ dataDir, secretVault: async path => new DpapiVault(path) });
    await waitFor(() => !existsSync(blob));
    expect(h.core.secrets.index.data.version).toBe(2);
  } finally { await h.stop(); await removeDir(dataDir); }
});
