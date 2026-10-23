import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ThreadSummary } from '@boite/contracts';
import { MEMORY_ARCHIVE } from '../src/agents/context.ts';
import { migratedDisplay } from '../src/agents/migration.ts';
import { echoAccount } from './agent-fixture.ts';
import { echoThread, removeDir, startTestCore, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); });

const AGENT = 'agt_profile_oldagent0000000000';
const BOTS = 'agt_profile_oldbots00000000000';
/** A run's frozen instructions, as the old runtime sent them as the prompt of each turn. */
const instructions = (work: string) => `You are Old. Domain: Releases.\n\nShip things.\n\nYour persistent brain is at /x.\n\nConversation (JSON): []\n\nCurrent work: ${work}`;

function row(h: TestCore, kind: string, id: string, data: Record<string, unknown>): void {
  h.core.journal.db.query('INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES (?, ?, 1, ?, ?, ?)')
    .run(kind, id, 1_700_000_000_000, 1_700_000_000_000, JSON.stringify({ id, revision: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...data }));
}

/** A data directory shaped like a core of the hidden-thread agents left it. */
async function oldCore(): Promise<{ dataDir: string; own: string; group: string; prompts: Message[] }> {
  const h = await startTestCore();
  const client = await h.connect();
  const accountId = echoAccount(h);
  const { threadId } = await echoThread(h, client);
  const base = h.core.journal.getThread(threadId)!;
  const thread = (id: string, sessionId: string): ThreadSummary => ({ ...base, id, projectId: null, agentSessionId: sessionId, title: 'Old', status: 'idle' });
  h.core.journal.putThread(thread('thr_oldown', 'agt_session_own0000000000000'));
  h.core.journal.putThread(thread('thr_oldgroup', 'agt_session_group00000000000'));
  const selection = { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' };
  row(h, 'profile', AGENT, { name: 'Old', domain: 'Releases', instructions: 'Ship things.', avatar: '', status: 'active', tools: ['messages', 'memory'], selection });
  row(h, 'profile', BOTS, { name: 'B.O.T.S', domain: '', instructions: '', avatar: '', status: 'active', tools: [], selection: { ...selection, providerId: 'antigravity-cli' } });
  row(h, 'session', 'agt_session_own0000000000000', { agentId: AGENT, scope: { kind: 'agent', id: AGENT }, threadId: 'thr_oldown' });
  row(h, 'session', 'agt_session_group00000000000', { agentId: AGENT, scope: { kind: 'group', id: 'agt_group_x' }, threadId: 'thr_oldgroup' });
  row(h, 'routine', 'agt_routine_old0000000000000', { agentId: AGENT, name: 'Morning', prompt: 'Read the news', schedule: { kind: 'interval', everyMinutes: 60 }, enabled: true, nextAt: Date.now() + 3_600_000, lastWorkId: 'agt_work_old', lastScheduledAt: 1_700_000_000_000 });
  row(h, 'memory', 'agt_memory_own', { scope: { kind: 'agent', id: AGENT }, title: 'Prefers short answers', text: 'The user wants one line.', sourceScopes: [], sourceRunId: null, expiresAt: null });
  row(h, 'memory', 'agt_memory_group', { scope: { kind: 'group', id: 'agt_group_x' }, title: 'Group finding', text: 'Not this agent\'s own.', sourceScopes: [], sourceRunId: null, expiresAt: null });
  row(h, 'work', 'agt_work_old', { agentId: AGENT, scope: { kind: 'agent', id: AGENT }, prompt: 'Read the news', status: 'done' });
  row(h, 'message', 'agt_message_old', { scope: { kind: 'agent', id: AGENT }, senderId: null, text: 'Hello', recipientIds: [AGENT] });
  const prompts: Message[] = ['Ship the release notes', 'Notices from Boite about threads of the projects entrusted to you.\n\nNotices:\n- [turn:x] done', 'not an old prompt'].map((work, at) => ({
    id: `msg_old${at}`, threadId: 'thr_oldown', turnId: `trn_old${at}`, role: 'user', state: 'complete', createdAt: 1_700_000_000_000 + at,
    parts: [{ type: 'text', text: at === 2 ? work : instructions(work) }],
  }));
  for (const message of prompts) h.core.journal.putMessage(message);
  h.core.journal.setSetting('agents:attachments:agt_message_old', { attachments: [{ kind: 'image', data: 'x'.repeat(1000) }], given: [] });
  h.core.journal.setSetting('agents:checkpoint:agt_session_own0000000000000', { text: 'A continuation note', at: 1 });
  // As if this core had never run the migration.
  h.core.journal.db.query("DELETE FROM settings WHERE key LIKE 'agents:migrated:%' OR key LIKE 'agents:memories-archived:%'").run();
  const dataDir = h.dataDir;
  await h.server.stop(); await h.core.close();
  return { dataDir, own: 'thr_oldown', group: 'thr_oldgroup', prompts };
}

test('an old prompt displays what was asked; a batch of notices displays Project events', () => {
  expect(migratedDisplay(instructions('Ship it'))).toBe('Ship it');
  expect(migratedDisplay(instructions('Notices from Boite about threads.\nNotices:\n- x'))).toBe('Project events');
  expect(migratedDisplay('You are here.')).toBeNull();
  expect(migratedDisplay('Hello\nCurrent work: x')).toBeNull();
});

test('agents of a hidden-thread core come back as their threads, once, whatever the restarts', async () => {
  const old = await oldCore();
  try {
    for (const round of [1, 2]) {
      const h = await startTestCore({ dataDir: old.dataDir }); cores.push(h);
      const records = h.core.workforce.records;
      // The agent keeps the session of its own conversation, without its scope; the group's goes and its thread is archived.
      expect(records.list('session')).toEqual([expect.objectContaining({ id: 'agt_session_own0000000000000', agentId: AGENT, threadId: old.own })]);
      expect('scope' in records.list('session')[0]!).toBe(false);
      expect(h.core.journal.getThread(old.group)!.archived).toBe(true);
      expect(h.core.workforce.agentOfThread(old.own)?.id).toBe(AGENT);
      // A routine's last work becomes no known turn.
      const routine = records.get('routine', 'agt_routine_old0000000000000');
      expect(routine).toMatchObject({ lastTurnId: null, lastOutcome: null, lastScheduledAt: 1_700_000_000_000 });
      expect('lastWorkId' in routine).toBe(false);
      // The prompts display what was asked; the text sent stays.
      const parts = old.prompts.map(m => h.core.journal.getMessage(m.id)!.parts[0]!);
      expect(parts.map(p => p.type === 'text' ? p.displayText : null)).toEqual(['Ship the release notes', 'Project events', undefined]);
      expect(parts[0]!.type === 'text' && parts[0]!.text).toBe(instructions('Ship the release notes'));
      // The agent's own scoped memories are archived beside MEMORY.md, never injected.
      const brain = h.core.workforce.resident.brain(AGENT);
      const archive = readFileSync(join(brain.path, MEMORY_ARCHIVE), 'utf8');
      expect(archive).toContain('## Prefers short answers (2023-11-14)\n\nThe user wants one line.');
      expect(archive).not.toContain('Group finding');
      expect(brain.memory).toBe('');
      expect(existsSync(join(h.core.workforce.resident.brain(BOTS).path, MEMORY_ARCHIVE))).toBe(false);
      expect(h.core.journal.getSetting('agents:attachments:agt_message_old')).toBeUndefined();
      expect(h.core.journal.getSetting('agents:checkpoint:agt_session_own0000000000000')).toBeUndefined();
      // Old records of removed kinds stay where they were, unread.
      expect(h.core.journal.db.query("SELECT kind FROM agent_entities WHERE kind IN ('work', 'message', 'memory') ORDER BY kind, id").all().map(r => (r as { kind: string }).kind)).toEqual(['memory', 'memory', 'message', 'work']);
      // A profile on a provider this core no longer has loads, and says why it cannot run.
      const snapshot = h.core.workforce.snapshot();
      expect(snapshot.profiles.map(p => p.id).sort()).toEqual([AGENT, BOTS].sort());
      expect(snapshot.status.find(s => s.agentId === BOTS)).toMatchObject({ state: 'error', threadId: null, problem: expect.stringContaining('antigravity-cli') });
      expect(snapshot.status.find(s => s.agentId === AGENT)).toMatchObject({ threadId: old.own, problem: null });
      if (round === 1) expect(h.core.journal.getSetting('agents:migrated:threads-v1')).toBeTruthy();
      await h.stop();
      cores.splice(cores.indexOf(h), 1);
    }
  } finally { await removeDir(old.dataDir); }
});
