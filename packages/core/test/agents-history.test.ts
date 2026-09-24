import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { AGENT_HISTORY_PAGE } from '@boite/contracts';
import type { AgentHistoryCursor, AgentProfile, AgentRecord, AgentScope, AgentWork } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { CoreClient } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { SCHEMA_VERSION } from '../src/journal.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const HISTORY = AGENT_HISTORY_PAGE * 3 + 7;

async function agentOf(h: TestCore, c: CoreClient, name = 'Historian'): Promise<AgentProfile> {
  const account = (await c.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  return c.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'], accountIntegration: 'provider' } });
}

/** Terminal work with a run carrying large frozen instructions, and a message, per step. Created directly: nothing executes. */
function grow(h: TestCore, agentId: string, scope: AgentScope, count: number): void {
  const r = h.core.workforce.records;
  r.transaction(() => {
    for (let i = 0; i < count; i++) {
      const work = r.create('work', { agentId, scope, taskId: null, taskGeneration: null, messageId: null, episodeId: `episode-${i}`, prompt: `step ${i}`, status: 'done', error: null, runId: null, notBefore: 0 });
      const run = r.create('run', { workId: work.id, agentId, threadId: 'none', turnId: null, execution: { providerId: 'echo', accountId: 'a', model: null, effort: null, permissionMode: 'default' }, profileRevision: 1, context: { memoryIds: [], messageIds: [], resources: [], instructions: 'x'.repeat(20_000) }, status: 'done', startedAt: 1, finishedAt: 2, actualExecution: null });
      r.update('work', work.id, work.revision, { ...work, runId: run.id });
      r.create('message', { scope, senderId: null, text: `message ${i}`, recipientIds: [], replyTo: null, episodeId: `episode-${i}`, sourceRunId: null });
      r.create('memory', { scope, title: `memory ${i}`, text: 'kept', sourceScopes: [scope], sourceRunId: null, expiresAt: null });
    }
  });
}

const cursor = (records: AgentRecord[]): AgentHistoryCursor => records.reduce((min, r) => r.updatedAt < min.updatedAt || r.updatedAt === min.updatedAt && r.id < min.id ? { updatedAt: r.updatedAt, id: r.id } : min, { updatedAt: Number.MAX_SAFE_INTEGER, id: '' });

/** Every record of a kind, walked back from the snapshot one page at a time. */
async function walk(c: CoreClient, kind: 'message' | 'work' | 'memory', held: AgentRecord[], extra: { threadId?: string; scopes?: AgentScope[] } = {}): Promise<string[]> {
  const ids = held.map(r => r.id);
  let before = cursor(held);
  for (let pages = 0; pages < 100; pages++) {
    const page = await c.call('agents.history', { ...extra, kind, before, limit: 40 });
    const records = [...page.messages, ...page.work, ...page.memories];
    expect(records.length).toBeLessThanOrEqual(40);
    ids.push(...records.map(r => r.id));
    if (!page.more) return ids;
    before = cursor(records);
  }
  throw new Error('history never ended');
}

test('the snapshot stays bounded as history grows and pages reach every record once', async () => {
  const h = await startTestCore();
  try {
    const c = await h.connect();
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    const agent = await agentOf(h, c);
    const scope: AgentScope = { kind: 'agent', id: agent.id };
    // One unfinished item older than every finished one: it must stay in every snapshot.
    const open = h.core.workforce.records.create('work', { agentId: agent.id, scope, taskId: null, taskGeneration: null, messageId: null, episodeId: 'open', prompt: 'still waiting', status: 'interrupted', error: 'stopped', runId: null, notBefore: 0 });
    grow(h, agent.id, scope, HISTORY);

    const snapshot = await c.call('agents.snapshot', {});
    expect(snapshot.messages).toHaveLength(AGENT_HISTORY_PAGE);
    expect(snapshot.memories).toHaveLength(AGENT_HISTORY_PAGE);
    expect(snapshot.work).toHaveLength(AGENT_HISTORY_PAGE + 1);
    expect(snapshot.work.some(w => w.id === open.id)).toBe(true);
    expect(snapshot.more).toEqual({ message: true, work: true, memory: true });
    expect(snapshot.runs).toHaveLength(AGENT_HISTORY_PAGE);
    expect(snapshot.runs.every(r => !('instructions' in r.context))).toBe(true);
    // Twenty kilobytes of instructions per run would make this megabytes.
    expect(JSON.stringify(snapshot).length).toBeLessThan(100_000);
    // Snapshot lists are oldest first, like the unbounded ones were.
    expect(snapshot.messages.map(m => m.text).at(-1)).toBe(`message ${HISTORY - 1}`);

    const messages = await walk(c, 'message', snapshot.messages);
    expect(messages).toHaveLength(HISTORY);
    expect(new Set(messages).size).toBe(HISTORY);
    const memories = await walk(c, 'memory', snapshot.memories);
    expect(new Set(memories).size).toBe(HISTORY);
    const finished = snapshot.work.filter(w => w.id !== open.id);
    const work = await walk(c, 'work', finished, { scopes: [scope] });
    expect(new Set([...work, open.id]).size).toBe(HISTORY + 1);

    const page = await c.call('agents.history', { kind: 'work', agentId: agent.id, before: cursor(finished) });
    expect(page.work).toHaveLength(AGENT_HISTORY_PAGE);
    expect(page.runs.map(r => r.workId).sort()).toEqual(page.work.map(w => w.id).sort());
    expect(page.runs.every(r => !('instructions' in r.context))).toBe(true);
    await expect(c.call('agents.history', { kind: 'message', agentId: agent.id })).rejects.toThrow('agentId');
    await expect(c.call('agents.history', { kind: 'work', limit: 1000 })).rejects.toThrow('limit');
  } finally { await h.stop(); }
}, 30000);

test('records changed in the same millisecond page by id without a gap or a repeat', async () => {
  const h = await startTestCore();
  try {
    const c = await h.connect();
    const agent = await agentOf(h, c);
    const scope: AgentScope = { kind: 'agent', id: agent.id };
    grow(h, agent.id, scope, 30);
    // Force every message onto one timestamp: only the id orders them.
    h.core.journal.db.exec("UPDATE agent_entities SET updated_at = 1000, data = json_set(data, '$.updatedAt', 1000) WHERE kind = 'message'");
    const first = await c.call('agents.history', { kind: 'message', limit: 7 });
    const ids = await walk(c, 'message', first.messages);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  } finally { await h.stop(); }
});

test('an agent session pages only its own context and provenance', async () => {
  const h = await startTestCore();
  try {
    const c = await h.connect();
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    const agent = await agentOf(h, c);
    const group = await c.call('agents.group.save', { value: { name: 'Shared', memberIds: [agent.id], mode: 'mentions', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const own: AgentScope = { kind: 'agent', id: agent.id };
    const shared: AgentScope = { kind: 'group', id: group.id };
    grow(h, agent.id, own, AGENT_HISTORY_PAGE + 10);
    grow(h, agent.id, shared, AGENT_HISTORY_PAGE + 10);
    // Personal memory copied from the group keeps its provenance and stays out of the direct context.
    const r = h.core.workforce.records;
    for (let i = 0; i < AGENT_HISTORY_PAGE + 10; i++) r.create('memory', { scope: own, title: `from group ${i}`, text: 'group only', sourceScopes: [shared], sourceRunId: null, expiresAt: null });
    const session = r.create('session', { agentId: agent.id, scope: own, threadId: '' });
    const thread = h.core.threads.createAgentSession(agent, session.id, h.dataDir);
    r.update('session', session.id, session.revision, { ...session, threadId: thread.id });
    const scoped = await connect(h.url, h.core.agents.tokenFor(thread.id));
    try {
      const snapshot = await scoped.call('agents.snapshot', { threadId: thread.id });
      expect(snapshot.messages.every(m => m.scope.kind === 'agent')).toBe(true);
      expect(snapshot.memories).toHaveLength(AGENT_HISTORY_PAGE);
      expect(snapshot.memories.every(m => m.text === 'kept')).toBe(true);
      const memories = await walk(scoped, 'memory', snapshot.memories, { threadId: thread.id });
      expect(memories).toHaveLength(AGENT_HISTORY_PAGE + 10);
      const messages = await walk(scoped, 'message', snapshot.messages, { threadId: thread.id });
      expect(messages).toHaveLength(AGENT_HISTORY_PAGE + 10);
      await expect(scoped.call('agents.history', { threadId: thread.id, kind: 'message', scopes: [shared] })).rejects.toThrow('own context');
      await expect(scoped.call('agents.history', { threadId: thread.id, kind: 'work', agentId: 'someone-else' })).rejects.toThrow('own context');
      await expect(scoped.call('agents.history', { kind: 'message' })).rejects.toThrow('for thread');
      // Asking for the group's memory from the direct context yields nothing, on every page.
      const group = await scoped.call('agents.history', { threadId: thread.id, kind: 'memory', scopes: [shared] });
      expect(group.memories).toEqual([]);
      expect(group.more).toBe(false);
    } finally { scoped.close(); }
  } finally { await h.stop(); }
}, 30000);

test('targeted lookups and pages go through their indexes', async () => {
  const h = await startTestCore();
  try {
    const plan = (sql: string) => (h.core.journal.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map(row => row.detail).join(' | ');
    const lookups: [string, string][] = [
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'session' AND json_extract(data, '$.threadId') IN (?) ORDER BY created_at, rowid", 'agent_session_thread'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'message' AND json_extract(data, '$.sourceRunId') IN (?) ORDER BY created_at, rowid", 'agent_message_source_run'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'work' AND json_extract(data, '$.episodeId') IN (?) ORDER BY created_at, rowid", 'agent_work_episode'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'delivery' AND json_extract(data, '$.workId') IN (?, ?) ORDER BY created_at, rowid", 'agent_delivery_work'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'delivery' AND json_extract(data, '$.messageId') IN (?, ?) ORDER BY created_at, rowid", 'agent_delivery_recipient'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'run' AND json_extract(data, '$.workId') IN (?) ORDER BY created_at, rowid", 'agent_run_work'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'decision' AND json_extract(data, '$.workId') IN (?) ORDER BY created_at, rowid", 'agent_decision_work'],
      ["SELECT id FROM agent_entities INDEXED BY {index} WHERE kind = 'run' AND json_extract(data, '$.threadId') = ? AND json_extract(data, '$.finishedAt') > ? AND json_extract(data, '$.status') = 'done' ORDER BY json_extract(data, '$.finishedAt')", 'agent_run_thread'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'message' AND json_extract(data, '$.scope.kind') = ? AND json_extract(data, '$.scope.id') = ? AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?", 'agent_message_scope'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'work' AND json_extract(data, '$.agentId') = ? AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?", 'agent_work_agent'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'memory' AND json_extract(data, '$.scope.kind') = ? AND json_extract(data, '$.scope.id') = ? ORDER BY updated_at DESC, id DESC LIMIT ?", 'agent_memory_scope'],
      ["SELECT data FROM agent_entities INDEXED BY {index} WHERE kind = 'message' AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?", 'agent_recent'],
      ["SELECT COALESCE(MAX(id), 0) AS revision FROM events WHERE type IN ('agents.record', 'agents.limits')", 'events_agents'],
    ];
    for (const [sql, index] of lookups) {
      const detail = plan(sql.replace('{index}', index));
      expect(detail, sql).toContain(index);
      expect(detail, sql).not.toMatch(/SCAN (agent_entities|events)/);
      // A lookup sorts the few rows it matched; a page must walk its index in order to stop at the limit.
      if (sql.includes('LIMIT')) expect(detail, sql).not.toContain('TEMP B-TREE');
    }
  } finally { await h.stop(); }
});

test('deliver, publishReply and session read one record, not the whole kind', async () => {
  const h = await startTestCore();
  try {
    const c = await h.connect();
    h.core.workforce.setLimits({ ...h.core.workforce.limits(), paused: true });
    const agent = await agentOf(h, c);
    grow(h, agent.id, { kind: 'agent', id: agent.id }, 20);
    const r = h.core.workforce.records;
    const list = r.list.bind(r);
    const listed: string[] = [];
    r.list = (kind => { listed.push(kind); return list(kind); }) as typeof r.list;
    await c.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [], text: 'hello', requestId: 'targeted_001' });
    const work = r.withStatus('work', ['pending'])[0] as AgentWork;
    h.core.workforce.publishReply(work, 'run-without-reply', 'result');
    expect(() => h.core.workforce.session('missing-thread')).toThrow('persistent agent session');
    expect(listed.filter(kind => ['work', 'message', 'session', 'delivery', 'run'].includes(kind))).toEqual([]);
  } finally { await h.stop(); }
});

test('a schema 15 journal gains the history indexes and keeps its records', async () => {
  const h = await startTestCore();
  const c = await h.connect();
  const agent = await agentOf(h, c);
  grow(h, agent.id, { kind: 'agent', id: agent.id }, 3);
  await h.server.stop(); await h.core.close();
  const db = new Database(join(h.dataDir, 'journal.db'));
  const indexes = ['agent_recent', 'agent_session_thread', 'agent_message_source_run', 'agent_message_scope', 'agent_work_episode', 'agent_work_scope', 'agent_work_agent', 'agent_memory_scope', 'agent_delivery_work', 'agent_run_work', 'agent_run_thread', 'agent_decision_work', 'events_agents'];
  db.exec(`${indexes.map(name => `DROP INDEX ${name};`).join(' ')} PRAGMA user_version = 15;`);
  db.close();
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const present = (next.journal.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(row => row.name);
    for (const name of indexes) expect(present).toContain(name);
    expect(next.journal.db.query('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(next.workforce.snapshot().messages).toHaveLength(3);
  } finally { await next.close(); }
});
