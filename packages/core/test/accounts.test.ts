import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('accounts', () => {
  test('first start creates one default account per available provider', async () => {
    const client = await harness.connect();
    const accounts = await client.call('accounts.list', {});
    const echo = accounts.find((account) => account.providerId === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.label).toBe('Default');
    expect(echo?.isolationDir).toBeNull();
    expect(echo?.status).toBe('ok');
  });

  test('an isolated account gets its own directory and is unauthenticated until the session file exists', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', {
      providerId: 'claude',
      label: 'Second',
      useDefaultLocation: false,
    });
    expect(account.isolationDir).toBe(join(harness.dataDir, 'accounts', account.id));

    const before = await client.call('accounts.check', { accountId: account.id });
    expect(before.status).toBe('unauthenticated');

    writeFileSync(join(account.isolationDir ?? '', '.credentials.json'), '{"fake":true}', 'utf8');
    const after = await client.call('accounts.check', { accountId: account.id });
    expect(after.status).toBe('ok');
  });

  test('the isolation environment substitutes the account directory', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', {
      providerId: 'claude',
      label: 'Isolated',
      useDefaultLocation: false,
    });
    const provider = harness.core.providers.require('claude');
    const env = harness.core.accounts.accountEnv(
      harness.core.accounts.require(account.id),
      provider,
    );
    expect(env['CLAUDE_CONFIG_DIR']).toBe(account.isolationDir ?? '');

    const shared = harness.core.accounts.accountEnv(
      { ...harness.core.accounts.require(account.id), isolationDir: null },
      provider,
    );
    expect(shared).toEqual({});
  });

  test('accounts.updated reaches a connected client', async () => {
    const client = await harness.connect();
    const seen = client.next('accounts.updated', (account) => account.label === 'Watched');
    await client.call('accounts.add', { providerId: 'echo', label: 'Watched', useDefaultLocation: true });
    expect((await seen).label).toBe('Watched');
  });

  test('removing an account drops it from the list', async () => {
    const client = await harness.connect();
    const account = await client.call('accounts.add', { providerId: 'echo', label: 'Doomed' });
    await client.call('accounts.remove', { accountId: account.id });
    const accounts = await client.call('accounts.list', {});
    expect(accounts.some((entry) => entry.id === account.id)).toBe(false);
  });
});
