/**
 * The one upgrade from agents that ran in a hidden thread to agents that are
 * their thread. Each step checks before it writes, so it runs again safely;
 * a setting records that it finished.
 *
 * - Sessions: an agent keeps the session of its own conversation, without its
 *   old `scope`; the hidden threads of group and mission sessions are archived
 *   and their records go.
 * - Routines: `lastWorkId` becomes `lastTurnId: null`.
 * - The agent thread's old prompts, each the whole run instructions ending in
 *   `Current work: <what was asked>`, display only what was asked; a batch of
 *   notices displays `Project events`. The text sent stays as it was.
 * - Each agent's old scoped memories are written once to
 *   `brain/memories-archive.md`, where its context block points.
 * - Settings only the old runtime read go: the attachments held for a
 *   message's recipients (their bytes are in the agent thread's prompts) and
 *   the continuation notes of its own compaction.
 *
 * Old records of every other kind stay in `agent_entities`, unread.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRoutine, AgentSession, Message } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { MEMORY_ARCHIVE } from './context.ts';
import type { AgentStore } from './store.ts';

const DONE = 'agents:migrated:threads-v1';
const ARCHIVED = 'agents:memories-archived:';
const CURRENT_WORK = '\nCurrent work: ';
const NOTICES = 'Notices from Boite';

type OldSession = AgentSession & { scope?: { kind: string; id: string } };
type OldRoutine = AgentRoutine & { lastWorkId?: string | null };
type OldMemory = { id: string; createdAt: number; scope?: { kind: string; id: string }; title?: string; text?: string };

/** What an old agent prompt displays: what follows its last `Current work: `, or `Project events`. */
export function migratedDisplay(text: string): string | null {
  if (!text.startsWith('You are ') || !text.includes(CURRENT_WORK)) return null;
  const work = text.slice(text.lastIndexOf(CURRENT_WORK) + CURRENT_WORK.length).trim();
  return work.startsWith(NOTICES) ? 'Project events' : work;
}

export function migrateAgents(core: Core, store: AgentStore): void {
  if (core.journal.getSetting(DONE)) return;
  try {
    const threads = migrateSessions(core, store);
    migrateRoutines(store);
    for (const threadId of threads) migratePrompts(core, threadId);
    for (const agent of store.records.list('profile')) archiveMemories(core, store, agent.id);
    core.journal.db.query("DELETE FROM settings WHERE key LIKE 'agents:attachments:%' OR key LIKE 'agents:checkpoint:%'").run();
    core.journal.setSetting(DONE, { at: Date.now() });
  } catch (error) {
    // Left unmarked: the next start tries again. Agents load meanwhile.
    core.log('error', `agents migration: ${messageOf(error)}`);
  }
}

/** Keeps each agent's own session, scope dropped; returns the threads kept. */
function migrateSessions(core: Core, store: AgentStore): string[] {
  const kept: string[] = [];
  for (const session of store.records.list('session') as OldSession[]) {
    const own = session.scope === undefined || (session.scope.kind === 'agent' && session.scope.id === session.agentId);
    if (own && store.records.find('profile', session.agentId)) {
      if (session.scope !== undefined) store.records.update('session', session.id, session.revision, { agentId: session.agentId, threadId: session.threadId });
      if (session.threadId) kept.push(session.threadId);
      continue;
    }
    const thread = core.journal.getThread(session.threadId);
    if (thread && !thread.archived) {
      const now = Date.now();
      core.journal.putThread({ ...thread, archived: true, archivedAt: now, updatedAt: now });
    }
    store.records.remove('session', session.id);
  }
  return kept;
}

function migrateRoutines(store: AgentStore): void {
  for (const routine of store.records.list('routine') as OldRoutine[]) {
    if (!('lastWorkId' in routine)) continue;
    const { lastWorkId: _lastWorkId, ...rest } = routine;
    store.records.update('routine', routine.id, routine.revision, { ...rest, lastTurnId: routine.lastTurnId ?? null, lastOutcome: routine.lastOutcome ?? null });
  }
}

/** Gives the old prompts of one agent thread the text they display. */
function migratePrompts(core: Core, threadId: string): void {
  const rows = core.journal.db.query("SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND parts LIKE '%You are %'").all(threadId) as { id: string }[];
  for (const { id } of rows) {
    const message: Message | null = core.journal.getMessage(id);
    const part = message?.parts[0];
    if (part?.type !== 'text' || part.displayText !== undefined) continue;
    const display = migratedDisplay(part.text);
    if (display === null) continue;
    core.journal.setMessagePart(id, 0, { ...part, displayText: display });
  }
}

/** The agent's old scoped memories, written once beside MEMORY.md. */
function archiveMemories(core: Core, store: AgentStore, agentId: string): void {
  if (core.journal.getSetting(`${ARCHIVED}${agentId}`)) return;
  const memories = (core.journal.db.query("SELECT data FROM agent_entities WHERE kind = 'memory' ORDER BY created_at, rowid").all() as { data: string }[])
    .map(row => JSON.parse(row.data) as OldMemory)
    .filter(memory => memory.scope?.kind === 'agent' && memory.scope.id === agentId);
  if (memories.length) {
    const brain = store.resident.brain(agentId);
    const target = join(brain.path, MEMORY_ARCHIVE);
    if (!existsSync(target)) {
      const body = memories.map(memory => `## ${memory.title ?? 'Note'} (${new Date(memory.createdAt).toISOString().slice(0, 10)})\n\n${(memory.text ?? '').trim()}\n`).join('\n');
      writeFileSync(target, `# Older notes\n\nWhat this agent noted before its memory became MEMORY.md alone. Read it when it matters; nothing here is sent by itself.\n\n${body}`);
    }
  }
  core.journal.setSetting(`${ARCHIVED}${agentId}`, { at: Date.now(), count: memories.length });
}
