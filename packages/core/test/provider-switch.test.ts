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
  // A second seat with a directory of its own, the kind a sign-in is run for.
  const seat = await client.call('accounts.add', { providerId: 'echo', label: 'Another seat' });
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
  // Its sign-in starts the provider's program too, in a pipe or in a terminal: both are refused.
  await expect(client.call('accounts.login', { accountId: seat.id })).rejects.toThrow(/Echo is turned off on this machine/);
  await expect(client.call('accounts.loginTerminal', { accountId: seat.id, cols: 80, rows: 24 })).rejects.toThrow(/Echo is turned off on this machine/);

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

test.skipIf(process.platform === 'win32')('a provider that is off is listed without running its program, which is asked the moment it is turned on', async () => {
  // The program leaves a mark each time it runs.
  const program = join(harness.dataDir, 'quiet-agent');
  const mark = join(harness.dataDir, 'quiet-agent.ran');
  writeFileSync(program, `#!/bin/sh\necho ran >> "${mark}"\necho "quiet-agent 2.0.0"\n`);
  chmodSync(program, 0o755);
  const profile = { detect: {}, executable: [{ kind: 'file', value: program, major: 2 }], isolation: { QUIET_HOME: '{isolationDir}' } };
  mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(harness.dataDir, 'providers', 'quiet.json'), JSON.stringify({
    id: 'quiet', schemaVersion: 1, name: 'Quiet', shortName: 'Quiet', protocol: 'acp', experimental: true, roots: ['{isolationDir}'],
    profiles: { linux: profile, macos: profile }, auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
  const client = await harness.connect();
  const listed = await client.call('providers.reload', {});
  // Experimental, so off: whether it is installed is not known, and nothing was started to find out.
  expect(listed.loaded.find((provider) => provider.id === 'quiet')).toMatchObject({ enabled: false, available: false, executable: null });
  await client.call('providers.list', {});
  expect(await Bun.file(mark).exists()).toBe(false);

  // Turned on, the answer already says it is there.
  const on = await client.call('providers.setEnabled', { providerId: 'quiet', enabled: true });
  expect(on.loaded.find((provider) => provider.id === 'quiet')).toMatchObject({ enabled: true, available: true, executable: program });
  expect((await Bun.file(mark).text()).trim()).toBe('ran');
});

test.skipIf(process.platform === 'win32')('a program stopped at its version deadline is passed over and asked again, never kept as having no version', async () => {
  // It hangs where it should print its version.
  const program = join(harness.dataDir, 'slow-agent');
  writeFileSync(program, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(program, 0o755);
  const profile = { detect: {}, executable: [{ kind: 'file', value: program, major: 2 }], isolation: { SLOW_HOME: '{isolationDir}' } };
  mkdirSync(join(harness.dataDir, 'providers'), { recursive: true });
  writeFileSync(join(harness.dataDir, 'providers', 'slow.json'), JSON.stringify({
    id: 'slow', schemaVersion: 1, name: 'Slow', shortName: 'Slow', protocol: 'acp', roots: ['{isolationDir}'],
    profiles: { linux: profile, macos: profile }, auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Default', default: true }],
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: false, planMode: false, resume: true },
  }));
  harness.core.providers.versionTimeoutMs = 300;
  const client = await harness.connect();
  const stuck = await client.call('providers.reload', {});
  expect(stuck.loaded.find((provider) => provider.id === 'slow')).toMatchObject({ available: false, executable: null });
  // Nothing was written down for it: "no version" would hide the program until the core restarts.
  const kept = join(harness.dataDir, 'executable-versions.json');
  const readings = (await Bun.file(kept).exists()) ? JSON.parse(await Bun.file(kept).text()) as Record<string, unknown> : {};
  expect(readings[program]).toBeUndefined();

  // Repaired, it is another file: asked at once, not a minute later.
  writeFileSync(program, '#!/bin/sh\necho "slow-agent 2.1.0"\n');
  const fixed = await client.call('providers.reload', {});
  expect(fixed.loaded.find((provider) => provider.id === 'slow')).toMatchObject({ available: true, executable: program });
});
