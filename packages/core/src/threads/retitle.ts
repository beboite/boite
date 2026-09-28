import { defaultTitleModel } from '@boite/contracts';
import type { Account, Message, ProviderDescriptor, ProviderId, ThreadId, ThreadSummary, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver, probedModelsOf, writesTitles } from '../drivers/index.ts';
import { messageOf, refused } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { cleanAgentTitle, textOf, titleFromPrompt } from '../titles.ts';
import { saveThread, withLoad } from './records.ts';

/** Who writes a title: a provider, the account it runs under, and the model. */
interface TitleWriter {
  provider: ProviderDescriptor;
  account: Account;
  model: string | null;
}

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
    const writer = this.writer(thread);

    this.retitling.add(threadId);
    let agentTitle: string | null = null;
    try {
      const driver = writer === null ? null : getDriver(writer.provider.protocol);
      if (writer !== null && driver?.title !== undefined) {
        const raw = await driver.title({
          thread,
          provider: writer.provider,
          account: writer.account,
          accountEnv: this.core.accounts.accountEnv(writer.account, writer.provider),
          prompt,
          answer: answer === undefined ? '' : textOf(answer),
          model: writer.model,
          spawnChild: this.threads.contexts.leasedSpawnChild(threadId, writer.provider),
          log: (level, message) => {
            this.core.log(level, message);
          },
        });
        agentTitle = raw === null ? null : cleanAgentTitle(raw);
      }
    } catch (error) {
      this.core.log('warn', `no title from ${writer?.provider.name ?? thread.providerId} for thread ${threadId}: ${messageOf(error)}`);
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
   * The first finished turn of a thread still called by its prompt gets an
   * agent's title, when one can write it. Not awaited by the turn: the title
   * lands as its own `thread.updated`, seconds later on a real agent.
   */
  autoTitle(threadId: ThreadId, turnId: TurnId): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.titleSource !== 'prompt') return;
    if (this.writer(thread) === null) return;
    const done = this.core.journal.listTurns(threadId).filter((turn) => turn.status === 'done');
    if (done.length !== 1 || done[0]?.id !== turnId) return;
    void this.retitle(threadId).catch((error: unknown) => {
      this.core.log('warn', `no title for thread ${threadId}: ${messageOf(error)}`);
    });
  }

  /**
   * The model Settings names, on its provider, under the thread's account when
   * the provider is the thread's and that provider's first signed-in account
   * otherwise. Without a choice, or while the chosen provider cannot run or
   * write titles, the thread's own provider writes it on its small default.
   * Null when that one cannot either: no title hook, not installed, or the
   * thread's account signed out.
   */
  private writer(thread: ThreadSummary): TitleWriter | null {
    const chosen = this.core.settings.get().titleModel ?? null;
    if (chosen !== null) {
      const provider = this.core.providers.get(chosen.providerId);
      const account = provider === undefined ? undefined : this.accountOf(thread, provider.id);
      if (provider !== undefined && account !== undefined && this.canWrite(provider)) {
        return { provider, account, model: chosen.model };
      }
    }
    const provider = this.core.providers.get(thread.providerId);
    const account = provider === undefined ? undefined : this.accountOf(thread, provider.id);
    if (provider === undefined || account === undefined || !this.canWrite(provider)) return null;
    const models = probedModelsOf(provider.protocol, provider.id, account.id) ?? provider.models;
    return { provider, account, model: defaultTitleModel(provider, models) };
  }

  /** A provider with a title hook that is installed here, the check a turn passes too. */
  private canWrite(provider: ProviderDescriptor): boolean {
    return writesTitles(provider.protocol) && this.core.providers.summary(provider.id)?.available === true;
  }

  /**
   * The account a provider writes a title under: the thread's own when it is
   * that provider's and not signed out, like `assertDriverRunnable` asks of a
   * turn, else that provider's first account signed in.
   */
  private accountOf(thread: ThreadSummary, providerId: ProviderId): Account | undefined {
    if (thread.providerId === providerId) {
      const own = this.core.journal.getAccount(thread.accountId);
      return own === null || own.status === 'unauthenticated' ? undefined : own;
    }
    return this.core.accounts.list().find((account) => account.providerId === providerId && account.status === 'ok');
  }
}
