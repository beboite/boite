/*
 * The companion's conversation, for its window (`CompanionApp.svelte`): the
 * request it sends, the reply it streams into the bubble, and, once the reply
 * is complete, what the reply asks of the companion (`directives.ts`): facts
 * to keep or to forget, reminders to ring.
 */
import type { ImageAttachment, Message, RpcEvents, ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { fill, strings } from '../strings';
import { COMPANION_THREAD_TITLE, permissionModeOf, pickBrain, promptFor, replyText } from './brain';
import { parseDirectives, visibleReply, type Directives } from './directives';
import { addReminder, forget, memoryBlock, readMemory, remember } from './memory';
import { isWorking } from './mood';
import { writeCompanionPrefs, type CompanionPrefs } from './prefs';

export type Phase = 'none' | 'thinking' | 'streaming' | 'done' | 'error';

/** What the conversation reads from the page and tells it. */
export interface TalkHost {
  client(): Client | null;
  prefs(): CompanionPrefs;
  threads(): ThreadSummary[];
  hovering(): boolean;
  /** A thread the companion made for its conversation. */
  created(thread: ThreadSummary): void;
  /** The reply is complete, or the request failed. */
  settled(outcome: 'done' | 'error', directives: Directives | null): void;
}

interface Target {
  threadId: string;
  created: boolean;
}

/** Enough messages to reach back to the request across a few tool calls. */
const TAIL = 12;

export class Talk {
  phase = $state<Phase>('none');
  /** The text parts of the agent's last message, by index. */
  parts = $state<string[]>([]);
  problem = $state('');
  shown = $state(false);
  readonly reply = $derived(visibleReply(this.parts.filter(Boolean).join('')));
  readonly thinking = $derived(this.phase === 'thinking' || this.phase === 'streaming');

  private replyId: string | null = null;
  // The message being written, part by part with each part's type: deltas also
  // stream reasoning and tool input, which the bubble leaves out. The bubble
  // keeps the previous message until this one has text.
  private buffer: string[] = [];
  private kinds: string[] = [];
  // The turn has been seen running, so an idle thread now means it finished.
  private sawRunning = false;
  private subscribed: string | null = null;
  // Threads that were sent the role, before their summary says so.
  private readonly primed = new Set<string>();
  private making: Promise<Target | string> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: TalkHost) {}

  // -------------------------------------------------------------------------
  // The thread
  // -------------------------------------------------------------------------

  async subscribe(threadId: string | null): Promise<void> {
    const client = this.host.client();
    if (!client || threadId === this.subscribed) return;
    if (this.subscribed) void client.call('threads.unsubscribe', { threadId: this.subscribed }).catch(() => {});
    this.subscribed = threadId;
    if (!threadId) return;
    try {
      await client.call('threads.subscribe', { threadId });
    } catch {
      // The thread is gone (deleted, or this is another core): the next request starts a new one.
      this.subscribed = null;
      if (this.host.prefs().threadId === threadId) writeCompanionPrefs({ threadId: null });
    }
  }

  /** After a reconnection: the core forgot the subscription. */
  resubscribe(): void {
    const again = this.subscribed ?? this.host.prefs().threadId;
    this.subscribed = null;
    void this.subscribe(again);
  }

  /** The conversation's thread, made on first need; a string says why there is none. */
  private ensureThread(): Promise<Target | string> {
    this.making ??= this.makeThread().finally(() => (this.making = null));
    return this.making;
  }

  private async makeThread(): Promise<Target | string> {
    const client = this.host.client()!;
    const prefs = this.host.prefs();
    const threads = this.host.threads();
    const known = prefs.threadId;
    if (known && (threads.length === 0 || threads.some((thread) => thread.id === known))) return { threadId: known, created: false };
    const [providers, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
    const brain = pickBrain(prefs, providers.loaded, accounts);
    if (!brain) return prefs.providerId === null ? strings.companion.noBrain : strings.companion.brainOff;
    const drafts = await client.call('projects.drafts', {});
    const thread = await client.call('threads.create', {
      projectId: drafts.id,
      providerId: brain.providerId,
      accountId: brain.accountId,
      title: COMPANION_THREAD_TITLE,
      ...(brain.model ? { model: brain.model } : {}),
      effort: brain.effort,
      permissionMode: permissionModeOf(prefs.control)
    });
    writeCompanionPrefs({ threadId: thread.id });
    this.host.created(thread);
    return { threadId: thread.id, created: true };
  }

  /** The role and the memory go with a conversation's first request only. */
  private isFirst(target: Target): boolean {
    if (target.created) return true;
    if (this.primed.has(target.threadId)) return false;
    const thread = this.host.threads().find((entry) => entry.id === target.threadId);
    return thread !== undefined && !thread.lastUserMessageAt;
  }

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  /** Sends a request, with the screen when given. False when it could not be sent. */
  async ask(request: string, screen: ImageAttachment | null): Promise<boolean> {
    const client = this.host.client();
    if (!request || !client || this.thinking) return false;
    this.problem = '';
    this.parts = [];
    this.buffer = [];
    this.kinds = [];
    this.replyId = null;
    this.sawRunning = false;
    this.phase = 'thinking';
    this.shown = true;
    clearTimeout(this.hideTimer);
    try {
      const target = await this.ensureThread();
      if (typeof target === 'string') {
        this.fail(target);
        return false;
      }
      await this.subscribe(target.threadId);
      const first = this.isFirst(target);
      this.primed.add(target.threadId);
      const prompt = promptFor(request, { first, memory: memoryBlock(readMemory()), now: new Date(), screen: screen !== null });
      await client.call('turns.start', { threadId: target.threadId, prompt, ...(screen ? { attachments: [screen] } : {}) });
      this.sawRunning = true;
      this.follow();
      return true;
    } catch (error) {
      this.fail(fill(strings.companion.failed, { reason: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  async stop(): Promise<void> {
    const client = this.host.client();
    const threadId = this.host.prefs().threadId;
    if (!client || !threadId) return;
    try {
      await client.call('turns.stop', { threadId });
    } catch {
      /* the turn ended on its own meanwhile */
    }
  }

  /** Called on every change to the thread list: an idle thread after a running one is a finished turn. */
  follow(): void {
    const id = this.host.prefs().threadId;
    const own = id ? this.host.threads().find((thread) => thread.id === id) : undefined;
    if (!own || !this.thinking) return;
    if (isWorking(own.status)) this.sawRunning = true;
    else if (this.sawRunning) void this.finish(own.id);
  }

  /** The request did not go: the bubble says why. */
  fail(problem: string): void {
    this.shown = true;
    this.problem = problem;
    this.phase = 'error';
    this.hold();
    this.host.settled('error', null);
  }

  /**
   * The reply is complete: its last message's text replaces what streamed,
   * and the directives of every message the turn wrote are carried out.
   */
  private async finish(threadId: string) {
    this.phase = 'done';
    this.hold();
    let directives: Directives | null = null;
    try {
      const { messages } = await this.host.client()!.call('messages.list', { threadId, limit: TAIL, compactTools: true, compactFiles: true, compactImages: true });
      const answer: Message[] = [];
      for (const message of [...messages].reverse()) {
        if (message.role === 'user') break;
        if (message.role === 'assistant') answer.unshift(message);
      }
      const last = answer.at(-1);
      if (last && this.phase === 'done') {
        const text = replyText(last);
        if (text) this.parts = [text];
      }
      directives = parseDirectives(answer.map(replyText).join('\n'), new Date());
      for (const fact of directives.forget) forget(fact);
      for (const fact of directives.remember) remember(fact);
      for (const reminder of directives.remind) addReminder(reminder.text, reminder.at);
      this.hold();
    } catch {
      /* the streamed text stays; the directives are lost with this reply */
    }
    this.host.settled('done', directives);
  }

  // -------------------------------------------------------------------------
  // The bubble
  // -------------------------------------------------------------------------

  /** A finished reply stays long enough to read, and as long as the pointer is on the companion. */
  hold(): void {
    clearTimeout(this.hideTimer);
    if (this.phase !== 'done' || this.host.hovering()) return;
    this.hideTimer = setTimeout(() => (this.shown = false), Math.max(8000, this.reply.length * 70));
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.shown = false;
  }

  dispose(): void {
    clearTimeout(this.hideTimer);
  }

  private showBuffer() {
    if (this.buffer.some(Boolean)) this.parts = [...this.buffer];
  }

  started(message: Message): void {
    if (message.threadId !== this.host.prefs().threadId || message.role !== 'assistant' || !this.thinking) return;
    this.replyId = message.id;
    this.kinds = message.parts.map((part) => part.type);
    this.buffer = message.parts.map((part) => (part.type === 'text' ? part.text : ''));
    this.showBuffer();
    this.phase = 'streaming';
  }

  delta({ messageId, partIndex, text }: RpcEvents['message.delta']): void {
    if (messageId !== this.replyId) return;
    // A delta past the known parts opens a text part, as in the store.
    if ((this.kinds[partIndex] ??= 'text') !== 'text') return;
    this.buffer[partIndex] = (this.buffer[partIndex] ?? '') + text;
    this.showBuffer();
  }

  part({ messageId, partIndex, part }: RpcEvents['message.part']): void {
    if (messageId !== this.replyId) return;
    this.kinds[partIndex] = part.type;
    this.buffer[partIndex] = part.type === 'text' ? part.text : '';
    this.showBuffer();
  }

  completed({ messageId, state }: RpcEvents['message.completed']): void {
    if (messageId === this.replyId && state === 'error') this.fail(fill(strings.companion.failed, { reason: this.reply || state }));
  }
}
