import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '../src/client.ts';
import type { CoreClient } from '../src/client.ts';
import { xdgDocuments } from '../src/platform/folders.ts';
import { draftFolderName } from '../src/threads/inputs.ts';
import { Journal } from '../src/journal.ts';
import { startTestCore, testProject, waitFor } from './harness.ts';
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

  test.skipIf(process.platform !== 'win32')('stays the drafts when its folder was registered earlier in another case', async () => {
    const folder = join(harness.dataDir, 'Documents', 'Boite');
    mkdirSync(folder, { recursive: true });
    const manual = await client.call('projects.add', { path: folder.toLowerCase(), name: 'Mine' });
    const drafts = await client.call('projects.drafts', {});
    expect(drafts.id).toBe(manual.id);
    expect(drafts.kind).toBe('drafts');
    const listed = await client.call('projects.list', {});
    expect(listed.filter((project) => project.kind === 'drafts').map((project) => project.id)).toEqual([manual.id]);
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, title: 'Case' });
    expect(basename(thread.cwd)).toMatch(/^\d{4}-\d{2}-\d{2} Case$/);
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
      // It could never erase an incognito one: `threads.remove` is the owner's.
      const accountId = await echoAccount();
      expect(await refusal(phone.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true })))
        .toMatch(/incognito conversation is the owner's/);
    } finally {
      phone.close();
    }
  });
});

/** The message a refused call answers with; a call that succeeds fails the test. */
async function refusal(call: Promise<unknown>): Promise<string> {
  return call.then(() => { throw new Error('the call was expected to be refused'); }, (error: Error) => error.message);
}

describe('an incognito draft', () => {
  test('works in a folder of the data directory and is refused anywhere but the drafts', async () => {
    const drafts = await client.call('projects.drafts', {});
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, title: 'Secret', incognito: true });
    expect(thread.incognito).toBe(true);
    expect(thread.cwd).toBe(join(harness.dataDir, 'incognito', thread.id));
    expect(existsSync(thread.cwd)).toBe(true);
    // Nothing lands in the drafts folder the user browses.
    expect(readdirSync(drafts.path)).toEqual([]);
    expect((await client.call('threads.list', {})).find((row) => row.id === thread.id)?.incognito).toBe(true);

    const project = await testProject(harness, client);
    expect(await refusal(client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, incognito: true }))).toMatch(/drafts project only/);
    expect(await refusal(client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true, cwd: drafts.path }))).toMatch(/incognito and cwd exclude each other/);
    expect(await refusal(client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true, worktree: {} }))).toMatch(/incognito and worktree exclude each other/);
    expect(await refusal(client.call('threads.move', { threadId: thread.id, projectId: project.id }))).toMatch(/incognito conversation cannot be moved/);
  });

  test('is erased with its folder when removed, with nothing to restore', async () => {
    const drafts = await client.call('projects.drafts', {});
    const accountId = await echoAccount();
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true });
    writeFileSync(join(thread.cwd, 'notes.txt'), 'private');
    await client.call('turns.start', { threadId: thread.id, prompt: 'hello' });
    await waitFor(() => harness.core.journal.getThread(thread.id)?.status === 'idle' && harness.core.journal.listMessages(thread.id).length >= 2);
    const [message] = harness.core.journal.listMessages(thread.id);
    expect(await refusal(client.call('threads.fork', { threadId: thread.id, messageId: message!.id }))).toMatch(/incognito conversation cannot be forked/);

    const removed: { threadId: string; undoable?: boolean }[] = [];
    client.on('thread.removed', (event) => removed.push(event));
    await client.call('threads.remove', { threadId: thread.id });
    await waitFor(() => removed.length === 1);
    expect(removed).toEqual([{ threadId: thread.id, undoable: false }]);
    expect(harness.core.journal.getThread(thread.id)).toBeNull();
    expect(harness.core.journal.listMessages(thread.id)).toEqual([]);
    expect(existsSync(thread.cwd)).toBe(false);
    expect(await client.call('threads.deleted', {})).toEqual([]);
  });

  test('does not survive a core that stopped without leaving it', async () => {
    const drafts = await client.call('projects.drafts', {});
    const accountId = await echoAccount();
    const kept = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, title: 'Kept' });
    const thread = await client.call('threads.create', { projectId: drafts.id, providerId: 'echo', accountId, incognito: true });
    // The next core opens the same journal, as after a crash: its start erases the conversation.
    const next = new Journal(join(harness.dataDir, 'journal.db'));
    try {
      expect(next.getThread(thread.id)).toBeNull();
      expect(next.getThread(kept.id)?.title).toBe('Kept');
    } finally {
      next.close();
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
