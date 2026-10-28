import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadSummary, Turn, Usage } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { SCHEMA_VERSION } from '../src/journal/schema.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boite-usage-buckets-'));
  file = join(dir, 'journal.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const thread = (id: string, providerId: string): ThreadSummary => ({
  id, projectId: null, title: id, titleSource: 'user', providerId, accountId: 'acc', model: null, effort: null, speed: null, cwd: dir, branch: null,
  permissionMode: 'default', status: 'idle', unread: false, archived: false, pinned: false, sessionId: null, sessionGeneration: 0, selectionVersion: 0,
  load: null, context: null, createdAt: 1, updatedAt: 1,
});

const spent = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): Usage => ({ inputTokens, outputTokens: 5, cacheReadTokens, cacheWriteTokens, costUsdEquivalent: null });

function turn(id: string, threadId: string, usage: Usage | null, providerId: string | null): Turn {
  const base: Turn = { id, threadId, status: 'done', queuedAt: 1, startedAt: 2, finishedAt: 3, usage, error: null };
  if (providerId === null) return base;
  return {
    ...base,
    execution: { providerId, accountId: 'acc', model: 'm', effort: null, speed: null, permissionMode: 'default', sessionId: null, sessionGeneration: 0, selectionVersion: 0 },
  };
}

/** A journal as the last core before canonical buckets left it. */
function writeSchema44(): void {
  const journal = new Journal(file);
  try {
    journal.putThread(thread('thr_codex', 'codex'));
    journal.putThread(thread('thr_mine', 'my-codex'));
    // Codex counted both caches inside its input.
    journal.putTurn(turn('turn_codex', 'thr_codex', spent(1000, 800, 50), 'codex'));
    // Saved before execution snapshots: the thread's provider ran it.
    journal.putTurn(turn('turn_legacy', 'thr_codex', spent(100, 40, 0), null));
    // More cache than input, from a request Codex reported oddly.
    journal.putTurn(turn('turn_odd', 'thr_codex', spent(10, 40, 0), 'codex'));
    journal.putTurn(turn('turn_mine', 'thr_mine', spent(500, 300, 0), 'my-codex'));
    // Claude Code wrote its cache for an hour.
    journal.putTurn(turn('turn_claude', 'thr_codex', spent(11, 5, 7), 'claude'));
    journal.putTurn(turn('turn_claude_nowrite', 'thr_codex', spent(11, 5, 0), 'claude'));
    journal.putTurn(turn('turn_acp', 'thr_codex', spent(11, 5, 7), 'opencode'));
    journal.putTurn(turn('turn_none', 'thr_codex', null, 'codex'));
    journal.db.exec('PRAGMA user_version = 44');
  } finally {
    journal.close();
  }
}

const usages = (journal: Journal): Record<string, Usage | null> =>
  Object.fromEntries([...journal.listTurns('thr_codex'), ...journal.listTurns('thr_mine')].map((row) => [row.id, row.usage]));

test('opening a schema 44 journal rewrites stored usage into disjoint buckets once, by the protocol each provider had', () => {
  writeSchema44();
  const protocols: Record<string, string> = { 'my-codex': 'codex-appserver', codex: 'codex-appserver', claude: 'claude-sdk', opencode: 'acp' };
  const asked: string[] = [];
  const usageProtocol = (id: string): string | null => {
    asked.push(id);
    return protocols[id] ?? null;
  };
  for (let pass = 0; pass < 2; pass++) {
    const journal = new Journal(file, { usageProtocol });
    try {
      expect(journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(usages(journal)).toEqual({
        turn_codex: spent(150, 800, 50),
        turn_legacy: spent(60, 40, 0),
        turn_odd: spent(0, 40, 0),
        turn_mine: spent(200, 300, 0),
        turn_claude: { ...spent(11, 5, 7), cacheWriteHourTokens: 7 },
        turn_claude_nowrite: spent(11, 5, 0),
        turn_acp: spent(11, 5, 7),
        turn_none: null,
      });
    } finally {
      journal.close();
    }
  }
  // Each provider is resolved once, and a reopened journal resolves none.
  expect(asked.sort()).toEqual(['claude', 'codex', 'my-codex', 'opencode']);
});

test('without a registry the shipped provider ids keep their protocol', () => {
  writeSchema44();
  const journal = new Journal(file);
  try {
    const stored = usages(journal);
    expect(stored.turn_codex).toEqual(spent(150, 800, 50));
    expect(stored.turn_claude).toEqual({ ...spent(11, 5, 7), cacheWriteHourTokens: 7 });
    // An unknown custom provider is left as it was stored.
    expect(stored.turn_mine).toEqual(spent(500, 300, 0));
  } finally {
    journal.close();
  }
});
