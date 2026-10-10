import { builtinSkills } from '../builtin-skills.ts';
import type {
  Account,
  AgentCommand,
  Attachment,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  ProviderDescriptor,
  SentFrom,
  ThreadId,
  ThreadSummary,
  Turn,
  TurnId,
} from '@boite/contracts';
import { activityPrompt } from '../activity-prompt.ts';
import { agentEnvOf } from '../agent.ts';
import { agentGuide } from '../agent-guide.ts';
import { prepareAttachments, fileReference } from '../attachments.ts';
import { continuationInput } from '../continuation.ts';
import type { Core } from '../core.ts';
import type { EmitSink, PermissionTicket, QuestionAsk, QuestionTicket, SessionContext, TurnContext } from '../drivers/types.ts';
import { newId } from '../ids.ts';
import type { SpawnedChild, SpawnOptions } from '../procs.ts';
import { noteStderr } from '../drivers/stderr-tail.ts';
import { watchProviderProcess } from './provider-process-log.ts';
import type { ThreadStore } from '../threads.ts';
import { nativeCommandPrompt, systemOperation } from './operations.ts';

/**
 * The parts of a turn's prompt that building it consumes: the async answers
 * held for the thread and the delegation letters it marks as sent. A retry on
 * a fresh session reuses them instead of taking again and finding nothing.
 */
export interface CarriedInput {
  memory?: string;
  deferred?: string;
  letters?: string;
}

/**
 * What a driver gets to run one turn: the prompt as built from the journal,
 * the sinks its output goes through, and the spawns that carry the thread
 * into every process it launches.
 */
export class TurnContexts {
  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /** Setup only: no journalled turn, no consumed deferred input and no message sink. */
  makeSessionContext(thread: ThreadSummary, provider: ProviderDescriptor, account: Account): SessionContext {
    const threadId = thread.id;
    const backgroundOwner = { providerId: provider.id, sessionGeneration: thread.sessionGeneration ?? 0, parentTurnId: null };
    const current = (): boolean => this.core.journal.getThread(threadId)?.selectionVersion === thread.selectionVersion;
    return {
      thread, provider, account,
      sessionId: thread.sessionId,
      resumeAt: thread.sessionResumeAt ?? null,
      sessionBefore: this.sessionBefore(thread, ''),
      accountEnv: this.core.accounts.accountEnv(account, provider),
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      log: (level, message, context) => {
        if (context?.kind === 'provider-output') noteStderr(threadId, message);
        this.core.log(level, message, { ...context, source: provider.id, threadId });
      },
      diagnostic: (level, message, context) => this.core.logs.record(level, message, { ...context, source: provider.id, threadId }),
      authenticationFailed: () => this.core.accounts.authenticationFailed(account.id),
      commands: list => { if (current()) this.threads.agentState.noteCommands(threadId, list); },
      context: use => { if (current()) this.threads.agentState.noteContext(threadId, use); },
      hook: report => this.core.hooks.record({ providerId: provider.id, accountId: account.id, threadId }, report),
      background: list => this.threads.agentState.noteBackground(threadId, list, backgroundOwner),
      backgroundFinished: (id, state) => this.threads.agentState.finishBackground(threadId, id, backgroundOwner, state),
      spawnChild: this.leasedSpawnChild(threadId, provider, { resume: thread.sessionId !== null }),
      finishStartup: () => this.core.procs.finishStartup(threadId),
    };
  }

  makeContext(
    thread: ThreadSummary,
    provider: ProviderDescriptor,
    account: Account,
    turn: Turn,
    carried: CarriedInput = {},
    resumePrompt?: string,
  ): TurnContext {
    const threadId = thread.id;
    const backgroundOwner = { providerId: provider.id, sessionGeneration: thread.sessionGeneration ?? 0, parentTurnId: turn.id };
    const env = this.core.accounts.accountEnv(account, provider);
    // When each tool card first showed up and when it stopped running, by slot.
    const toolTimes = new Map<string, { startedAt: number; finishedAt: number | null }>();
    const partProgress = new Map<string, { phase: import('@boite/contracts').ThreadProgress['phase']; detail: string | null }>();
    const progress = (phase: import('@boite/contracts').ThreadProgress['phase'], detail: string | null = null): void =>
      this.threads.progress.report(threadId, turn.id, phase, detail);
    const thinking = new Map<MessageId, { index: number; startedAt: number }>();
    const publishPart = (messageId: MessageId, partIndex: number, part: MessagePart): void => {
      this.core.journal.append(
        { type: 'message.part', threadId, version: 1, payload: { messageId, partIndex, part } },
        () => this.core.journal.setMessagePart(messageId, partIndex, part),
      );
      this.core.bus.emit('message.part', { threadId, messageId, partIndex, part });
    };
    const finishThinking = (messageId: MessageId, nextIndex = Infinity): void => {
      const active = thinking.get(messageId);
      if (!active || nextIndex <= active.index) return;
      thinking.delete(messageId);
      const part = this.core.journal.getMessage(messageId)?.parts[active.index];
      if (part?.type === 'thinking') publishPart(messageId, active.index, {
        ...part, startedAt: active.startedAt, finishedAt: Date.now(),
      });
    };
    const stamp = (messageId: MessageId, partIndex: number, part: MessagePart): MessagePart => {
      if (part.type === 'question' && part.async === true && (part.answer ?? null) === null && this.threads.cards.questions.has(part.questionId)) {
        this.threads.cards.asyncCards.set(part.questionId, { threadId, messageId, partIndex, part });
      }
      if (part.type === 'thinking') {
        const stored = this.core.journal.getMessage(messageId)?.parts[partIndex];
        const startedAt = stored?.type === 'thinking' ? stored.startedAt ?? Date.now() : part.startedAt ?? Date.now();
        const finishedAt = stored?.type === 'thinking' ? stored.finishedAt ?? part.finishedAt ?? null : part.finishedAt ?? null;
        if (finishedAt === null) thinking.set(messageId, { index: partIndex, startedAt });
        return { ...part, startedAt, finishedAt };
      }
      if (part.type !== 'tool') return part;
      const key = `${messageId}:${partIndex}`;
      const now = Date.now();
      const seen = toolTimes.get(key) ?? { startedAt: part.startedAt ?? now, finishedAt: null };
      if (part.status !== 'running' && seen.finishedAt === null) seen.finishedAt = part.finishedAt ?? now;
      toolTimes.set(key, seen);
      return { ...part, startedAt: seen.startedAt, finishedAt: seen.finishedAt };
    };
    /**
     * A driver writes its whole answer under one message id. A user follow-up,
     * agent exchange or published file cuts it: new parts and continued text start
     * after it, while existing tools keep their original cards.
     */
    interface Segment { id: MessageId; open: boolean; next: number }
    interface Slot { segment: Segment; partIndex: number; skip: number; length: number; type: MessagePart['type'] }
    interface Answer { role: MessageRole; segments: Segment[]; parts: Map<number, Slot> }
    const answers = new Map<MessageId, Answer>();
    const open = (role: MessageRole, after: number | undefined): MessageId => {
      if (role === 'assistant') for (const messageId of thinking.keys()) finishThinking(messageId);
      const message: Message = {
        id: newId('msg_'),
        threadId,
        turnId: turn.id,
        role,
        parts: [],
        state: 'streaming',
        // Strictly after the standalone message, even within the same millisecond.
        createdAt: Math.max(Date.now(), after === undefined ? 0 : after + 1),
      };
      this.core.journal.append({ type: 'message.started', threadId, version: 1, payload: message }, () => {
        this.core.journal.putMessage(message);
      });
      this.core.bus.emit('message.started', message);
      return message.id;
    };
    const close = (segment: Segment, state: Message['state']): void => {
      if (!segment.open) return;
      finishThinking(segment.id);
      segment.open = false;
      this.core.journal.append(
        { type: 'message.completed', threadId, version: 1, payload: { messageId: segment.id, state } },
        () => {
          this.core.journal.setMessageState(segment.id, state);
        },
      );
      this.core.bus.emit('message.completed', { threadId, messageId: segment.id, state });
    };
    /** A cut segment stays open only while one of its tools still runs. */
    const closeIdle = (segment: Segment): void => {
      for (const [key, times] of toolTimes) if (times.finishedAt === null && key.startsWith(`${segment.id}:`)) return;
      close(segment, 'complete');
    };
    const route = (messageId: MessageId, partIndex: number): { segment: Segment | null; messageId: MessageId; partIndex: number } => {
      const slot = answers.get(messageId)?.parts.get(partIndex);
      return slot ? { segment: slot.segment, messageId: slot.segment.id, partIndex: slot.partIndex } : { segment: null, messageId, partIndex };
    };
    const answerAfter = this.threads.runner.answerAfter;
    const cut = (answer: Answer, after: number): Segment => {
      answerAfter.delete(turn.id);
      const previous = answer.segments.at(-1)!;
      if (answer.parts.size === 0 || answer.role !== 'assistant') return previous;
      const segment: Segment = { id: open(answer.role, after), open: true, next: 0 };
      answer.segments.push(segment);
      closeIdle(previous);
      return segment;
    };
    const continueText = (driverId: MessageId, driverIndex: number, slot: Slot): Slot => {
      const answer = answers.get(driverId)!;
      const after = answerAfter.get(turn.id);
      const segment = after === undefined ? answer.segments.at(-1)! : cut(answer, after);
      const continued: Slot = { ...slot, segment, partIndex: segment.next++, skip: slot.skip + slot.length, length: 0 };
      answer.parts.set(driverIndex, continued);
      emit.part(driverId, driverIndex, { type: slot.type as 'text' | 'thinking', text: '' });
      return continued;
    };
    const emit: EmitSink = {
      startMessage: (role: MessageRole): MessageId => {
        const after = answerAfter.get(turn.id);
        answerAfter.delete(turn.id);
        const id = open(role, after);
        answers.set(id, { role, segments: [{ id, open: true, next: 0 }], parts: new Map() });
        return id;
      },
      delta: (driverId: MessageId, driverIndex: number, text: string): void => {
        const answer = answers.get(driverId);
        let slot = answer?.parts.get(driverIndex);
        if (text.length && slot && (slot.type === 'text' || slot.type === 'thinking') && answer?.role === 'assistant'
          && (answerAfter.has(turn.id) || slot.segment !== answer.segments.at(-1))) {
          slot = continueText(driverId, driverIndex, slot);
        }
        if (slot) slot.length += text.length;
        const { messageId, partIndex } = route(driverId, driverIndex);
        finishThinking(messageId, partIndex);
        const last = partProgress.get(`${messageId}:${partIndex}`);
        if (text.length) progress(last?.phase ?? 'working', last?.detail ?? null);
        this.core.journal.appendDelta(threadId, messageId, partIndex, text);
        this.core.bus.emit('message.delta', { threadId, messageId, partIndex, text });
      },
      part: (driverId: MessageId, driverIndex: number, raw: MessagePart): void => {
        const answer = answers.get(driverId);
        if (answer && !answer.parts.has(driverIndex)) {
          const after = answerAfter.get(turn.id);
          const segment = after === undefined ? answer.segments.at(-1)! : cut(answer, after);
          answer.parts.set(driverIndex, { segment, partIndex: segment.next++, skip: 0, length: 0, type: raw.type });
        }
        let slot = answer?.parts.get(driverIndex);
        if (slot && (raw.type === 'text' || raw.type === 'thinking')) {
          if (answer?.role === 'assistant' && raw.text.length > slot.skip + slot.length
            && (answerAfter.has(turn.id) || slot.segment !== answer.segments.at(-1))) slot = continueText(driverId, driverIndex, slot);
          raw = { ...raw, text: raw.text.slice(slot.skip) };
          slot.length = raw.text.length;
        }
        const { segment, messageId, partIndex } = route(driverId, driverIndex);
        finishThinking(messageId, partIndex);
        const boundary = raw.type === 'tool' && raw.status !== 'running' && toolTimes.get(`${messageId}:${partIndex}`)?.finishedAt == null;
        const stamped = stamp(messageId, partIndex, raw);
        // The agent calls a compaction it was asked for `manual`; one the core asked for by itself is not the user's.
        const part: MessagePart = stamped.type === 'compaction' && turn.execution?.automatic ? { ...stamped, trigger: 'auto' } : stamped;
        const phase = part.type === 'thinking' ? 'thinking' : part.type === 'tool' && part.status === 'running' ? 'tool' : 'working';
        const detail = part.type === 'tool' && part.status === 'running' ? part.name : null;
        partProgress.set(`${messageId}:${partIndex}`, { phase, detail });
        progress(phase, detail);
        publishPart(messageId, partIndex, part);
        if (boundary) this.core.bus.emit('turn.toolCompleted', { threadId, turnId: turn.id, boundary: `${messageId}:${partIndex}` });
        if (segment && answer && segment !== answer.segments.at(-1)) closeIdle(segment);
      },
      complete: (driverId: MessageId, state: Message['state']): void => {
        for (const segment of answers.get(driverId)?.segments ?? []) close(segment, state);
      },
    };

    // A turn resumed after an agent update goes on from its own messages: the
    // prompt is the resume note, and a fresh session reads this turn's work too.
    const input = resumePrompt !== undefined ? { prompt: resumePrompt, attachments: [] } : this.lastUserInput(threadId, turn.id);
    const history = (): { prompt: string; attachments: Attachment[] } =>
      continuationInput(this.core.journal, threadId, resumePrompt !== undefined ? null : turn.id, input, provider, part => fileReference(this.core.dataDir, part));
    // Read once for a resume, before its note lands: a later fresh start would otherwise carry the note twice.
    const resumedHistory = resumePrompt !== undefined ? history() : null;
    const carry = (): { prompt: string; attachments: Attachment[] } => resumedHistory ?? history();
    const fresh = !thread.agentSessionId && thread.sessionId === null && ((thread.sessionGeneration ?? 0) > 0 || resumePrompt !== undefined);
    const continued = fresh ? carry() : input;
    const prepared = prepareAttachments(this.core.dataDir, continued);
    const operation = turn.execution?.operation;
    // Both are taken once per turn: a second context for the same turn (the
    // core's retry on a fresh session) and a driver's `continuation` get what
    // the first one took.
    carried.deferred ??= operation || nativeCommandPrompt(prepared.prompt) ? '' : this.threads.deferred.takeDeferred(threadId);
    carried.memory ??= this.threads.deferred.memory.take(threadId);
    carried.letters ??= operation === 'compact' ? '' : this.core.delegation.initialInput(threadId, turn.id);
    const deferred = carried.deferred;
    // The subagent guide comes with the Boite guide on a fresh session, and on any turn about delegation.
    // Core-woken turns (results, workflow summaries) bring no request of their own.
    const tail = (fresh: boolean): string => operation === 'compact' ? '' : this.core.delegation.instructions(threadId, operation ? '' : prepared.prompt, fresh) + carried.letters;
    const origin = input.sentFrom;
    const compose = (body: string, sessionId: string | null): string => {
      const inject = !((operation && sessionId !== null) || nativeCommandPrompt(body));
      // Echo treats "question" as a test directive, including in injected help.
      const guideEnabled = this.core.brain.config().boiteGuide !== false;
      // Said when a session starts and when the user changes app or computer, not on every turn.
      // Boite's own text, so the guide switch turns it off with the rest.
      const said = origin && inject && guideEnabled && (sessionId === null || !sameOrigin(origin, this.sentFromBefore(threadId, origin.messageId)))
        ? sentFromNote(origin.from) : '';
      const coordinationGuide = inject && operation !== 'compact' && guideEnabled ? this.core.coordination.instructions(threadId) + this.core.stewards.instructions(threadId) + this.core.workforce.entrusted.instructions(threadId) : '';
      const guide = inject && sessionId === null && guideEnabled
        ? agentGuide(provider.protocol !== 'echo' && this.core.settings.get().asyncQuestions !== false, this.core.settings.get().agentLogAccess === false ? [] : builtinSkills(this.core.dataDir, message => this.core.logs.warn(message, { source: 'skills', event: 'skills.write-failed' }))) : '';
      const prefix = (inject ? this.core.brain.instructions(provider.id) : '') + guide;
      return carried.memory + prefix + (prefix ? 'User request:\n' : '') + said + deferred + body + coordinationGuide + tail(inject && sessionId === null && guideEnabled) + this.threads.cards.askInstructions({ ...thread, sessionId }, provider, turn, body);
    };
    return {
      thread,
      account,
      provider,
      turn,
      prompt: compose(prepared.prompt, thread.sessionId),
      continuation: () => {
        const fresh = prepareAttachments(this.core.dataDir, carry());
        return { prompt: compose(fresh.prompt, null), attachments: fresh.attachments };
      },
      coordination: () => this.core.delegation.take(threadId, turn.id) ?? this.core.coordination.take(threadId, turn.id)
        ?? this.threads.deferred.takeForRunningTurn(threadId),
      attachments: prepared.attachments,
      sessionId: thread.sessionId,
      resumeAt: thread.sessionId === null ? null : thread.sessionResumeAt ?? null,
      sessionBefore: this.sessionBefore(thread, turn.id),
      accountEnv: env,
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      emit,
      reportProgress: progress,
      reportProviderEvent: () => this.threads.progress.contact(threadId, turn.id),
      authenticationFailed: () => this.core.accounts.authenticationFailed(account.id),
      log: (level, message, context) => {
        if (context?.kind === 'provider-output') noteStderr(threadId, message);
        this.core.log(level, message, { ...context, source: provider.id, threadId, turnId: turn.id });
      },
      diagnostic: (level, message, context) => this.core.logs.record(level, message, { ...context, source: provider.id, threadId, turnId: turn.id }),
      commands: (list: AgentCommand[]) => {
        if ((this.threads.require(threadId).sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)) this.threads.agentState.noteCommands(threadId, list);
      },
      context: (use) => {
        if ((this.threads.require(threadId).selectionVersion ?? 0) === (thread.selectionVersion ?? 0)) this.threads.agentState.noteContext(threadId, use);
      },
      quota: (reading, observedAt) => this.core.quotas.observe(account.id, reading, observedAt),
      tasks: (list) => this.core.activity.tasks(threadId, list),
      hook: (report) => {
        this.core.hooks.record({ providerId: provider.id, accountId: account.id, threadId }, report);
      },
      background: list => this.threads.agentState.noteBackground(threadId, list, backgroundOwner),
      backgroundFinished: (id, state) => this.threads.agentState.finishBackground(threadId, id, backgroundOwner, state),
      wake: (text) => this.threads.deferred.wake(threadId, text),
      requestPermission: (toolName: string, input: unknown, description: string | null): PermissionTicket =>
        this.threads.cards.requestPermission(thread, turn, toolName, input, description),
      askQuestion: (ask: QuestionAsk): QuestionTicket => this.threads.cards.askQuestion(thread, turn, ask),
      withdrawQuestion: (questionId) => {
        this.threads.cards.withdrawQuestion(threadId, questionId);
      },
      // Every driver reaches the launcher through these two, so this is the one
      // place a lease on the provider's managed files can be held for the life
      // of an agent process, warm sessions included. `providers.uninstall`
      // refuses while the count is above zero. It is also where the thread's
      // own door goes into the environment: everything a thread launches finds
      // the core, its token and the `boite` CLI, grandchildren included.
      spawn: (cmd: string, args: string[], opts?: SpawnOptions) => {
        const spawned = this.core.procs.spawn(threadId, cmd, args, {
          ...opts,
          env: agentEnvOf(this.core, threadId, { ...(opts?.env ?? process.env), ...env }),
        });
        const installs = this.core.providers.installs;
        installs.acquire(provider.id);
        void spawned.exited.finally(() => {
          installs.release(provider.id);
        });
        return spawned;
      },
      spawnChild: this.leasedSpawnChild(threadId, provider, { resume: thread.sessionId !== null, turnId: turn.id }),
      finishStartup: () => this.core.procs.finishStartup(threadId),
      killTree: () => {
        this.core.procs.killTree(threadId);
      },
    };
  }

  /** `procs.spawnChild` under the thread, holding the provider's install lease for the child's life. */
  leasedSpawnChild(
    threadId: ThreadId,
    provider: ProviderDescriptor,
    /** Set for a session's own agent process, which the log follows from spawn to exit. */
    session?: { resume: boolean; turnId?: TurnId },
  ): (cmd: string, args: string[], opts?: SpawnOptions) => SpawnedChild {
    return (cmd, args, opts) => {
      // The SDK drivers hand a whole environment here, so the agent's own
      // variables are merged onto theirs rather than added to `process.env`.
      const child = this.core.procs.spawnChild(threadId, cmd, args, {
        ...opts,
        env: agentEnvOf(this.core, threadId, opts?.env ?? process.env),
      });
      if (session !== undefined) watchProviderProcess(this.core, child, cmd, { threadId, providerId: provider.id, ...session });
      const installs = this.core.providers.installs;
      installs.acquire(provider.id);
      let released = false;
      const drop = (): void => {
        if (released) return;
        released = true;
        installs.release(provider.id);
      };
      child.once('exit', drop);
      child.once('error', drop);
      return child;
    };
  }

  /** What the agent session this turn resumes already used, summed over its recorded turns. */
  private sessionBefore(thread: ThreadSummary, turnId: TurnId): { costUsd: number; tokens: number } {
    const before = { costUsd: 0, tokens: 0 };
    if (thread.sessionId === null) return before;
    for (const earlier of this.core.journal.listTurns(thread.id)) {
      if (earlier.id === turnId || earlier.usage === null) continue;
      if (earlier.execution?.sessionGeneration !== (thread.sessionGeneration ?? 0)) continue;
      before.costUsd += earlier.usage.costUsdEquivalent ?? 0;
      before.tokens += earlier.usage.inputTokens + earlier.usage.outputTokens + earlier.usage.cacheReadTokens + earlier.usage.cacheWriteTokens;
    }
    return before;
  }

  /**
   * The origin of the newest earlier prompt that has one. A user message is
   * written whole, never streamed, so its stored parts are current. The text
   * filter only narrows: a prompt can quote the key, so each row is parsed.
   */
  private sentFromBefore(threadId: ThreadId, messageId: MessageId): SentFrom | null {
    const rows = this.core.journal.db.query(`SELECT parts FROM messages WHERE thread_id = ? AND role = 'user' AND parts LIKE '%"sentFrom":%'
      AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC`).iterate(threadId, messageId) as Iterable<{ parts: string }>;
    for (const row of rows) {
      const part = (JSON.parse(row.parts) as MessagePart[]).find(p => p.type === 'text' && p.sentFrom !== undefined);
      if (part?.type === 'text' && part.sentFrom) return part.sentFrom;
    }
    return null;
  }

  /** The user message of the turn, read back from the journal: the text and the images it carried. */
  private lastUserInput(threadId: ThreadId, turnId: TurnId): { prompt: string; attachments: Attachment[]; moved?: true; sentFrom?: { from: SentFrom; messageId: MessageId } } {
    const execution = this.core.journal.getTurn(turnId)?.execution;
    const message = systemOperation(execution?.operation) || execution?.automatic
      ? Array.from(this.core.journal.walkTurnMessages(threadId, turnId)).find(m => m.role === 'system') ?? null
      : this.core.journal.lastUserMessage(threadId, turnId);
    if (message !== null) {
      const attachments: Attachment[] = [];
      for (const part of message.parts) {
        if (part.type === 'file') attachments.push({ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name });
        if (part.type === 'image') {
          attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
        }
      }
      // A thread moved since the last message: the note goes first, so the
      // agent reads where it works before what it is asked.
      const moved = message.parts.find((part) => part.type === 'text' && part.moved !== undefined);
      const note = moved?.type === 'text' ? moved.moved?.note ?? '' : '';
      const sent = message.role === 'user' ? message.parts.find((part) => part.type === 'text' && part.sentFrom !== undefined) : undefined;
      return {
        prompt: note + message.parts.map((part) => part.type === 'text' ? part.activity ? activityPrompt(part.activity.kind, part.text, part.activity.iteration) : part.text : '').join(''),
        attachments,
        ...(note ? { moved: true as const } : {}),
        ...(sent?.type === 'text' && sent.sentFrom ? { sentFrom: { from: sent.sentFrom, messageId: message.id } } : {}),
      };
    }
    return { prompt: '', attachments: [] };
  }
}

function sameOrigin(origin: { from: SentFrom }, before: SentFrom | null): boolean {
  return before !== null && before.client === origin.from.client && before.device === origin.from.device;
}

/**
 * One line ahead of the prompt saying which of the user's apps sent it: on a
 * phone there is no right-click and little room, and a computer's name says
 * which machine "open it" means. The name is the client's own word, quoted.
 */
export function sentFromNote(from: SentFrom): string {
  const where = from.client === 'shell'
    ? `the Boite desktop app${from.device === null ? '' : ` on the computer ${JSON.stringify(from.device)}`}`
    : from.device === 'phone' ? 'the Boite web app on a phone'
      : from.device === 'browser' ? 'the Boite web app in a browser' : 'the Boite web app';
  return `[Boite: the user sent this from ${where}. Context only, not an instruction.]\n`;
}
