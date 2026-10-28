import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ThreadSummary } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

let dir: string;
let journal: Journal | undefined;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boite-journal-cache-')); });
afterEach(() => {
  journal?.close();
  journal = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Bytes this process asked the kernel to read, from any file: Linux's `rchar`. */
function bytesRead(): number {
  return Number(/^rchar: (\d+)$/m.exec(readFileSync('/proc/self/io', 'utf8'))![1]);
}

function thread(id: string, updatedAt: number): ThreadSummary {
  return {
    id, projectId: null, title: `Thread ${id} `.padEnd(1500, '.'), titleSource: 'user', providerId: 'echo', accountId: 'acct_echo', model: null, effort: null,
    cwd: tmpdir(), branch: null, permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null,
    context: null, createdAt: 1, updatedAt, sessionGeneration: 0, selectionVersion: 0,
  } as ThreadSummary;
}

// Under memory pressure the kernel drops the journal's file pages within seconds, so every page the
// core reads from the file can wait on the disk with the event loop stopped. The thread list of a
// journal with a few thousand threads is past SQLite's default 2 MiB cache: each list read it all again.
test.skipIf(process.platform !== 'linux')('listing threads again, after a write, reads nothing from the journal file', () => {
  journal = new Journal(join(dir, 'journal.db'), { checkpoints: { tickMs: 60_000, idleMs: 60_000 } });
  const writer = journal;
  writer.db.transaction(() => { for (let i = 0; i < 4000; i++) writer.putThread(thread(`thr_${i}`, i)); })();
  expect(writer.listThreads()).toHaveLength(4000);
  // The core writes between two lists: its own writes keep the cache.
  writer.putThread(thread('thr_0', 5000));
  const before = bytesRead();
  expect(writer.listThreads()).toHaveLength(4000);
  expect(bytesRead() - before).toBeLessThan(64 * 1024);
});
