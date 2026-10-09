/*
 * One agent's conversation with the user through the companion, for its
 * window (`CompanionApp.svelte`): the request, sent to the agent's direct
 * conversation (`agents.message.send`) with the screen and the files kept
 * where the agent can open them; the answer streamed into the agent's bubble
 * from the thread it works in; then the answer the agent wrote. What an answer
 * asks of the companion is carried out by `crew.svelte.ts`.
 */
import type { AgentConversationMessage, AgentsSnapshot, Attachment, Message, RpcEvents } from '@boite/contracts';
import type { Client } from '../client';
import { fill, strings } from '../strings';
import { messageFor } from './brain';
import { directScope, replyTo, sessionThreadOf, workFailed, workFor } from './crew';
import { visibleReply } from './directives';
import type { ScreenShot } from './screen';
import { bytesOf, keepFile } from './shell';

export type Phase = 'none' | 'thinking' | 'streaming' | 'done' | 'error';

/** What the conversation reads from the page and tells it. */
export interface TalkHost {
  client(): Client | null;
  snapshot(): AgentsSnapshot | null;
  hovering(): boolean;
  /** Why nothing can be asked, for the conversation that has no agent. */
  missing(): string;
  /** The user's threads, as a request tells them (`watch.svelte.ts`); null when they cannot be read. */
  digest(): Promise<string | null>;
  /** The answer came, or the request failed. */
  settled(outcome: 'done' | 'error'): void;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Where each attachment was kept for the agent; null when one could not be, outside the shell. */
async function keepAll(attachments: Attachment[], fallback: string): Promise<string[] | null> {
  const paths: string[] = [];
  for (const attachment of attachments) {
    const path = await keepFile(bytesOf(attachment.data), attachment.name ?? fallback);
    if (path === null) return null;
    paths.push(path);
  }
  return paths;
}

export class Talk {
  phase = $state<Phase>('none');
  /** The text parts of the message streaming, by index, then the answer alone. */
  parts = $state<string[]>([]);
  problem = $state('');
  shown = $state(false);
  readonly reply = $derived(visibleReply(this.parts.filter(Boolean).join('')));
  readonly thinking = $derived(this.phase === 'thinking' || this.phase === 'streaming');

  /** The request waiting for its answer. */
  private sentId: string | null = null;
  private stopping = false;
  private replyId: string | null = null;
  // The message being written, part by part with each part's type: deltas also
  // stream reasoning and tool input, which the bubble leaves out. The bubble
  // keeps the previous message until this one has text.
  private buffer: string[] = [];
  private kinds: string[] = [];
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  /** `agentId` null: the companion has no agent, and the bubble says so. */
  constructor(
    readonly agentId: string | null,
    private readonly host: TalkHost
  ) {}

  /** The request waits for its answer: the page reads changes sooner. */
  get waiting(): boolean {
    return this.sentId !== null;
  }

  // -------------------------------------------------------------------------
  // Asking
  // -------------------------------------------------------------------------

  /** Sends a request, with the screen and the files dropped on the companion when given. False when it did not go. */
  async ask(request: string, shot: ScreenShot | null, files: Attachment[] = []): Promise<boolean> {
    const client = this.host.client();
    if (!request || !client || this.thinking) return false;
    this.problem = '';
    this.parts = [];
    this.buffer = [];
    this.kinds = [];
    this.replyId = null;
    this.stopping = false;
    this.phase = 'thinking';
    this.shown = true;
    clearTimeout(this.hideTimer);
    if (this.agentId === null) {
      this.fail(this.host.missing());
      return false;
    }
    try {
      // The threads' last answers are read while the images are kept.
      const digest = this.host.digest().catch(() => null);
      const shots = await keepAll(shot?.images ?? [], 'screen.jpg');
      const kept = await keepAll(files, 'file');
      if (shots === null || kept === null) {
        this.fail(strings.companion.cannotShow);
        return false;
      }
      const text = messageFor(request, { now: new Date(), seen: shot?.seen ?? null, shots, files: kept, threads: await digest });
      const message = await client.call('agents.message.send', { scope: directScope(this.agentId), text, recipientIds: [this.agentId], requestId: crypto.randomUUID() });
      this.sentId = message.id;
      return true;
    } catch (error) {
      this.fail(fill(strings.companion.failed, { reason: reasonOf(error) }));
      return false;
    }
  }

  /** Cancels the work the request gave the agent; before the core made it, the request is let go. */
  async stop(): Promise<void> {
    const client = this.host.client();
    if (!client || this.agentId === null || this.sentId === null) return;
    this.stopping = true;
    const work = workFor(this.host.snapshot(), this.agentId, this.sentId);
    if (!work || work.status === 'done' || workFailed(work)) return this.settleStopped();
    try {
      await client.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'cancel' });
    } catch {
      /* it ended meanwhile: its answer or its end comes with the next snapshot */
    }
  }

  /** After each read of the snapshot: the answer, or the work that ended without one. */
  follow(): void {
    if (this.agentId === null || this.sentId === null) return;
    const snapshot = this.host.snapshot();
    const answer = replyTo(snapshot, this.agentId, this.sentId);
    if (answer) return this.answered(answer);
    const work = workFor(snapshot, this.agentId, this.sentId);
    if (!work || !workFailed(work)) return;
    if (this.stopping) return this.settleStopped();
    this.fail(fill(strings.companion.failed, { reason: work.error ?? work.status }));
  }

  /** An answer of the agent's: the bubble shows it when it answers the request. */
  answered(message: AgentConversationMessage): void {
    if (this.sentId === null || message.replyTo !== this.sentId) return;
    this.sentId = null;
    this.problem = '';
    this.parts = [message.text];
    this.phase = 'done';
    this.shown = true;
    this.hold();
    this.host.settled('done');
  }

  /** The request did not go, or got no answer: the bubble says why. */
  fail(problem: string): void {
    this.sentId = null;
    this.shown = true;
    this.problem = problem;
    this.phase = 'error';
    this.hold();
    this.host.settled('error');
  }

  /** Stopped: what streamed stays a moment, or the bubble goes. */
  private settleStopped(): void {
    this.sentId = null;
    this.phase = this.reply ? 'done' : 'none';
    if (!this.reply) this.shown = false;
    this.hold();
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

  // -------------------------------------------------------------------------
  // The stream, from the thread the agent works in
  // -------------------------------------------------------------------------

  private showBuffer() {
    if (this.buffer.some(Boolean)) this.parts = [...this.buffer];
  }

  started(message: Message): void {
    if (message.role !== 'assistant' || !this.thinking || this.agentId === null) return;
    if (message.threadId !== sessionThreadOf(this.host.snapshot(), this.agentId)) return;
    this.replyId = message.id;
    this.kinds = message.parts.map((part) => part.type);
    this.buffer = message.parts.map((part) => (part.type === 'text' ? part.text : ''));
    this.showBuffer();
    this.phase = 'streaming';
  }

  delta({ messageId, partIndex, text }: RpcEvents['message.delta']): void {
    if (messageId !== this.replyId || !this.thinking) return;
    // A delta past the known parts opens a text part, as in the store.
    if ((this.kinds[partIndex] ??= 'text') !== 'text') return;
    this.buffer[partIndex] = (this.buffer[partIndex] ?? '') + text;
    this.showBuffer();
  }

  part({ messageId, partIndex, part }: RpcEvents['message.part']): void {
    if (messageId !== this.replyId || !this.thinking) return;
    this.kinds[partIndex] = part.type;
    this.buffer[partIndex] = part.type === 'text' ? part.text : '';
    this.showBuffer();
  }
}
