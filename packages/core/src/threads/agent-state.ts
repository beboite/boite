import type { AgentCommand, BackgroundTask, ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { saveThread } from './records.ts';

/**
 * What an agent reports about itself between messages: the commands it
 * takes, the work it still runs in the background, its context meter.
 */
export class AgentState {
  /**
   * What each thread's agent last said it takes as `/name`. Memory only: the
   * list belongs to the agent process, so a fresh core learns it again on the
   * next turn, and nothing here is worth a journal row.
   */
  readonly commands = new Map<ThreadId, AgentCommand[]>();
  /** What each thread's agent still runs in the background. Memory only, like `commands`. */
  readonly background = new Map<ThreadId, BackgroundTask[]>();

  constructor(private readonly core: Core) {}

  /** What the agent still runs in the background, told to the clients when it changed. */
  noteBackground(threadId: ThreadId, list: BackgroundTask[]): void {
    const before = this.background.get(threadId) ?? [];
    if (JSON.stringify(before) === JSON.stringify(list)) return;
    if (list.length === 0) this.background.delete(threadId);
    else this.background.set(threadId, list);
    this.core.bus.emit('thread.background', { threadId, tasks: list });
  }

  /**
   * The agent's command list, whole, as a driver reports it. A name listed
   * twice keeps its first entry, an empty or non-string name is dropped, and
   * the same list twice is no event: the clients only hear a change.
   */
  noteCommands(threadId: ThreadId, list: AgentCommand[]): void {
    const seen = new Set<string>();
    const commands: AgentCommand[] = [];
    for (const entry of list) {
      const name = typeof entry.name === 'string' ? entry.name.trim().replace(/^\//, '') : '';
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      commands.push({
        name,
        description: typeof entry.description === 'string' && entry.description.length > 0 ? entry.description : null,
        hint: typeof entry.hint === 'string' && entry.hint.length > 0 ? entry.hint : null,
      });
    }
    const before = this.commands.get(threadId);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(commands)) return;
    this.commands.set(threadId, commands);
    this.core.bus.emit('thread.commands', { threadId, commands });
  }

  /** The context meter, whole numbers only: a driver that misreads its agent writes nothing. */
  noteContext(threadId: ThreadId, use: Omit<import('@boite/contracts').ContextUse, 'at'>): void {
    const tokens = Number.isFinite(use.tokens) && use.tokens >= 0 ? Math.round(use.tokens) : null;
    if (tokens === null) return;
    const window = use.window !== null && Number.isFinite(use.window) && use.window > 0 ? Math.round(use.window) : null;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) return;
    const breakdown = use.breakdown && Object.values(use.breakdown).every(n => Number.isFinite(n) && n >= 0)
      && Math.abs(use.breakdown.input + use.breakdown.cache + use.breakdown.output - tokens) <= 1 ? use.breakdown : undefined;
    saveThread(this.core, { ...thread, context: { tokens, window, ...(breakdown ? {breakdown} : {}), at: Date.now() } }, 'thread.context');
  }
}
