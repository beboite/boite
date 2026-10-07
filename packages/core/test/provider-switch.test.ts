import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { RpcEvents } from '@boite/contracts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
beforeEach(async () => { harness = await startTestCore(); });
afterEach(async () => { await harness.stop(); });

/** A user descriptor that marks itself experimental, launched by nothing: only its switch is looked at. */
function writeExperimental(dataDir: string): void {
  const profile = { detect: {}, executable: [{ kind: 'path', value: 'boite-no-such-agent' }], isolation: { LAB_HOME: '{isolationDir}' } };
  mkdirSync(join(dataDir, 'providers'), { recursive: true });
  writeFileSync(join(dataDir, 'providers', 'lab.json'), JSON.stringify({
    id: 'lab', schemaVersion: 1, name: 'Lab', shortName: 'Lab', protocol: 'acp', experimental: true,
    roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'none' }, models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
}

test('a provider turned off starts nothing, says why, and runs again once it is back on', async () => {
  const client = await harness.connect();
  const { threadId, accountId } = await echoThread(harness, client);
  const updates: RpcEvents['providers.updated'][] = [];
  client.on('providers.updated', (payload) => { updates.push(payload); });

  const off = await client.call('providers.setEnabled', { providerId: 'echo', enabled: false });
  expect(off.loaded.find((provider) => provider.id === 'echo')).toMatchObject({ enabled: false, available: true });
  await waitFor(() => updates.length === 1);
  expect(updates[0]?.loaded.find((provider) => provider.id === 'echo')?.enabled).toBe(false);

  // The same answer again is no event: nothing changed.
  await client.call('providers.setEnabled', { providerId: 'echo', enabled: false });
  expect(updates.length).toBe(1);

  await expect(client.call('turns.start', { threadId, prompt: 'hello' })).rejects.toThrow(/Echo is turned off on this machine/);
  await expect(client.call('providers.probe', { providerId: 'echo', accountId })).rejects.toThrow(/turned off/);
  const capabilities = await client.call('threads.capabilities', { threadId });
  expect(capabilities.images.reason).toBe('provider-disabled');
  // The account and the thread are kept: off is not removed.
  expect((await client.call('accounts.list', {})).some((account) => account.id === accountId)).toBe(true);

  const on = await client.call('providers.setEnabled', { providerId: 'echo', enabled: true });
  expect(on.loaded.find((provider) => provider.id === 'echo')?.enabled).toBe(true);
  const turn = await client.call('turns.start', { threadId, prompt: 'hello again' });
  expect(turn.threadId).toBe(threadId);
});

test('an experimental provider is off until someone turns it on, and the choice outlives a restart', async () => {
  writeExperimental(harness.dataDir);
  const client = await harness.connect();
  const loaded = await client.call('providers.reload', {});
  expect(loaded.rejected).toEqual([]);
  expect(loaded.loaded.find((provider) => provider.id === 'lab')).toMatchObject({ enabled: false, experimental: true });
  // Every other provider is on, and none of them says experimental unless its descriptor does.
  expect(loaded.loaded.find((provider) => provider.id === 'echo')).toMatchObject({ enabled: true });
  expect(loaded.loaded.find((provider) => provider.id === 'echo')?.experimental).toBeUndefined();
  expect(loaded.loaded.find((provider) => provider.id === 'opencode-v2')).toMatchObject({ enabled: false, experimental: true });

  await client.call('providers.setEnabled', { providerId: 'lab', enabled: true });
  expect(harness.core.providers.enabled('lab')).toBe(true);

  // A second registry over the same journal reads the stored choice.
  harness.core.providers.loadSwitches(harness.core.journal.getSetting('provider-switches'));
  expect(harness.core.providers.enabled('lab')).toBe(true);
  expect(harness.core.providers.enabled('opencode-v2')).toBe(false);
});

test('the switch refuses an unknown provider and a value that is not a boolean', async () => {
  const client = await harness.connect();
  await expect(client.call('providers.setEnabled', { providerId: 'nobody', enabled: false })).rejects.toThrow(/unknown provider nobody/);
  await expect(client.call('providers.setEnabled', { providerId: 'echo', enabled: 'no' as unknown as boolean })).rejects.toThrow(/enabled must be true or false/);
});

test('an account whose agent keeps its login in a database reads signed in once a row is there', async () => {
  const profile = { detect: {}, executable: [{ kind: 'path', value: 'boite-no-such-agent' }], isolation: { LAB_HOME: '{isolationDir}' } };
  mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(harness.dataDir, 'providers', 'vault.json'), JSON.stringify({
    id: 'vault', schemaVersion: 1, name: 'Vault', shortName: 'Vault', protocol: 'acp',
    roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
    auth: { kind: 'oauth-cli', sqlite: { file: 'vault/login.db', tables: ['credential'] } },
    models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
  const client = await harness.connect();
  expect((await client.call('providers.reload', {})).rejected).toEqual([]);
  const account = await client.call('accounts.add', { providerId: 'vault', label: 'Vault login' });
  expect(account.status).toBe('unauthenticated');
  if (account.isolationDir === null) throw new Error('the account has no directory of its own');

  mkdirSync(join(account.isolationDir, 'vault'), { recursive: true });
  const db = new Database(join(account.isolationDir, 'vault', 'login.db'));
  db.run('CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT)');
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  db.run("INSERT INTO credential VALUES ('cred_1', '{}')");
  db.close();
  expect((await client.call('accounts.check', { accountId: account.id })).status).toBe('ok');
});

test.skipIf(process.platform === 'win32')('a list waits for the program a candidate asks its version, and answers with the provider it found', async () => {
  // A program that says which major it is, and a descriptor that takes it only at that major.
  const program = join(harness.dataDir, 'gated-agent');
  writeFileSync(program, '#!/bin/sh\necho "gated-agent v2.3.1"\n');
  chmodSync(program, 0o755);
  const profile = (major: number) => ({ detect: {}, executable: [{ kind: 'file', value: program, major }], isolation: { GATED_HOME: '{isolationDir}' } });
  const descriptor = (id: string, major: number) => ({
    id, schemaVersion: 1, name: id, shortName: id, protocol: 'acp', roots: ['{isolationDir}'],
    profiles: { linux: profile(major), macos: profile(major) }, auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  });
  mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(harness.dataDir, 'providers', 'gated-one.json'), JSON.stringify(descriptor('gated-one', 1)));
  writeFileSync(join(harness.dataDir, 'providers', 'gated-two.json'), JSON.stringify(descriptor('gated-two', 2)));

  const client = await harness.connect();
  // The very first answer already knows: the reload ran the program before it answered.
  const { loaded, rejected } = await client.call('providers.reload', {});
  expect(rejected).toEqual([]);
  expect(loaded.find((provider) => provider.id === 'gated-two')).toMatchObject({ available: true, executable: program });
  expect(loaded.find((provider) => provider.id === 'gated-one')).toMatchObject({ available: false, executable: null });
  // The reading is kept beside the data, for the next start.
  const kept = JSON.parse(await Bun.file(join(harness.dataDir, 'executable-versions.json')).text()) as Record<string, { version: string }>;
  expect(kept[program]?.version).toBe('2.3.1');
});
