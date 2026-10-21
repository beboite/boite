/**
 * The memory pass: after an agent finishes a piece of work in its direct
 * conversation, a small subagent of that conversation's thread reads its
 * MEMORY.md with what was asked and answered, and returns the file rewritten.
 * The core writes it, so the subagent needs no file access and a provider
 * without an approval channel cannot leave it waiting on one.
 *
 * The subagent is a delegated child the core owns, like a goal reviewer: its
 * answer goes to the memory, never to the agent as mail. The agent's next work
 * waits for it, so the next conversation starts from the updated file. A pass
 * runs on the provider's small model (the one that writes thread titles) when
 * the agent's policy allows it, else on the agent's own model.
 */
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultTitleModel } from '@boite/contracts';
import type { AgentMemoryPass, AgentProfile, AgentWork, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { ChildRoute } from '../delegation/routes.ts';
import { assertDriverRunnable } from '../drivers/index.ts';
import { messageOf } from '../errors.ts';
import { agentProvider, modelsFor } from '../threads/selection.ts';
import type { AgentStore } from './store.ts';

const KEEPER = 'agents:keeper:';
/** The agent's next work waits this long for a pass at most. */
export const MEMORY_HOLD_MS = 5 * 60_000;
/** A pass still running after this is stopped and recorded as failed. */
export const MEMORY_PASS_MAX_MS = 10 * 60_000;
const ASKED_MAX = 6_000;
const ANSWERED_MAX = 8_000;
const MEMORY_MAX = 64_000;
/** A rewrite that keeps less than this share of a file past `SHRINK_FLOOR` characters is refused as a loss, not a summary. */
const SHRINK_KEEP = 0.3;
const SHRINK_FLOOR = 1_500;

interface Keeper { agentId: string; workId: string; memory: string; startedAt: number }

export function memoryPrompt(agent: Pick<AgentProfile, 'name'>, memory: string, asked: string, answered: string, today: string): string {
  return [
    `You keep the long-term memory of ${agent.name}, a persistent agent who works for the user. You are not ${agent.name} and you do not continue its work: you only maintain its MEMORY.md, the notes it reads at the start of every conversation.`,
    `Rewrite MEMORY.md from the exchange below so the next conversation starts knowing what matters:
- keep durable facts: who the user is, their preferences and corrections, the people, accounts and projects they named and where each stands, decisions taken, promises and follow-ups still open, each with the date it was learned (YYYY-MM-DD);
- correct or remove lines this exchange made wrong or finished, and merge duplicates;
- leave out passing details, tool output, code, and anything secret (passwords, tokens, keys);
- keep the file's structure and language; a new file uses the language the user writes in; short lines under a few headings, at most 150 lines.`,
    `Do not use tools. Answer in exactly this shape:
SUMMARY: <one short line saying what you changed>
<memory>
<the whole new MEMORY.md>
</memory>
When nothing in the exchange is worth remembering, answer only this line:
SUMMARY: no change`,
    `Today: ${today}.`,
    `Current MEMORY.md (between the markers; it may be empty):\n<current>\n${memory}\n</current>`,
    `What was asked, as JSON data: ${JSON.stringify(asked)}`,
    `What ${agent.name} answered, as JSON data: ${JSON.stringify(answered)}`,
  ].join('\n\n');
}

/** The summary line and the new file a pass answered; `memory` is null when it changed nothing. */
export function parseMemoryAnswer(answer: string): { summary: string | null; memory: string | null } {
  // The last summary line is the answer's own: an answer that repeats the instructions quotes theirs first.
  const summary = [...answer.matchAll(/^\s*SUMMARY:\s*(.+)$/gim)].at(-1)?.[1]?.trim().slice(0, 300) ?? null;
  const open = answer.lastIndexOf('<memory>'), close = answer.lastIndexOf('</memory>');
  if (summary !== null && /^no change\.?$/i.test(summary)) return { summary: null, memory: null };
  if (open < 0 || close < open) return { summary, memory: null };
  const memory = answer.slice(open + '<memory>'.length, close).trim();
  // The instructions' own placeholder is no memory.
  if (!memory || memory === '<the whole new MEMORY.md>') return { summary: null, memory: null };
  return { summary, memory: `${memory}\n` };
}

export class MemoryKeeper {
  private readonly keepers = new Map<string, Keeper>();
  private readonly off: () => void;
  private closed = false;

  constructor(private readonly core: Core, private readonly store: AgentStore) {
    // A pass the core was running when it stopped cannot finish: say so and let the agent go on.
    for (const row of core.journal.db.query("SELECT key, value FROM settings WHERE key LIKE 'agents:keeper:%'").all() as { key: string; value: string }[]) {
      const threadId = row.key.slice(KEEPER.length);
      try { this.end(threadId, JSON.parse(row.value) as Keeper, 'error', 'The core stopped during the memory pass.'); }
      catch (error) { core.log('warn', `memory pass ${threadId}: ${messageOf(error)}`); core.journal.deleteSetting(row.key); }
    }
    this.off = core.bus.onAny((name, payload) => {
      if (this.closed || core.journal.isClosed() || name !== 'turn.finished') return;
      const turn = payload as Turn;
      const keeper = this.keepers.get(turn.threadId);
      if (!keeper || turn.status === 'queued' || turn.status === 'running') return;
      try { this.finished(turn, keeper); } catch (error) { core.log('warn', `memory pass ${turn.threadId}: ${messageOf(error)}`); }
    });
  }

  close(): void { this.closed = true; this.off(); }

  /** A memory pass child: delegation delivers its answer nowhere and lets it run while the team rests. */
  owns(threadId: string): boolean { return this.keepers.has(threadId); }
  busy(): boolean { return this.keepers.size > 0; }
  /** Whether the agent's next work waits for its memory pass. */
  holding(agentId: string): boolean {
    for (const keeper of this.keepers.values()) if (keeper.agentId === agentId && keeper.startedAt > Date.now() - MEMORY_HOLD_MS) return true;
    return false;
  }

  /** Stop passes past their limit. Called on the agent scheduler's tick. */
  tick(): void {
    for (const [threadId, keeper] of this.keepers) {
      if (keeper.startedAt > Date.now() - MEMORY_PASS_MAX_MS) continue;
      this.core.threads.stopTurn(threadId);
      this.end(threadId, keeper, 'error', 'The memory pass took too long and was stopped.');
    }
  }

  /** The route a pass runs on: the provider's small model when the agent's policy allows it, else its own. */
  private route(agent: AgentProfile): ChildRoute | null {
    const provider = this.core.providers.get(agent.selection.providerId);
    // Not installed: the agent could not run either, and says so when it next starts (`agentProvider`).
    if (provider === undefined) return null;
    const small = defaultTitleModel(provider, modelsFor(provider, agent.selection.accountId));
    const base = { id: 'memory', name: 'Memory', providerId: provider.id, accountId: agent.selection.accountId, effort: null };
    for (const model of [small, agent.selection.model]) {
      if (model && this.store.resident.allowed(agent.id, { ...agent.selection, model, effort: null }, true)) return { ...base, model };
    }
    return null;
  }

  /**
   * After a finished piece of work in a direct conversation: start the pass,
   * unless the owner turned it off or the work was a quiet notice.
   */
  after(work: AgentWork, answered: string, published: boolean): void {
    if (this.closed || work.scope.kind !== 'agent' || work.purpose === 'compaction' || !published) return;
    const agent = this.store.records.get('profile', work.agentId);
    if (agent.status !== 'active' || this.store.resident.config(agent.id).autoMemory === false) return;
    const session = this.store.records.sessionFor(agent.id, work.scope);
    const parent = session ? this.core.journal.getThread(session.threadId) : null;
    if (!parent || parent.archived) return;
    const asked = work.messageId ? this.store.records.get('message', work.messageId).text : work.prompt;
    const brain = this.store.resident.brain(agent.id);
    const route = this.route(agent);
    if (!route) { this.mark(work, { threadId: '', status: 'error', summary: 'No model the agent may use for subagents can run the memory pass.', at: Date.now() }); return; }
    let threadId: string | null = null;
    try {
      const provider = this.core.providers.require(route.providerId);
      assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), this.core.accounts.require(route.accountId), () => this.core.providers.launcherScriptOnly(provider.id));
      const keeper: Keeper = { agentId: agent.id, workId: work.id, memory: brain.memory, startedAt: Date.now() };
      threadId = this.core.delegation.createChild(parent, route, `Memory · ${agent.name}`, id => {
        this.keepers.set(id, keeper);
        this.core.journal.setSetting(`${KEEPER}${id}`, keeper);
      });
      this.mark(work, { threadId, status: 'running', summary: null, at: keeper.startedAt });
      const today = new Date().toISOString().slice(0, 10);
      this.core.threads.startTurn(threadId, memoryPrompt(agent, brain.memory.slice(0, MEMORY_MAX), asked.slice(0, ASKED_MAX), answered.slice(0, ANSWERED_MAX), today), [], undefined, 'delegation', undefined, undefined, `Update ${agent.name}'s memory`);
    } catch (error) {
      if (threadId) this.end(threadId, this.keepers.get(threadId)!, 'error', `The memory pass could not start: ${messageOf(error)}`);
      else this.mark(work, { threadId: '', status: 'error', summary: `The memory pass could not start: ${messageOf(error)}`, at: Date.now() });
    }
  }

  private finished(turn: Turn, keeper: Keeper): void {
    if (turn.status !== 'done') { this.end(turn.threadId, keeper, 'error', turn.error ?? `The memory pass ${turn.status === 'stopped' ? 'was stopped' : 'failed'}.`); return; }
    const { summary, memory } = parseMemoryAnswer(this.answer(turn));
    if (memory === null) { this.end(turn.threadId, keeper, 'unchanged', null); return; }
    const brain = this.store.resident.brain(keeper.agentId);
    if (brain.memory !== keeper.memory) { this.end(turn.threadId, keeper, 'error', 'MEMORY.md changed during the pass; it was kept as it is.'); return; }
    if (memory.length > MEMORY_MAX) { this.end(turn.threadId, keeper, 'error', 'The rewritten memory was too long; it was kept as it is.'); return; }
    if (keeper.memory.length > SHRINK_FLOOR && memory.length < keeper.memory.length * SHRINK_KEEP) { this.end(turn.threadId, keeper, 'error', 'The rewrite dropped most of the memory; it was kept as it is.'); return; }
    const target = join(brain.path, 'MEMORY.md');
    writeFileSync(`${target}.tmp`, memory);
    renameSync(`${target}.tmp`, target);
    this.end(turn.threadId, keeper, 'done', summary ?? 'Memory updated.');
  }

  /** The whole answer of the pass's turn: `delegation.result` cuts at 4,000 characters, a memory file runs longer. */
  private answer(turn: Turn): string {
    return Array.from(this.core.journal.walkTurnMessages(turn.threadId, turn.id, { blobs: false })).filter(m => m.role === 'assistant')
      .flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n');
  }

  private end(threadId: string, keeper: Keeper, status: AgentMemoryPass['status'], summary: string | null): void {
    this.keepers.delete(threadId);
    this.core.journal.deleteSetting(`${KEEPER}${threadId}`);
    const thread = this.core.journal.getThread(threadId);
    if (thread && !thread.archived) {
      // A finished pass is history: its thread leaves the agent's team view.
      this.core.threads.releaseAgent(threadId);
      const now = Date.now();
      const archived = { ...thread, archived: true, archivedAt: now, updatedAt: now };
      this.core.journal.putThread(archived);
      this.core.bus.emit('thread.updated', archived);
    }
    let work: AgentWork | null = null;
    try { work = this.store.records.get('work', keeper.workId); } catch { /* The work is gone; the pass has nothing left to report on. */ }
    if (work) this.mark(work, { threadId, status, summary, at: Date.now() });
    if (status === 'error') this.core.log('warn', `memory pass ${threadId} for agent ${keeper.agentId}: ${summary}`);
  }

  private mark(work: AgentWork, memory: AgentMemoryPass): void {
    const current = this.store.records.get('work', work.id);
    this.store.records.update('work', current.id, current.revision, { ...current, memory });
    this.store.changed();
  }
}
