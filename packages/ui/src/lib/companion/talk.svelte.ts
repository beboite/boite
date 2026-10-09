/*
 * The companion's conversation, for its window (`CompanionApp.svelte`): the
 * request it sends, the reply it streams into the bubble, and, once the reply
 * is complete, what the reply asks of the companion (`directives.ts`): facts
 * to keep or to forget, reminders to ring.
 */
import type { Attachment, Message, RpcEvents, ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { fill, strings } from '../strings';
import { COMPANION_ROLE, COMPANION_THREAD_TITLE, permissionModeOf, pickBrain, promptFor, replyText, type Brain } from './brain';
import { parseDirectives, visibleReply, type Directives } from './directives';
import { addReminder, forget, memoryBlock, readMemory, remember } from './memory';
import { isWorking } from './mood';
import { BRAIN_KEYS, writeCompanionPrefs, type CompanionPrefs } from './prefs';
import { doubtPrimed, forgetPrimed, hashText, primingFor, readPrimed, writePrimed } from './priming';
import type { ScreenShot } from './screen';
import { taskProjects } from './tasks';

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

/** A thread with the brain settings it should run with, to tell when they changed. */
const tuning = (prefs: CompanionPrefs, threadId: string): string => JSON.stringify([threadId, ...BRAIN_KEYS.map((key) => prefs[key])]);

/** The projects a task may go to, named in the conversation's first request; none when they cannot be read. */
async function projectNames(client: Client): Promise<string[]> {
  try {
    return taskProjects(await client.call('projects.list', {})).map((project) => project.name);
  } catch {
    return [];
  }
}

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
  private making: Promise<Target | string> | null = null;
  /** The thread and the brain settings last applied to it (`tuning`). */
  private tuned: string | null = null;
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
    const existing = known ? threads.find((thread) => thread.id === known) : undefined;
    // Before the thread list is read, the thread is taken as it is.
    if (known && threads.length === 0) return { threadId: known, created: false };
    if (existing && this.tuned === tuning(prefs, existing.id)) return { threadId: existing.id, created: false };
    const [providers, accounts] = await Promise.all([client.call('providers.list', {}), client.call('accounts.list', {})]);
    const brain = pickBrain(prefs, providers.loaded, accounts);
    if (!brain) return prefs.providerId === null ? strings.companion.noBrain : strings.companion.brainOff;
    if (existing) {
      await this.retune(client, existing, brain, prefs);
      return { threadId: existing.id, created: false };
    }
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
    this.tuned = tuning(prefs, thread.id);
    this.host.created(thread);
    return { threadId: thread.id, created: true };
  }

  /**
   * The agent, model, effort and control chosen in Settings, applied to the
   * conversation's thread: changing them keeps the conversation. Another agent
   * starts a session of its own, so it is given the role again. A refusal
   * leaves the thread as it was, and the next request tries again.
   */
  private async retune(client: Client, thread: ThreadSummary, brain: Brain, prefs: CompanionPrefs): Promise<void> {
    const mode = permissionModeOf(prefs.control);
    const patch = {
      ...(brain.accountId !== thread.accountId ? { accountId: brain.accountId } : {}),
      ...(brain.model !== null && brain.model !== thread.model ? { model: brain.model } : {}),
      ...(brain.effort !== thread.effort ? { effort: brain.effort } : {}),
      ...(mode !== thread.permissionMode ? { permissionMode: mode } : {})
    };
    try {
      if (Object.keys(patch).length > 0) {
        const updated = await client.call('threads.update', { threadId: thread.id, ...patch });
        if (updated.providerId !== thread.providerId) forgetPrimed();
      }
      this.tuned = tuning(prefs, thread.id);
    } catch {
      /* the thread keeps its agent for this request */
    }
  }

  /** The thread holds no request yet, as far as the thread list knows. */
  private isFresh(target: Target): boolean {
    if (target.created) return true;
    const thread = this.host.threads().find((entry) => entry.id === target.threadId);
    return thread !== undefined && !thread.lastUserMessageAt;
  }

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  /**
   * Sends a request, with the files dropped on the companion and the screen
   * when given. False when it could not be sent.
   */
  async ask(request: string, shot: ScreenShot | null, files: Attachment[] = []): Promise<boolean> {
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
      // The record goes first: a thread it knows is not fresh, whatever a late thread list says.
      const memory = memoryBlock(readMemory());
      const prime = primingFor(readPrimed(), { id: target.threadId, fresh: this.isFresh(target) }, COMPANION_ROLE, memory);
      const projects = prime === 'new' || prime === 'role' ? await projectNames(client) : [];
      const prompt = promptFor(request, { prime, memory, now: new Date(), seen: shot?.seen ?? null, files: files.map((file) => file.name ?? strings.composer.attachUnnamed), projects });
      const attachments = [...files, ...(shot?.images ?? [])];
      await client.call('turns.start', { threadId: target.threadId, prompt, ...(attachments.length > 0 ? { attachments } : {}) });
      writePrimed({ threadId: target.threadId, role: hashText(COMPANION_ROLE), memory: hashText(memory), check: false });
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
      // `threads.get` hands the thread's last messages; `messages.list` wants a cursor.
      const { messages } = await this.host.client()!.call('threads.get', { threadId, limit: TAIL, compactTools: true, compactFiles: true, compactImages: true });
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
      // The streamed text stays; the directives are lost with this reply, so
      // the memory goes again with the next request, for the agent to see.
      doubtPrimed(threadId);
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

  /** An earlier reply, picked from the history, back in the bubble. Not while one streams. */
  recall(reply: string): void {
    if (this.thinking || !reply) return;
    this.problem = '';
    this.parts = [reply];
    this.phase = 'done';
    this.shown = true;
    this.hold();
  }

  /** A line of the companion's own after a finished reply: a project it does not know, a launch that failed. */
  aside(text: string): void {
    if (this.thinking || !text) return;
    this.problem = '';
    this.parts = [[this.reply, text].filter(Boolean).join('\n\n')];
    this.phase = 'done';
    this.shown = true;
    this.hold();
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
