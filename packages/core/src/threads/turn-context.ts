import type {
  Account,
  AgentCommand,
  Attachment,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  ProviderDescriptor,
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
    const current = (): boolean => this.core.journal.getThread(threadId)?.selectionVersion === thread.selectionVersion;
    return {
      thread, provider, account,
      sessionId: thread.sessionId,
      resumeAt: thread.sessionResumeAt ?? null,
      sessionBefore: this.sessionBefore(thread, ''),
      accountEnv: this.core.accounts.accountEnv(account, provider),
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      log: (level, message, context) => this.core.log(level, message, { ...context, source: provider.id, threadId }),
      commands: list => { if (current()) this.threads.agentState.noteCommands(threadId, list); },
      context: use => { if (current()) this.threads.agentState.noteContext(threadId, use); },
      hook: report => this.core.hooks.record({ providerId: provider.id, accountId: account.id, threadId }, report),
      spawnChild: this.leasedSpawnChild(threadId, provider),
      finishStartup: () => this.core.procs.finishStartup(threadId),
    };
  }

  makeContext(
    thread: ThreadSummary,
    provider: ProviderDescriptor,
    account: Account,
    turn: Turn,
    carried: CarriedInput = {},
  ): TurnContext {
    const threadId = thread.id;
    const env = this.core.accounts.accountEnv(account, provider);
    // When each tool card first showed up and when it stopped running, by slot.
    const toolTimes = new Map<string, { startedAt: number; finishedAt: number | null }>();
    const partProgress = new Map<string, { phase: import('@boite/contracts').ThreadProgress['phase']; detail: string | null }>();
    const progress = (phase: import('@boite/contracts').ThreadProgress['phase'], detail: string | null = null): void =>
      this.threads.progress.report(threadId, turn.id, phase, detail);
    const stamp = (messageId: MessageId, partIndex: number, part: MessagePart): MessagePart => {
      if (part.type === 'question' && part.async === true && (part.answer ?? null) === null && this.threads.cards.questions.has(part.questionId)) {
        this.threads.cards.asyncCards.set(part.questionId, { threadId, messageId, partIndex, part });
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
     * A driver writes its whole answer under one message id. Input the user
     * sends while the turn runs cuts that message: the next part the driver
     * opens starts a new one, so the timeline shows the user's message where
     * it arrived instead of under everything the turn wrote afterwards.
     */
    interface Segment { from: number; id: MessageId; open: boolean }
    const answers = new Map<MessageId, { role: MessageRole; top: number; segments: Segment[] }>();
    const open = (role: MessageRole, after: number | undefined): MessageId => {
      const message: Message = {
        id: newId('msg_'),
        threadId,
        turnId: turn.id,
        role,
        parts: [],
        state: 'streaming',
        // Strictly after the user's message, even within the same millisecond.
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
      const segment = answers.get(messageId)?.segments.findLast(one => one.from <= partIndex) ?? null;
      return segment ? { segment, messageId: segment.id, partIndex: partIndex - segment.from } : { segment: null, messageId, partIndex };
    };
    const userInputAt = this.threads.runner.userInputAt;
    const emit: EmitSink = {
      startMessage: (role: MessageRole): MessageId => {
        const after = userInputAt.get(turn.id);
        userInputAt.delete(turn.id);
        const id = open(role, after);
        answers.set(id, { role, top: -1, segments: [{ from: 0, id, open: true }] });
        return id;
      },
      delta: (driverId: MessageId, driverIndex: number, text: string): void => {
        const { messageId, partIndex } = route(driverId, driverIndex);
        const last = partProgress.get(`${messageId}:${partIndex}`);
        if (text.length) progress(last?.phase ?? 'working', last?.detail ?? null);
        this.core.journal.appendDelta(threadId, messageId, partIndex, text);
        this.core.bus.emit('message.delta', { threadId, messageId, partIndex, text });
      },
      part: (driverId: MessageId, driverIndex: number, raw: MessagePart): void => {
        const answer = answers.get(driverId);
        if (answer && driverIndex > answer.top) {
          const after = userInputAt.get(turn.id);
          if (after !== undefined) {
            userInputAt.delete(turn.id);
            // Nothing written yet: the message is created after the input anyway, or holds nothing to cut.
            if (answer.top >= 0 && answer.role === 'assistant') {
              const previous = answer.segments.at(-1)!;
              answer.segments.push({ from: driverIndex, id: open(answer.role, after), open: true });
              closeIdle(previous);
            }
          }
          answer.top = driverIndex;
        }
        const { segment, messageId, partIndex } = route(driverId, driverIndex);
        const boundary = raw.type === 'tool' && raw.status !== 'running' && toolTimes.get(`${messageId}:${partIndex}`)?.finishedAt == null;
        const stamped = stamp(messageId, partIndex, raw);
        // The agent calls a compaction it was asked for `manual`; one the core asked for by itself is not the user's.
        const part: MessagePart = stamped.type === 'compaction' && turn.execution?.automatic ? { ...stamped, trigger: 'auto' } : stamped;
        const phase = part.type === 'thinking' ? 'thinking' : part.type === 'tool' && part.status === 'running' ? 'tool' : 'working';
        const detail = part.type === 'tool' && part.status === 'running' ? part.name : null;
        partProgress.set(`${messageId}:${partIndex}`, { phase, detail });
        progress(phase, detail);
        this.core.journal.append(
          { type: 'message.part', threadId, version: 1, payload: { messageId, partIndex, part } },
          () => {
            this.core.journal.setMessagePart(messageId, partIndex, part);
          },
        );
        this.core.bus.emit('message.part', { threadId, messageId, partIndex, part });
        if (boundary) this.core.bus.emit('turn.toolCompleted', { threadId, turnId: turn.id, boundary: `${messageId}:${partIndex}` });
        if (segment && answer && segment !== answer.segments.at(-1)) closeIdle(segment);
      },
      complete: (driverId: MessageId, state: Message['state']): void => {
        for (const segment of answers.get(driverId)?.segments ?? []) close(segment, state);
      },
    };

    const input = this.lastUserInput(threadId, turn.id);
    const carry = (): { prompt: string; attachments: Attachment[] } =>
      continuationInput(this.core.journal, threadId, turn.id, input, provider, part => fileReference(this.core.dataDir, part));
    const continued = !thread.agentSessionId && thread.sessionId === null && (thread.sessionGeneration ?? 0) > 0 ? carry() : input;
    const prepared = prepareAttachments(this.core.dataDir, continued);
    const operation = turn.execution?.operation;
    // Both are taken once per turn: a second context for the same turn (the
    // core's retry on a fresh session) and a driver's `continuation` get what
    // the first one took.
    carried.deferred ??= operation || nativeCommandPrompt(prepared.prompt) ? '' : this.threads.deferred.takeDeferred(threadId);
    carried.memory ??= this.threads.deferred.memory.take(threadId);
    carried.letters ??= operation === 'compact' ? '' : this.core.delegation.initialInput(threadId, turn.id);
    const deferred = carried.deferred;
    const tail = operation === 'compact' ? '' : this.core.delegation.instructions(threadId, prepared.prompt) + carried.letters;
    const compose = (body: string, sessionId: string | null): string => {
      const inject = !((operation && sessionId !== null) || nativeCommandPrompt(body));
      // Echo treats "question" as a test directive, including in injected help.
      const guideEnabled = this.core.brain.config().boiteGuide !== false;
      const coordinationGuide = inject && operation !== 'compact' && guideEnabled ? this.core.coordination.instructions(threadId) : '';
      const guide = inject && sessionId === null && guideEnabled
        ? agentGuide(provider.protocol !== 'echo' && this.core.settings.get().asyncQuestions !== false) : '';
      const prefix = (inject ? this.core.brain.instructions(provider.id) : '') + guide;
      return carried.memory + prefix + (prefix ? 'User request:\n' : '') + deferred + body + coordinationGuide + tail + this.threads.cards.askInstructions({ ...thread, sessionId }, provider, turn, body);
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
      log: (level, message, context) => {
        this.core.log(level, message, { ...context, source: provider.id, threadId, turnId: turn.id });
      },
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
      background: (list) => {
        if ((this.core.journal.getThread(threadId)?.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)) this.threads.agentState.noteBackground(threadId, list);
      },
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
      spawnChild: this.leasedSpawnChild(threadId, provider),
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
  ): (cmd: string, args: string[], opts?: SpawnOptions) => SpawnedChild {
    return (cmd, args, opts) => {
      // The SDK drivers hand a whole environment here, so the agent's own
      // variables are merged onto theirs rather than added to `process.env`.
      const child = this.core.procs.spawnChild(threadId, cmd, args, {
        ...opts,
        env: agentEnvOf(this.core, threadId, opts?.env ?? process.env),
      });
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

  /** The user message of the turn, read back from the journal: the text and the images it carried. */
  private lastUserInput(threadId: ThreadId, turnId: TurnId): { prompt: string; attachments: Attachment[]; moved?: true } {
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
      return {
        prompt: note + message.parts.map((part) => part.type === 'text' ? part.activity ? activityPrompt(part.activity.kind, part.text, part.activity.iteration) : part.text : '').join(''),
        attachments,
        ...(note ? { moved: true as const } : {}),
      };
    }
    return { prompt: '', attachments: [] };
  }
}
