import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { Account } from '@boite/contracts';
import type { Core } from '../src/core.ts';
import { readExtraQuota } from '../src/quota-readers.ts';

const live = process.env['BOITE_E2E_GROK_QUOTA'] === '1' ? test : test.skip;

// Opt-in: reads billing on the default CLI login and may renew it. No model call.
live('Grok reads subscription credits on the default CLI login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boite-grok-quota-live-'));
  process.env.BOITE_DATA_DIR = directory;
  try {
    const core = { accounts: { accountEnv: () => ({}) }, providers: { require: () => ({}) } } as unknown as Core;
    const account = { providerId: 'grok', isolationDir: null } as Account;
    const windows = await readExtraQuota(core, account);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]?.id).toBe('credits');
    expect(windows[0]?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(windows[0]?.usedPercent).toBeLessThanOrEqual(100);
  } finally {
    delete process.env.BOITE_DATA_DIR;
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
