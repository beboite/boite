import { afterEach, describe, expect, test } from 'bun:test';
import type { ThreadListChanges, ThreadSummary } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { newId } from '../src/ids.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { echoThread, removeDir, startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | null = null;
let restarted: TestCore | null = null;

afterEach(async () => {
  await restarted?.stop();
  restarted = null;
  await harness?.stop();
  harness = null;
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** `count` threads beside `template`, written in one transaction as a long-lived journal holds them. */
function seed(core: TestCore['core'], template: ThreadSummary, count: number): void {
  core.journal.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      core.journal.putThread({ ...template, id: newId('thr_'), title: `seeded thread ${index} with a title of ordinary length`, createdAt: template.createdAt + index });
    }
  })();
}

async function seeded(count: number): Promise<{ client: CoreClient; threadId: string; first: Extract<ThreadListChanges, { kind: 'full' }> }> {
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  seed(harness.core, harness.core.threads.require(threadId), count);
  const first = await client.call('threads.listChanges', {});
  if (first.kind !== 'full') throw new Error('a first read must be whole');
  return { client, threadId, first };
}

describe('threads.listChanges', () => {
  test('a reconnect after one change among two thousand reads that thread alone', async () => {
    const { client, threadId, first } = await seeded(2000);
    expect(first.threads).toHaveLength(2001);
    // What `threads.list` sends whole on every reconnect.
    const whole = bytes(await client.call('threads.list', {}));

    await client.call('threads.pin', { threadId, pinned: true });
    const again = await client.call('threads.listChanges', { since: first.cursor });

    expect(again.kind).toBe('changes');
    if (again.kind !== 'changes') return;
    expect(again.threads.map(thread => thread.id)).toEqual([threadId]);
    expect(again.threads[0]!.pinned).toBe(true);
    expect(again.removed).toEqual([]);
    expect(again.cursor.seq).toBeGreaterThan(first.cursor.seq);
    // Measured: one row and a cursor instead of the whole list.
    console.info(`threads.list ${whole} bytes, threads.listChanges after one pin ${bytes(again)} bytes`);
    expect(whole).toBeGreaterThan(500_000);
    expect(bytes(again)).toBeLessThan(4_096);

    // Nothing since: an empty answer.
    const quiet = await client.call('threads.listChanges', { since: again.cursor });
    expect(quiet).toMatchObject({ kind: 'changes', threads: [], removed: [] });
  });

  test('a thread deleted and one archived while away come back as removed', async () => {
    harness = await startTestCore();
    const client = await harness.connect();
    const kept = await echoThread(harness, client, 'kept');
    const archived = await echoThread(harness, client, 'archived');
    const deleted = await echoThread(harness, client, 'deleted');
    const first = await client.call('threads.listChanges', {});

    await client.call('threads.archive', { threadId: archived.threadId, archived: true });
    await client.call('threads.remove', { threadId: deleted.threadId });
    const again = await client.call('threads.listChanges', { since: first.cursor });

    expect(again.kind).toBe('changes');
    if (again.kind !== 'changes') return;
    expect(again.threads.map(thread => thread.id)).not.toContain(kept.threadId);
    expect(again.removed.sort()).toEqual([archived.threadId, deleted.threadId].sort());
  });

  test('a thread with running processes is in every answer, with its load', async () => {
    const { client, threadId, first } = await seeded(3);
    harness!.core.procs.liveThreads = () => [threadId];
    const again = await client.call('threads.listChanges', { since: first.cursor });
    expect(again.kind).toBe('changes');
    expect(again.threads.map(thread => thread.id)).toEqual([threadId]);
  });

  test('a restarted core answers whole', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-core-'));
    try {
      harness = await startTestCore({ dataDir });
      const client = await harness.connect();
      await echoThread(harness, client);
      const first = await client.call('threads.listChanges', {});
      await harness.stop();
      harness = null;
      // The same journal, a new run.
      restarted = await startTestCore({ dataDir });
      const again = await (await restarted.connect()).call('threads.listChanges', { since: first.cursor });
      expect(again.kind).toBe('full');
      expect(again.threads).toHaveLength(1);
      expect(again.cursor.run).not.toBe(first.cursor.run);
      await restarted.stop();
      restarted = null;
    } finally {
      await removeDir(dataDir);
    }
  });

  test('more threads changed than the core remembers: whole', async () => {
    const { client, first } = await seeded(6);
    harness!.core.threads.listLog.log.limit = 3;
    for (const thread of first.threads.slice(0, 5)) await client.call('threads.pin', { threadId: thread.id, pinned: true });
    const again = await client.call('threads.listChanges', { since: first.cursor });
    expect(again.kind).toBe('full');
    expect(again.threads).toHaveLength(7);
    // From the new cursor on, changes again.
    await client.call('threads.pin', { threadId: first.threads[6]!.id, pinned: true });
    const next = await client.call('threads.listChanges', { since: again.cursor });
    expect(next.kind).toBe('changes');
    expect(next.threads.map(thread => thread.id)).toEqual([first.threads[6]!.id]);
  });

  test('a malformed cursor is refused by field', async () => {
    harness = await startTestCore();
    const client = await harness.connect();
    expect(await thrown(client.call('threads.listChanges', { since: { run: 'run_x', seq: -1 } }))).toThrow('threads.listChanges.since.seq');
    expect(await thrown(client.call('threads.listChanges', { since: 'yesterday' as never }))).toThrow('threads.listChanges.since:');
  });

  test('the core announces the feature', async () => {
    harness = await startTestCore();
    expect(harness.core.info().features?.listChanges).toBe(true);
  });
});
