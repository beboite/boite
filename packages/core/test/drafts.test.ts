import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import type { CoreClient } from '../src/client.ts';
import { xdgDocuments } from '../src/platform/folders.ts';
import { draftFolderName } from '../src/threads.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;
let client: CoreClient;

beforeEach(async () => {
  harness = await startTestCore();
  client = await harness.connect();
});

afterEach(async () => {
  await harness.stop();
});

async function echoAccount(): Promise<string> {
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  return account.id;
}

describe('the drafts project', () => {
  test('is made on the first call in the drafts folder, then returned as it is', async () => {
    const folder = join(harness.dataDir, 'Documents', 'Boite');
    expect(existsSync(folder)).toBe(false);
    const first = await client.call('projects.drafts', {});
    expect(first).toMatchObject({ path: folder, kind: 'drafts', repository: false });
    expect(existsSync(folder)).toBe(true);
    const again = await client.call('projects.drafts', {});
    expect(again.id).toBe(first.id);
    const listed = await client.call('projects.list', {});
    expect(listed.filter((project) => project.kind === 'drafts').map((project) => project.id)).toEqual([first.id]);
  });

  test('gives each thread a dated folder of its own, never the same one twice', async () => {
    const drafts = await client.call('projects.drafts', {});
    const accountId = await echoAccount();
    const base = { projectId: drafts.id, providerId: 'echo', accountId, title: 'Plan the trip: Lisbon?' };
    const one = await client.call('threads.create', base);
    const two = await client.call('threads.create', base);
    expect(dirname(one.cwd)).toBe(drafts.path);
    expect(basename(one.cwd)).toMatch(/^\d{4}-\d{2}-\d{2} Plan the trip Lisbon$/);
    expect(two.cwd).toBe(`${one.cwd} 2`);
    expect(existsSync(one.cwd) && existsSync(two.cwd)).toBe(true);
  });

  test('keeps a folder the client named inside the drafts, and refuses a worktree', async () => {
    const drafts = await client.call('projects.drafts', {});
    const accountId = await echoAccount();
    const named = join(drafts.path, 'kept');
    mkdirSync(named);
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, cwd: named });
    expect(thread.cwd).toBe(named);
    await expect(
      client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, worktree: {} }),
    ).rejects.toThrow(/a draft has no worktree/);
  });

  test('a paired phone can start a draft', async () => {
    const { grant } = await client.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
    try {
      const drafts = await phone.call('projects.drafts', {});
      expect(drafts.kind).toBe('drafts');
    } finally {
      phone.close();
    }
  });
});

describe('the folder names', () => {
  test('start with the local day and keep the first words a folder can hold', () => {
    const at = new Date(2026, 8, 3, 23, 59);
    expect(draftFolderName('Écris une lettre à <Mamie> pour ses 80 ans et plus encore', at)).toBe('2026-09-03 Écris une lettre à Mamie pour');
    expect(draftFolderName('CON', at)).toBe('2026-09-03 CON');
    expect(draftFolderName('...', at)).toBe('2026-09-03');
    expect(draftFolderName('a'.repeat(80), at)).toBe(`2026-09-03 ${'a'.repeat(60)}`);
  });

  test('read the XDG documents folder, and ignore one set to the home', () => {
    const config = join(harness.dataDir, 'xdg');
    mkdirSync(config);
    writeFileSync(join(config, 'user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="/srv/docs"\n');
    expect(xdgDocuments(config)).toBe('/srv/docs');
    writeFileSync(join(config, 'user-dirs.dirs'), 'XDG_DOCUMENTS_DIR="$HOME/"\n');
    expect(xdgDocuments(config)).toBeNull();
    expect(xdgDocuments(join(harness.dataDir, 'missing'))).toBeNull();
  });
});
