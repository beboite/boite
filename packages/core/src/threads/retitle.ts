import { defaultTitleModel } from '@boite/contracts';
import type { Account, ImageAttachment, Message, ProviderDescriptor, ProviderId, ThreadId, ThreadSummary, TurnId } from '@boite/contracts';
import { setTimeout as pause } from 'node:timers/promises';
import type { Core } from '../core.ts';
import { getDriver, probedModelsOf, writesTitles } from '../drivers/index.ts';
import { messageOf, refused } from '../errors.ts';
import type { ThreadStore } from '../threads.ts';
import { cleanAgentBranch, parseAgentTitle, textOf, titleFromPrompt } from '../titles.ts';
import { saveThread, withLoad } from './records.ts';

/** Who writes a title: a provider, the account it runs under, and the model. */
interface TitleWriter {
  provider: ProviderDescriptor;
  account: Account;
  model: string | null;
}

/** Retry transient title failures twice, with the same backoff as T3 Code. Mutable for offline tests. */
export const TITLE_RETRY = { delayMs: 2_000 };

/** Initial naming, conditional refinement and explicit regeneration share one writer. */
export class ThreadTitles {
  private readonly retitling = new Map<ThreadId, Promise<ThreadSummary>>();
  private readonly abort = new AbortController();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /** Explicit regeneration may replace an earlier manual name, but never a newer rename. */
  retitle(threadId: ThreadId): Promise<ThreadSummary> {
    const thread = this.threads.require(threadId);
    if (this.retitling.has(threadId)) {
      throw refused('a title is already being written for this thread', { threadId });
    }
    return this.start(thread, false, false);
  }

  /** Name the first user turn without waiting for its agent's response. */
  autoTitle(threadId: ThreadId, turnId: TurnId): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.titleSource !== 'prompt' || thread.titleState !== undefined) return;
    const first = this.core.journal.listTurns(threadId).find((turn) => !turn.execution?.operation);
    if (first?.id !== turnId || this.writer(thread) === null || this.retitling.has(threadId)) return;
    // The pending decision survives a restart or a title call that finishes after the user turn.
    const pending = saveThread(this.core, { ...thread, titleState: { version: 1, needsRefinement: true } }, 'thread.updated');
    this.background(pending, true);
  }

  /** Only a vague first subject needs another call once that first turn completed. */
  autoRefine(threadId: ThreadId): void {
    if (this.abort.signal.aborted || this.core.journal.isClosed() || this.retitling.has(threadId)) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.titleSource === 'user' || !thread.titleState?.needsRefinement || thread.status !== 'idle') return;
    const turns = this.core.journal.listTurns(threadId).filter((turn) => !turn.execution?.operation);
    if (turns.length !== 1 || turns[0]?.status !== 'done' || this.writer(thread) === null) return;
    this.background(thread, false);
  }

  /** Recover persisted refinement decisions after the core has restored its accounts and turns. */
  recover(): void {
    if (this.abort.signal.aborted || this.core.journal.isClosed()) return;
    for (const thread of this.core.journal.listThreads()) {
      if (thread.titleState?.needsRefinement) this.autoRefine(thread.id);
    }
  }

  close(): void {
    this.abort.abort();
  }

  private background(thread: ThreadSummary, initial: boolean): void {
    void this.start(thread, initial, true).catch((error: unknown) => {
      if (!this.abort.signal.aborted) this.core.log('warn', `no title for thread ${thread.id}: ${messageOf(error)}`);
    });
  }

  private start(thread: ThreadSummary, initial: boolean, automatic: boolean): Promise<ThreadSummary> {
    const pending = this.generate(thread, initial, automatic);
    this.retitling.set(thread.id, pending);
    const settled = () => {
      if (this.retitling.get(thread.id) !== pending) return;
      this.retitling.delete(thread.id);
      // Completion can beat the initial title. Refine here too, after that decision lands.
      if (initial) this.autoRefine(thread.id);
    };
    void pending.then(settled, settled);
    return pending;
  }

  private async generate(thread: ThreadSummary, initial: boolean, automatic: boolean): Promise<ThreadSummary> {
    let first: Message | undefined;
    const answers: string[] = [];
    for (const message of this.core.journal.walkMessages(thread.id)) {
      if (message.role === 'user') {
        if (first !== undefined) break;
        first = message;
      }
      if (!initial && first !== undefined && message.turnId === first.turnId && message.role === 'assistant') {
        const text = textOf(message);
        if (text.length > 0) answers.push(text);
      }
      // The initial call needs only the user request, not an unfinished assistant message.
      if (initial && first !== undefined) break;
    }
    if (first === undefined) throw refused('this thread has no prompt to write a title from', { threadId: thread.id });
    const prompt = textOf(first);
    const writer = this.writer(thread);
    const attachments: ImageAttachment[] = first.parts.flatMap((part) => part.type === 'image'
      ? [{ kind: 'image' as const, mimeType: part.mimeType, data: part.data, name: part.alt }]
      : []);
    let generated: ReturnType<typeof parseAgentTitle> = null;
    let branchSlug: string | null = null;
    if (writer !== null) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!this.current(thread, automatic)) return this.latest(thread);
        try {
          const raw = await getDriver(writer.provider.protocol).title!({
            thread, provider: writer.provider, account: writer.account,
            accountEnv: this.core.accounts.accountEnv(writer.account, writer.provider),
            nameBranch: thread.branchNamingPending === true,
            prompt, answer: answers.join('\n\n'), initial,
            attachments: writer.provider.capabilities.images ? attachments : [],
            model: writer.model,
            spawnChild: this.threads.contexts.leasedSpawnChild(thread.id, writer.provider),
            log: (level, message, context) => this.core.log(level, message, { ...context, source: writer.provider.id, event: 'provider.title', threadId: thread.id }),
          });
          generated = raw === null ? null : parseAgentTitle(raw);
          branchSlug = raw === null ? null : cleanAgentBranch(raw);
          if (generated === null) throw new Error('the agent wrote no usable title');
          break;
        } catch (error) {
          if (this.abort.signal.aborted) return thread;
          if (attempt === 2) {
            this.core.log('warn', `no title from ${writer.provider.name} for thread ${thread.id}: ${messageOf(error)}`);
          } else {
            await pause(TITLE_RETRY.delayMs * 2 ** attempt, undefined, { signal: this.abort.signal });
          }
        }
      }
    }
    if (generated !== null && branchSlug !== null && this.current(thread, automatic) !== null && thread.branchNamingPending) {
      await this.nameWorktree(thread, branchSlug);
    }
    const current = this.current(thread, automatic);
    if (current === null) return this.latest(thread);
    if (generated !== null) {
      return saveThread(this.core, {
        ...current, title: generated.title === 'New thread' ? current.title : generated.title, titleSource: 'agent',
        titleState: { version: (current.titleState?.version ?? 0) + 1, needsRefinement: initial && (generated.needsRefinement || generated.title === 'New thread') },
      }, 'thread.updated');
    }
    // Failed automatic calls retain the current title and pending refinement decision.
    if (automatic) return withLoad(this.core, current);
    const fallback = titleFromPrompt(prompt);
    return saveThread(this.core, {
      ...current, title: fallback || current.title, titleSource: fallback ? 'prompt' : current.titleSource,
      titleState: { version: (current.titleState?.version ?? 0) + 1, needsRefinement: false },
    }, 'thread.updated');
  }

  private async nameWorktree(thread: ThreadSummary, slug: string): Promise<void> {
    const current = this.threads.require(thread.id);
    if (!current.branchNamingPending || current.branch === null || current.cwd !== thread.cwd || current.branch !== thread.branch) return;
    try {
      const branch = await this.core.worktrees.nameBranch(thread.id, thread.cwd, current.branch, slug);
      if (branch === null || this.core.journal.isClosed()) return;
      // Delegated threads and forks can stand in the same checkout. Their
      // branch badges must follow Git too, without changing a provider session.
      for (const holder of this.core.journal.listThreads()) {
        if (holder.cwd === thread.cwd && holder.branch === thread.branch) {
          saveThread(this.core, { ...holder, branch, branchNamingPending: false }, 'thread.updated');
        }
      }
    } catch (error) {
      this.core.log('warn', `no branch name for thread ${thread.id}: ${messageOf(error)}`);
    }
  }

  /** A title revision also protects renaming to the same text or away and back while a call runs. */
  private current(expected: ThreadSummary, automatic: boolean): ThreadSummary | null {
    if (this.abort.signal.aborted || this.core.journal.isClosed()) return null;
    const current = this.core.journal.getThread(expected.id);
    if (current === null || (automatic && current.archived)) return null;
    if (current.title !== expected.title || current.titleSource !== expected.titleSource ||
      (current.titleState?.version ?? 0) !== (expected.titleState?.version ?? 0) ||
      (current.sessionGeneration ?? 0) !== (expected.sessionGeneration ?? 0)) return null;
    return current;
  }

  private latest(fallback: ThreadSummary): ThreadSummary {
    if (this.core.journal.isClosed()) return fallback;
    return withLoad(this.core, this.core.journal.getThread(fallback.id) ?? fallback);
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
    const summary = this.core.providers.summary(provider.id);
    return writesTitles(provider.protocol) && summary?.available === true && summary.enabled !== false;
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
