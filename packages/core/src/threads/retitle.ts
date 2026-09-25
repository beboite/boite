import type { Message, ThreadId, ThreadSummary, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver } from '../drivers/index.ts';
import { messageOf, refused } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { cleanAgentTitle, textOf, titleFromPrompt } from '../titles.ts';
import { saveThread, withLoad } from './records.ts';

/**
 * A thread's title written from its first prompt and answer, on request or
 * after its first finished turn.
 */
export class ThreadTitles {
  /** The threads a title is being written for right now: a second ask is refused, not doubled. */
  private readonly retitling = new Set<ThreadId>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /**
   * A title from the thread's first prompt and first answer: the driver's own
   * words when it has some (`titleSource: agent`), the first line of the
   * prompt otherwise (`prompt`). A driver that throws is one warning on the
   * log and the same fallback, never a failed call. Refused by name on a
   * thread with no prompt yet, or while an earlier ask is still running.
   */
  async retitle(threadId: ThreadId): Promise<ThreadSummary> {
    const thread = this.threads.require(threadId);
    if (this.retitling.has(threadId)) {
      throw refused('a title is already being written for this thread', { threadId });
    }
    let first: Message | undefined;
    let answer: Message | undefined;
    for (const message of this.core.journal.walkMessages(threadId)) {
      if (first === undefined && message.role === 'user') first = message;
      if (answer === undefined && message.role === 'assistant' && textOf(message).length > 0) answer = message;
      if (first !== undefined && answer !== undefined) break;
    }
    if (first === undefined) throw refused('this thread has no prompt to write a title from', { threadId });
    const prompt = textOf(first);
    const provider = this.core.providers.require(thread.providerId);
    const account = this.core.accounts.require(thread.accountId);
    const driver = getDriver(provider.protocol);

    this.retitling.add(threadId);
    let agentTitle: string | null = null;
    try {
      if (driver.title !== undefined) {
        const raw = await driver.title({
          thread,
          provider,
          account,
          accountEnv: this.core.accounts.accountEnv(account, provider),
          prompt,
          answer: answer === undefined ? '' : textOf(answer),
          spawnChild: this.threads.contexts.leasedSpawnChild(threadId, provider),
          log: (level, message) => {
            this.core.log(level, message);
          },
        });
        agentTitle = raw === null ? null : cleanAgentTitle(raw);
      }
    } catch (error) {
      this.core.log('warn', `no title from ${provider.name} for thread ${threadId}: ${messageOf(error)}`);
    } finally {
      this.retitling.delete(threadId);
    }
    if (this.core.journal.isClosed()) return thread;

    // The thread as it stands now: a rename that landed during the ask is the
    // user's, and the agent's words do not go over it. Asking again on a name
    // the user typed earlier is still allowed, since that ask is his own.
    const current = this.threads.require(threadId);
    if (current.titleSource === 'user' && current.title !== thread.title) return withLoad(this.core, current);
    if (agentTitle !== null) return saveThread(this.core, { ...current, title: agentTitle, titleSource: 'agent' }, 'thread.updated');
    const fromPrompt = titleFromPrompt(prompt);
    if (fromPrompt.length === 0 || (fromPrompt === current.title && current.titleSource === 'prompt')) {
      return withLoad(this.core, current);
    }
    return saveThread(this.core, { ...current, title: fromPrompt, titleSource: 'prompt' }, 'thread.updated');
  }

  /**
   * The first finished turn of a thread still called by its prompt gets the
   * agent's title, when the driver writes one. Not awaited by the turn: the
   * title lands as its own `thread.updated`, seconds later on a real agent.
   */
  autoTitle(threadId: ThreadId, turnId: TurnId): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.titleSource !== 'prompt') return;
    const provider = this.core.providers.get(thread.providerId);
    if (provider === undefined || getDriver(provider.protocol).title === undefined) return;
    const done = this.core.journal.listTurns(threadId).filter((turn) => turn.status === 'done');
    if (done.length !== 1 || done[0]?.id !== turnId) return;
    void this.retitle(threadId).catch((error: unknown) => {
      this.core.log('warn', `no title for thread ${threadId}: ${messageOf(error)}`);
    });
  }
}
