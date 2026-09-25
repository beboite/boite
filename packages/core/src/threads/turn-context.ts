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
import { prepareAttachments, fileReference } from '../attachments.ts';
import { continuationInput } from '../continuation.ts';
import type { Core } from '../core.ts';
import type { EmitSink, PermissionTicket, QuestionAsk, QuestionTicket, TurnContext } from '../drivers/types.ts';
import { newId } from '../ids.ts';
import type { SpawnedChild, SpawnOptions } from '../procs.ts';
import type { ThreadStore } from '../threads.ts';
import { systemOperation } from './operations.ts';

/**
 * The parts of a turn's prompt that building it consumes: the async answers
 * held for the thread and the delegation letters it marks as sent. A retry on
 * a fresh session reuses them instead of taking again and finding nothing.
 */
export interface CarriedInput {
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
    const emit: EmitSink = {
      startMessage: (role: MessageRole): MessageId => {
        const message: Message = {
          id: newId('msg_'),
          threadId,
          turnId: turn.id,
          role,
          parts: [],
          state: 'streaming',
          createdAt: Date.now(),
        };
        this.core.journal.append({ type: 'message.started', threadId, version: 1, payload: message }, () => {
          this.core.journal.putMessage(message);
        });
        this.core.bus.emit('message.started', message);
        return message.id;
      },
      delta: (messageId: MessageId, partIndex: number, text: string): void => {
        this.core.journal.appendDelta(threadId, messageId, partIndex, text);
        this.core.bus.emit('message.delta', { threadId, messageId, partIndex, text });
      },
      part: (messageId: MessageId, partIndex: number, raw: MessagePart): void => {
        const part = stamp(messageId, partIndex, raw);
        this.core.journal.append(
          { type: 'message.part', threadId, version: 1, payload: { messageId, partIndex, part } },
          () => {
            this.core.journal.setMessagePart(messageId, partIndex, part);
          },
        );
        this.core.bus.emit('message.part', { threadId, messageId, partIndex, part });
      },
      complete: (messageId: MessageId, state: Message['state']): void => {
        this.core.journal.append(
          { type: 'message.completed', threadId, version: 1, payload: { messageId, state } },
          () => {
            this.core.journal.setMessageState(messageId, state);
          },
        );
        this.core.bus.emit('message.completed', { threadId, messageId, state });
      },
    };

    const input = this.lastUserInput(threadId, turn.id);
    const carry = (): { prompt: string; attachments: Attachment[] } =>
      continuationInput(this.core.journal, threadId, turn.id, input, provider, part => fileReference(this.core.dataDir, part));
    const continued = !thread.agentSessionId && thread.sessionId === null && (thread.sessionGeneration ?? 0) > 0 ? carry() : input;
    const prepared = prepareAttachments(this.core.dataDir, continued);
    const operation = turn.execution?.operation;
    const slash = (prompt: string): boolean => prompt.trimStart().startsWith('/');
    // Both are taken once per turn: a second context for the same turn (the
    // core's retry on a fresh session) and a driver's `continuation` get what
    // the first one took.
    carried.deferred ??= operation || slash(prepared.prompt) ? '' : this.threads.deferred.takeDeferred(threadId);
    carried.letters ??= operation === 'compact' ? '' : this.core.delegation.initialInput(threadId, turn.id);
    const deferred = carried.deferred;
    const tail = operation === 'compact' ? '' : this.core.coordination.instructions(threadId) + this.core.delegation.instructions(threadId) + carried.letters;
    const compose = (body: string, sessionId: string | null): string =>
      ((operation && sessionId !== null) || slash(body) ? '' : this.core.brain.instructions(provider.id)) + deferred + body + tail + this.threads.cards.askInstructions({ ...thread, sessionId }, provider, turn, body);
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
      coordination: () => this.core.delegation.take(threadId, turn.id) ?? this.core.coordination.take(threadId, turn.id),
      attachments: prepared.attachments,
      sessionId: thread.sessionId,
      sessionBefore: this.sessionBefore(thread, turn.id),
      accountEnv: env,
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      emit,
      log: (level, message) => {
        this.core.log(level, message);
      },
      commands: (list: AgentCommand[]) => {
        if ((this.threads.require(threadId).sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)) this.threads.agentState.noteCommands(threadId, list);
      },
      context: (use) => {
        if ((this.threads.require(threadId).selectionVersion ?? 0) === (thread.selectionVersion ?? 0)) this.threads.agentState.noteContext(threadId, use);
      },
      tasks: (list) => this.core.activity.tasks(threadId, list),
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
  private lastUserInput(threadId: ThreadId, turnId: TurnId): { prompt: string; attachments: Attachment[] } {
    const operation = this.core.journal.getTurn(turnId)?.execution?.operation;
    const message = systemOperation(operation)
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
      return {
        prompt: message.parts.map((part) => part.type === 'text' ? part.activity ? activityPrompt(part.activity.kind, part.text, part.activity.iteration) : part.text : '').join(''),
        attachments,
      };
    }
    return { prompt: '', attachments: [] };
  }
}
