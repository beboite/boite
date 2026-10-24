/**
 * The one upgrade from agents that ran in a hidden thread to agents that are
 * their thread. Each step checks before it writes, so it runs again safely;
 * a setting records each step that finished, and one more the whole upgrade.
 * A legacy record that does not have the shape it should is skipped with a
 * log line naming it and stays where it is: one bad row never stops the
 * others. A step that fails otherwise (a file it cannot write) runs again at
 * the next start, the steps already done stay done.
 *
 * - Sessions: an agent keeps the session of its own conversation, without its
 *   old `scope`; the hidden threads of group and mission sessions are archived
 *   and their records go.
 * - Routines: `lastWorkId` becomes `lastTurnId: null`.
 * - The agent thread's old prompts, each the whole run instructions ending in
 *   `Current work: <what was asked>`, display only what was asked; a batch of
 *   notices displays `Project events`, the runtime's own delegation mail and
 *   compaction the labels such turns show now. The text sent stays as it was.
 * - Each agent's old scoped memories are written once to
 *   `brain/memories-archive.md`, where its context block points.
 * - Settings only the old runtime read go: the attachments held for a
 *   message's recipients (their bytes are in the agent thread's prompts) and
 *   the continuation notes of its own compaction.
 *
 * Old records of every other kind stay in `agent_entities`, unread.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRoutine, AgentSession, Message } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { AUTO_COMPACT_LABEL } from '../threads/auto-compact.ts';
import { SYSTEM_LABEL } from '../threads/operations.ts';
import { createBrainFile } from './brain-files.ts';
import { MEMORY_ARCHIVE } from './context.ts';
import type { AgentStore } from './store.ts';

const DONE = 'agents:migrated:threads-v1';
const ARCHIVED = 'agents:memories-archived:';
const CURRENT_WORK = '\nCurrent work: ';
/** The old runtime's own work, asked by no one: what it starts with, and the label it displays. */
const MACHINE_WORK: readonly [string, string][] = [
  ['Notices from Boite', 'Project events'],
  ['Boite delegation messages.', SYSTEM_LABEL.delegation],
  ['Create a compact continuation note for THIS context only.', AUTO_COMPACT_LABEL],
];

type OldSession = AgentSession & { scope?: { kind: string; id: string } };
type OldRoutine = AgentRoutine & { lastWorkId?: string | null };
type OldMemory = { id: string; createdAt: number; scope?: { kind: string; id: string }; title?: string; text?: string };

/** What an old agent prompt displays: what follows its last `Current work: `, or the label of the runtime's own work. */
export function migratedDisplay(text: string): string | null {
  if (!text.startsWith('You are ') || !text.includes(CURRENT_WORK)) return null;
  const work = text.slice(text.lastIndexOf(CURRENT_WORK) + CURRENT_WORK.length).trim();
  return MACHINE_WORK.find(([start]) => work.startsWith(start))?.[1] ?? work;
}

/** The steps in order; each one's setting is `${DONE}:<name>`. */
const STEPS = ['sessions', 'routines', 'prompts', 'memories', 'settings'] as const;

/** A legacy record that is not what it should be: skipped, never fatal. */
class Malformed extends Error {}

const isText = (value: unknown): value is string => typeof value === 'string';
const isScope = (value: unknown): value is { kind: string; id: string } => typeof value === 'object' && value !== null && isText((value as { kind?: unknown }).kind) && isText((value as { id?: unknown }).id);

/** The legacy rows of one kind, each parsed alone: one that does not parse is skipped with its id. */
function rows<T>(core: Core, kind: string, check: (value: Record<string, unknown>) => string | null): T[] {
  const found: T[] = [];
  for (const row of core.journal.db.query('SELECT id, data FROM agent_entities WHERE kind = ? ORDER BY created_at, rowid').all(kind) as { id: string; data: string }[]) {
    try {
      let value: unknown;
      try { value = JSON.parse(row.data); } catch { throw new Malformed('its data is not JSON'); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Malformed('its data is not an object');
      const problem = check(value as Record<string, unknown>);
      if (problem !== null) throw new Malformed(problem);
      found.push(value as T);
    } catch (error) {
      skipped(core, kind, row.id, error);
    }
  }
  return found;
}

function skipped(core: Core, kind: string, id: string, error: unknown): void {
  if (!(error instanceof Malformed)) throw error;
  core.log('warn', `agents migration: skipped the ${kind} record ${id}: ${error.message}; it stays as it was`);
}

export function migrateAgents(core: Core, store: AgentStore): void {
  if (core.journal.getSetting(DONE)) return;
  const run: Record<(typeof STEPS)[number], () => void> = {
    sessions: () => migrateSessions(core, store),
    routines: () => migrateRoutines(core, store),
    // The sessions left are the agents' own: their threads hold the old prompts.
    prompts: () => { for (const session of rows<OldSession>(core, 'session', sessionProblem)) if (session.threadId) migratePrompts(core, session.threadId); },
    memories: () => archiveAll(core, store),
    settings: () => { core.journal.db.query("DELETE FROM settings WHERE key LIKE 'agents:attachments:%' OR key LIKE 'agents:checkpoint:%'").run(); },
  };
  let complete = true;
  for (const step of STEPS) {
    if (core.journal.getSetting(`${DONE}:${step}`)) continue;
    try {
      run[step]();
      core.journal.setSetting(`${DONE}:${step}`, { at: Date.now() });
    } catch (error) {
      // Left unmarked: the next start tries this step again. Agents load meanwhile.
      complete = false;
      core.log('error', `agents migration, step ${step}: ${messageOf(error)}; the next start tries it again`);
    }
  }
  if (!complete) return;
  core.journal.setSetting(DONE, { at: Date.now() });
  for (const step of STEPS) core.journal.deleteSetting(`${DONE}:${step}`);
}

function sessionProblem(value: Record<string, unknown>): string | null {
  if (!isText(value['id']) || !isText(value['agentId']) || !isText(value['threadId'])) return 'expected a session with id, agentId and threadId';
  if (!Number.isInteger(value['revision'])) return 'expected an integer revision';
  if (value['scope'] !== undefined && !isScope(value['scope'])) return 'expected a scope with a kind and an id';
  return null;
}

/** Keeps each agent's own session, scope dropped. */
function migrateSessions(core: Core, store: AgentStore): void {
  for (const session of rows<OldSession>(core, 'session', sessionProblem)) {
    const own = session.scope === undefined || (session.scope.kind === 'agent' && session.scope.id === session.agentId);
    if (own && store.records.find('profile', session.agentId)) {
      if (session.scope !== undefined) store.records.update('session', session.id, session.revision, { agentId: session.agentId, threadId: session.threadId });
      continue;
    }
    const thread = core.journal.getThread(session.threadId);
    if (thread && !thread.archived) {
      const now = Date.now();
      core.journal.putThread({ ...thread, archived: true, archivedAt: now, updatedAt: now });
    }
    store.records.remove('session', session.id);
  }
}

function migrateRoutines(core: Core, store: AgentStore): void {
  const routines = rows<OldRoutine>(core, 'routine', value => !isText(value['id']) || !Number.isInteger(value['revision']) ? 'expected a routine with an id and an integer revision' : null);
  for (const routine of routines) {
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

function memoryProblem(value: Record<string, unknown>): string | null {
  if (!isText(value['id'])) return 'expected an id';
  const createdAt = value['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(new Date(createdAt).getTime())) return 'expected createdAt as a valid time';
  if (value['scope'] !== undefined && !isScope(value['scope'])) return 'expected a scope with a kind and an id';
  if (value['title'] !== undefined && !isText(value['title'])) return 'expected title as text';
  if (value['text'] !== undefined && !isText(value['text'])) return 'expected text as text';
  return null;
}

/** Every agent's old scoped memories; an agent whose archive cannot be written fails the step after the others ran. */
function archiveAll(core: Core, store: AgentStore): void {
  const memories = rows<OldMemory>(core, 'memory', memoryProblem);
  let failed: unknown = null;
  for (const agent of store.records.list('profile')) {
    try { archiveMemories(core, store, agent.id, memories); }
    catch (error) { failed ??= error; core.log('warn', `agents migration: the older notes of agent ${agent.id} were not archived: ${messageOf(error)}`); }
  }
  if (failed !== null) throw failed;
}

/** The agent's old scoped memories, written once beside MEMORY.md. */
function archiveMemories(core: Core, store: AgentStore, agentId: string, all: readonly OldMemory[]): void {
  if (core.journal.getSetting(`${ARCHIVED}${agentId}`)) return;
  const memories = all.filter(memory => memory.scope?.kind === 'agent' && memory.scope.id === agentId);
  if (memories.length) {
    const brain = store.resident.brain(agentId);
    const target = join(brain.path, MEMORY_ARCHIVE);
    if (!existsSync(target)) {
      const body = memories.map(memory => `## ${memory.title ?? 'Note'} (${new Date(memory.createdAt).toISOString().slice(0, 10)})\n\n${(memory.text ?? '').trim()}\n`).join('\n');
      createBrainFile(store.resident.brainRoot().path, target, `# Older notes\n\nWhat this bot noted before its memory became MEMORY.md alone. Read it when it matters; nothing here is sent by itself.\n\n${body}`);
    }
  }
  core.journal.setSetting(`${ARCHIVED}${agentId}`, { at: Date.now(), count: memories.length });
}
