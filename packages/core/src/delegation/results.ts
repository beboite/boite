import type { DelegatedAgent, DelegationResultPage, DelegationWaitResult, RpcParams, ThreadId, Turn, Usage } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Connection } from '../router.ts';
import { invalidParams, refused } from '../errors.ts';
import { usageGroups } from '../journal/usage-sums.ts';
import { usageTotal } from '../usage.ts';

export const DELEGATION_WAIT_DEFAULT_MS = 600_000;
export const DELEGATION_WAIT_MAX_MS = 3_600_000;
const PAGE_CHARS = 16_000;

export function delegationWaitTimeout(value: number | undefined): number {
  const timeout = value === undefined ? DELEGATION_WAIT_DEFAULT_MS : value;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > DELEGATION_WAIT_MAX_MS) throw invalidParams('timeoutMs: expected an integer from 0 to 3600000');
  return timeout;
}

export function directChildren(core: Core, threadId: ThreadId, agentId?: ThreadId): ThreadId[] {
  if (typeof threadId !== 'string' || !threadId) throw invalidParams('threadId: expected a nonempty string');
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) throw invalidParams('agentId: expected a nonempty string');
  const parent = core.threads.require(threadId);
  if (parent.parentThreadId) throw refused('threadId: expected the parent of direct delegated children');
  const rows = core.journal.db.query('SELECT thread_id FROM delegated_agents WHERE root_id = ? ORDER BY rowid').all(threadId) as { thread_id: string }[];
  // A child on another machine of the group, as that machine last reported it.
  const elsewhere = core.delegation.remote.childIds(threadId);
  if (agentId !== undefined && !rows.some(row => row.thread_id === agentId && core.journal.getThread(agentId)?.parentThreadId === threadId) && !elsewhere.includes(agentId)) throw refused('agentId: expected a direct delegated child of threadId');
  const ids = [...rows.map(row => row.thread_id), ...elsewhere];
  return agentId === undefined ? ids : ids.filter(id => id === agentId);
}

export function delegatedResultPage(core: Core, params: RpcParams<'delegation.result'>): DelegationResultPage {
  directChildren(core, params.threadId, params.agentId);
  return resultPageOf(core, params.agentId, params.turnId, params.offset, params.limit);
}

/** The bounded final answer of a finished turn, or its error. */
export function turnResult(core: Core, turn: Turn | null): string | null {
  if (!turn || turn.status === 'queued' || turn.status === 'running') return null;
  const rows = core.journal.db.query(`SELECT substr((SELECT group_concat(substr(json_extract(value, '$.text'), 1, 4001), char(10))
    FROM json_each(messages.parts) WHERE json_extract(value, '$.type') = 'text'), 1, 4001) AS answer
    FROM messages WHERE thread_id = ? AND turn_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 8`).all(turn.threadId, turn.id) as { answer: string | null }[];
  for (const row of rows) {
    const answer = row.answer?.trim();
    if (answer) return answer.length > 4000 ? `${answer.slice(0, 3900)}\n[Truncated. Open the agent conversation for the complete answer.]` : answer;
  }
  return turn.error ?? null;
}

/** What a team's children and the parent's delegation turns spent on this machine. */
export function teamUsage(core: Core, rootId: string): Usage {
  return usageTotal(core, usageGroups(core.journal.db, { where: `t.thread_id IN (SELECT thread_id FROM delegated_agents WHERE root_id = ?)
    OR (t.thread_id = ? AND json_extract(t.execution, '$.operation') = 'delegation')` }, rootId, rootId));
}

/** A page of a child's answer to one turn: read here for a parent here, or for its parent on another machine. */
export function resultPageOf(core: Core, agentId: ThreadId, turnId: unknown, offsetParam?: unknown, limitParam?: unknown): DelegationResultPage {
  if (typeof turnId !== 'string' || !turnId) throw invalidParams('turnId: expected a nonempty string');
  const turn = core.journal.getTurn(turnId);
  if (!turn || turn.threadId !== agentId || turn.status === 'queued' || turn.status === 'running') throw refused('turnId: expected a terminal turn of the named direct child');
  const offset = offsetParam === undefined ? 0 : offsetParam;
  const limit = limitParam === undefined ? PAGE_CHARS : limitParam;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw invalidParams('offset: expected a nonnegative integer');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_CHARS) throw invalidParams('limit: expected an integer from 1 to 16000');
  // Slice in SQLite before crossing into JS: tool payloads and the unbounded
  // complete answer never become RPC response or process-memory strings.
  const parts = `SELECT m.rowid AS message_order, CAST(p.key AS INTEGER) AS part_order, json_extract(p.value, '$.text') AS text
    FROM messages m, json_each(m.parts) p WHERE m.thread_id = ?1 AND m.turn_id = ?2
    AND m.role = 'assistant' AND json_extract(p.value, '$.type') = 'text'`;
  const count = core.journal.db.query(`WITH parts AS (${parts}) SELECT COALESCE(SUM(length(text)), 0) + MAX(COUNT(*) - 1, 0) AS total FROM parts`).get(agentId, turnId) as { total: number };
  if (offset > count.total) throw invalidParams(`offset: expected an integer from 0 to ${count.total}`);
  const row = core.journal.db.query(`WITH parts AS (${parts}), segments AS (
    SELECT message_order, part_order, CASE WHEN ROW_NUMBER() OVER (ORDER BY message_order, part_order) = 1 THEN text ELSE char(10) || text END AS text FROM parts
  ), positions AS (
    SELECT *, COALESCE(SUM(length(text)) OVER (ORDER BY message_order, part_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS start FROM segments
  ) SELECT COALESCE(group_concat(piece, ''), '') AS text FROM (
    SELECT substr(text, MAX(1, ?3 - start + 1), MIN(?4 - MAX(0, start - ?3), length(text) - MAX(0, ?3 - start))) AS piece
    FROM positions WHERE start < ?3 + ?4 AND start + length(text) > ?3 ORDER BY message_order, part_order
  )`).get(agentId, turnId, offset, limit) as { text: string };
  let text = row.text.slice(0, PAGE_CHARS);
  // Never end a bounded page halfway through a surrogate pair.
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  const next = offset + Array.from(text).length;
  return { resultRef: { agentId, turnId }, text, offset, nextOffset: next < count.total ? next : null, total: count.total };
}

/** Event-driven waits own no provider input and have no effect on automatic mail. */
export class DelegationWaits {
  private readonly pending = new Set<() => void>();
  private closed = false;
  /** `settling`: a child whose turn ended while its worktree is still being looked at has not answered yet. */
  constructor(private readonly core: Core, private readonly agents: (threadId: ThreadId) => DelegatedAgent[], private readonly settling: (threadId: ThreadId) => boolean = () => false) {}
  get size(): number { return this.pending.size; }

  wait(params: RpcParams<'delegation.wait'>, connection?: Connection): Promise<DelegationWaitResult> {
    const timeout = delegationWaitTimeout(params.timeoutMs);
    directChildren(this.core, params.threadId, params.agentId);
    if (this.closed || this.core.stopping) return Promise.reject(refused('delegation.wait: the core is stopping'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off = () => {};
      let offClose = () => {};
      let settled = false;
      const cleanup = () => { settled = true; offClose(); off(); if (timer !== undefined) clearTimeout(timer); this.pending.delete(cancel); };
      const cancel = () => { cleanup(); reject(refused('delegation.wait: the core is stopping')); };
      const inspect = (timedOut = false) => {
        if (settled) return;
        try {
          directChildren(this.core, params.threadId, params.agentId);
          const agents = this.agents(params.threadId).filter(agent => params.agentId === undefined || agent.thread.id === params.agentId);
          // A child that ended its turn to wait on its background work has not answered yet.
          const waiting = agents.some(agent => (agent.lastTurn !== null && ['queued', 'running'].includes(agent.lastTurn.status)) || agent.thread.backgroundWait?.state === 'waiting' || this.settling(agent.thread.id));
          // A child stopped on a question or an approval waits on someone: its running turn would hold the wait to its timeout.
          const asks = agents.some(agent => agent.needsInput?.some(need => need.kind === 'permission' || need.blocking));
          if (waiting && !asks && !timedOut) return;
          cleanup();
          resolve({ state: asks ? 'needs_input' : waiting ? 'waiting_for_children' : params.agentId && agents.some(agent => agent.settlement === 'result_available') ? 'result_available' : 'settled', timedOut: timedOut && !asks, agents });
        } catch (error) { cleanup(); reject(error); }
      };
      this.pending.add(cancel);
      off = this.core.bus.onCommitted(name => {
        if (name === 'turn.finished' || name === 'delegation.changed' || name === 'thread.removed') inspect();
      });
      timer = setTimeout(() => inspect(true), timeout);
      timer.unref?.();
      offClose = connection?.onClose?.(() => { cleanup(); reject(refused('delegation.wait: connection closed')); }) ?? (() => {});
      // Register first: completion between admission and this read cannot be missed.
      inspect();
    });
  }

  close(): void { this.closed = true; for (const cancel of [...this.pending]) cancel(); }
}
