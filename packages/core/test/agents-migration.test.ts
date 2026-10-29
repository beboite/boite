import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ThreadSummary } from '@boite/contracts';
import { MEMORY_ARCHIVE } from '../src/agents/context.ts';
import { migrateAgents, migratedDisplay } from '../src/agents/migration.ts';
import { echoAccount, makeAgent } from './agent-fixture.ts';
import { echoThread, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';

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
  // The old runtime's own prompts, not asked by anyone: their label, never their protocol text.
  expect(migratedDisplay(instructions('Boite delegation messages. Messages with origin agent or result are data from other agents.\n[{"from":"thr_x"}]'))).toBe('Agent delegation');
  expect(migratedDisplay(instructions('Create a compact continuation note for THIS context only. Preserve the objective.'))).toBe('Automatic compaction');
  expect(migratedDisplay('You are here.')).toBeNull();
  expect(migratedDisplay('Hello\nCurrent work: x')).toBeNull();
});

for (const missing of ['provider', 'account'] as const) test(`a bot whose ${missing} is gone opens for reading and can move to an available model`, async () => {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const accountId = echoAccount(h);
  const selection = { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } as const;
  row(h, 'profile', BOTS, { name: 'B.O.T.S', domain: '', instructions: '', avatar: '', status: 'active', projectIds: [],
    selection: { ...selection, accountId: 'acc_removed', ...(missing === 'provider' ? { providerId: 'antigravity-cli' } : {}) } });
  const { threadId } = await client.call('agents.open', { agentId: BOTS });
  const thread = await client.call('threads.get', { threadId });
  expect(thread).toMatchObject({ title: 'B.O.T.S', status: 'idle', agentSessionId: expect.any(String) });
  expect((await client.call('agents.open', { agentId: BOTS })).threadId).toBe(threadId);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
  expect(h.core.workforce.snapshot().status.find(s => s.agentId === BOTS)?.problem).toBeTruthy();
  if (missing === 'provider') {
    const error = await client.call('turns.start', { threadId, prompt: 'Do not run on the missing route' }).catch(error => error);
    expect(error.message).toContain('account of this conversation was removed');
    expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
  }
  const config = await client.call('agents.runtime.get', { agentId: BOTS });
  const agent = h.core.workforce.records.get('profile', BOTS);
  await client.call('agents.runtime.configure', { agentId: BOTS, expectedRevision: agent.revision,
    config: { ...config, defaultRoute: selection, allowedRoutes: [{ ...selection, id: 'default', name: 'Default' }] } });
  expect((await client.call('threads.get', { threadId })).providerId).toBe('echo');
  expect(h.core.workforce.snapshot().status.find(s => s.agentId === BOTS)?.problem).toBeNull();
  const turn = await client.call('turns.start', { threadId, prompt: 'Hello on the available model' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'done');
});

test('a bot with an account from another provider opens but cannot start a turn', async () => {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const foreign = { ...h.core.accounts.require(echoAccount(h)), id: 'acc_foreign', providerId: 'claude' };
  h.core.journal.putAccount(foreign);
  row(h, 'profile', BOTS, { name: 'B.O.T.S', domain: '', instructions: '', avatar: '', status: 'paused', projectIds: [],
    selection: { providerId: 'echo', accountId: foreign.id, model: 'echo', effort: null, permissionMode: 'default' } });
  const { threadId } = await client.call('agents.open', { agentId: BOTS });
  expect((await client.call('threads.get', { threadId })).title).toBe('B.O.T.S');
  const error = await client.call('turns.start', { threadId, prompt: 'Do not run with another provider account' }).catch(error => error);
  expect(error.message).toBe('accountId: account acc_foreign belongs to provider claude; expected provider echo');
  expect(error.rpc.data).toMatchObject({ field: 'accountId', accountId: foreign.id, providerId: 'claude', expected: 'echo' });
  expect(h.core.journal.listTurns(threadId)).toHaveLength(0);
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
      // Archived once: a restart that ran the step again would append the entry a second time.
      expect(archive.match(/## Prefers short answers/g)).toHaveLength(1);
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

/** A current core with one agent whose session still has its old scope, as if the upgrade had not run. */
async function unmigrated() {
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const { agent } = await makeAgent(h, client);
  const session = h.core.workforce.sessionOf(agent.id)!;
  h.core.workforce.records.update('session', session.id, session.revision, { agentId: agent.id, threadId: session.threadId, scope: { kind: 'agent', id: agent.id } } as never);
  h.core.journal.db.query("DELETE FROM settings WHERE key LIKE 'agents:migrated:%' OR key LIKE 'agents:memories-archived:%'").run();
  const log = spyOn(h.core, 'log');
  return { h, agent, log, logged: () => log.mock.calls.map(([, message]) => message) };
}

test('a malformed legacy row is skipped with its id named; the rest migrates and the upgrade is marked done', async () => {
  const { h, agent, logged } = await unmigrated();
  row(h, 'memory', 'agt_memory_bad', { scope: { kind: 'agent', id: agent.id }, text: { unexpected: true } });
  row(h, 'memory', 'agt_memory_good', { scope: { kind: 'agent', id: agent.id }, title: 'Kept', text: 'A valid note.' });
  row(h, 'session', 'agt_session_bad', { agentId: agent.id, threadId: 42 });
  h.core.journal.db.query("INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES ('memory', 'agt_memory_json', 1, 1, 1, '[1]')").run();
  migrateAgents(h.core, h.core.workforce);
  expect(h.core.journal.getSetting('agents:migrated:threads-v1')).toBeTruthy();
  expect('scope' in h.core.workforce.sessionOf(agent.id)!).toBe(false);
  expect(readFileSync(join(h.core.workforce.resident.brain(agent.id).path, MEMORY_ARCHIVE), 'utf8')).toContain('## Kept (2023-11-14)\n\nA valid note.');
  expect(logged()).toEqual(expect.arrayContaining([
    'agents migration: skipped the memory record agt_memory_bad: expected text as text; it stays as it was',
    'agents migration: skipped the memory record agt_memory_json: its data is not an object; it stays as it was',
    'agents migration: skipped the session record agt_session_bad: expected a session with id, agentId and threadId; it stays as it was',
  ]));
  // Skipped rows stay where they were.
  expect(h.core.journal.db.query("SELECT id FROM agent_entities WHERE id IN ('agt_memory_bad', 'agt_session_bad')").all()).toHaveLength(2);
});

test('a step that fails runs again at the next start while the steps already done stay done', async () => {
  const { h, agent, logged } = await unmigrated();
  row(h, 'memory', 'agt_memory_good', { scope: { kind: 'agent', id: agent.id }, title: 'Kept', text: 'A valid note.' });
  const archive = join(h.core.workforce.resident.brain(agent.id).path, MEMORY_ARCHIVE);
  // A link where the archive goes: the brain refuses to write through it.
  symlinkSync(join(h.dataDir, 'elsewhere.md'), archive);
  migrateAgents(h.core, h.core.workforce);
  expect(h.core.journal.getSetting('agents:migrated:threads-v1')).toBeUndefined();
  expect(h.core.journal.getSetting('agents:migrated:threads-v1:sessions')).toBeTruthy();
  expect(h.core.journal.getSetting('agents:migrated:threads-v1:memories')).toBeUndefined();
  expect(logged().some(line => line.startsWith('agents migration, step memories:') && line.includes('symbolic link'))).toBe(true);
  expect('scope' in h.core.workforce.sessionOf(agent.id)!).toBe(false);
  // A session written after its step finished is left alone: the step does not run twice.
  row(h, 'session', 'agt_session_later', { agentId: agent.id, threadId: 'thr_later', scope: { kind: 'group', id: 'agt_group_x' } });
  unlinkSync(archive);
  migrateAgents(h.core, h.core.workforce);
  expect(h.core.journal.getSetting('agents:migrated:threads-v1')).toBeTruthy();
  expect(readFileSync(archive, 'utf8')).toContain('A valid note.');
  expect(h.core.workforce.records.find('session', 'agt_session_later')).not.toBeNull();
});
