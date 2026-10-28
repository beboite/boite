import type { AgentEntrustment, AgentProfile, RpcParams } from '@boite/contracts';
import type { GoalOutcome } from '../activity.ts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import type { AgentStore } from './store.ts';
import { object, quoted, text } from './validation.ts';

const SETTING = 'agents:entrusted';
export const DEFAULT_OBJECTIVE = 'Take over this work where it stands and carry it to a verified result.';
const ANSWER_LIMIT = 8000;
const PERSONA_LIMIT = 2000;
const EVENTS = { complete: 'done', blocked: 'blocked', stopped: 'stopped' } as const;

/**
 * Ordinary threads the owner handed to a persistent agent. The thread keeps
 * its model and session; a goal keeps it working and the agent's instructions
 * join its turns. It goes on the agent's desk, a line in the agent's thread
 * says so, and the goal's end wakes the agent with an event.
 */
export class AgentEntrustments {
  private held: AgentEntrustment[] | null = null;

  constructor(private readonly core: Core, private readonly store: AgentStore) {
    core.activity.onGoal(event => this.ended(event));
    // Both sources stop with the core: activity closes first and the journal guard covers the bus.
    core.bus.onCommitted((name, payload) => {
      if (core.journal.isClosed()) return;
      try {
        if (name === 'thread.updated' && (payload as { archived?: boolean }).archived) this.drop((payload as { id: string }).id);
        else if (name === 'thread.removed') this.drop((payload as { threadId: string }).threadId);
      } catch (error) { core.log('warn', `entrusted thread after ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    });
  }

  list(): AgentEntrustment[] {
    this.held ??= (this.core.journal.getSetting(SETTING) as AgentEntrustment[] | undefined) ?? [];
    return this.held.map(entry => ({ ...entry }));
  }

  of(threadId: string): AgentEntrustment | null { return this.list().find(entry => entry.threadId === threadId) ?? null; }

  private write(next: AgentEntrustment[]): void {
    if (next.length) this.core.journal.setSetting(SETTING, next);
    else this.core.journal.deleteSetting(SETTING);
    this.held = next;
  }

  entrust(params: RpcParams<'agents.entrust'>): AgentEntrustment | null {
    object(params, 'params');
    const threadId = text(params.threadId, 'threadId', 160);
    if (params.agentId === null) return this.takeBack(threadId);
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived) throw refused('threadId: expected an existing, unarchived thread');
    if (thread.parentThreadId) throw refused('threadId: expected a top-level thread, not a delegated child');
    if (thread.agentSessionId) throw refused('threadId: expected an ordinary thread, not a bot\'s thread');
    if (thread.projectId === null) throw refused('threadId: expected a thread that belongs to a project');
    const agentId = text(params.agentId, 'agentId', 160);
    if (this.profile(agentId)?.status !== 'active') throw refused('agentId: expected an active agent');
    const objective = (params.objective === undefined ? '' : text(params.objective, 'objective', 4000, true)) || DEFAULT_OBJECTIVE;
    this.core.activity.set({ threadId, goal: { objective } });
    const entry: AgentEntrustment = { threadId, agentId, objective, at: Date.now() };
    // Entrusted to another bot: the one before loses the grant, as on a take-back.
    const before = this.of(threadId);
    this.write([...this.list().filter(other => other.threadId !== threadId), entry]);
    if (before && before.agentId !== agentId) this.release(before);
    this.store.projects.follow(agentId, threadId, 'entrusted');
    this.core.agentRuntime.line(agentId, `The user entrusted "${thread.title}" (${threadId}) to you: ${objective}`);
    this.store.changed();
    return { ...entry };
  }

  /** The owner takes the thread back: the entrustment, the goal it started and the grant it gave end, without a message. */
  private takeBack(threadId: string): null {
    const entry = this.of(threadId);
    if (!entry) return null;
    this.write(this.list().filter(other => other.threadId !== threadId));
    this.release(entry);
    if (this.core.journal.getThread(threadId) && this.core.activity.get(threadId).goal) {
      try { this.core.activity.control({ threadId, kind: 'goal', action: 'remove' }); } catch { /* The goal ended meanwhile. */ }
    }
    this.store.changed();
    return null;
  }

  private drop(threadId: string): void {
    const entry = this.of(threadId);
    if (!entry) return;
    this.write(this.list().filter(other => other.threadId !== threadId));
    this.release(entry);
    this.store.changed();
  }

  /**
   * A goal outcome. A met goal ends the entrustment; a blocker or a stop keeps
   * it for the resume. Done and blocked wake the agent with an event; a stop is
   * the user's own doing and only leaves a line.
   */
  private ended(event: GoalOutcome): void {
    const entry = this.of(event.threadId);
    if (!entry) return;
    const thread = this.core.journal.getThread(event.threadId);
    const over = event.outcome === 'complete';
    if (over) { this.write(this.list().filter(other => other.threadId !== entry.threadId)); this.release(entry); }
    const what = `Entrusted thread ${entry.threadId}, titled ${quoted(thread?.title ?? '')}: goal ${EVENTS[event.outcome]}.`;
    if (event.outcome === 'stopped') this.core.agentRuntime.line(entry.agentId, what);
    // The news of a met goal is the entrustment's last word: it reaches the bot though the grant ended with it.
    else this.core.agentRuntime.fact(entry.agentId, { key: `goal:${entry.threadId}:${event.outcome}:${Date.now()}`, text: `${what}\nIts final answer: ${quoted(event.text.slice(0, ANSWER_LIMIT))}`, threadIds: over ? [] : [entry.threadId], urgent: true });
    this.store.changed();
  }

  /** The bot's follow loses the owner's grant; it stays only where the bot reaches the thread another way. */
  private release(entry: AgentEntrustment): void {
    const agent = this.profile(entry.agentId);
    if (agent) this.store.projects.release(agent, entry.threadId);
  }

  private profile(agentId: string): AgentProfile | null {
    try { return this.store.records.get('profile', agentId); } catch { return null; }
  }

  /** Joins every turn of an entrusted thread; empty otherwise. */
  instructions(threadId: string): string {
    const entry = this.of(threadId);
    const agent = entry ? this.profile(entry.agentId) : null;
    if (!agent) return '';
    const persona = agent.instructions.trim();
    const capped = persona.length > PERSONA_LIMIT ? `${persona.slice(0, PERSONA_LIMIT)}\n[Truncated.]` : persona;
    return `\nEntrusted thread: the owner entrusted this conversation to their agent ${agent.name}${agent.domain ? ` (${agent.domain})` : ''}. Continue it as ${agent.name}, following that agent's instructions${capped ? ' below' : ''}, and end with a short summary of the result for the owner.${capped ? `\n${agent.name}'s instructions:\n${capped}` : ''}\n`;
  }
}
