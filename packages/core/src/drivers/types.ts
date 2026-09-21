import type {
  Account,
  AccountId,
  AgentCommand,
  ImageAttachment,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  ModelInfo,
  Protocol,
  ProviderDescriptor,
  ProviderId,
  QuestionAnswer,
  QuestionOption,
  RequestId,
  ThreadId,
  ThreadSummary,
  Timestamp,
  Turn,
  Usage,
} from '@boite/contracts';
import type { SpawnedChild, SpawnedProcess, SpawnOptions } from '../procs.ts';

/**
 * The only way a driver writes anything. It journals and emits in one call, so
 * no driver ever touches SQLite or a socket.
 */
export interface EmitSink {
  startMessage(role: MessageRole): MessageId;
  delta(messageId: MessageId, partIndex: number, text: string): void;
  part(messageId: MessageId, partIndex: number, part: MessagePart): void;
  complete(messageId: MessageId, state: Message['state']): void;
}

/**
 * The decision, plus the id of the request that carries it, so a driver can
 * draw the permission card before the user has answered.
 */
export type PermissionTicket = Promise<'allow' | 'deny'> & { readonly requestId: RequestId };

/** What a driver hands the core to draw a question card. */
export interface QuestionAsk {
  text: string;
  options: QuestionOption[];
  /** True lets the user type an answer of their own beside the options. */
  allowText: boolean;
  multiple: boolean;
}

/**
 * The answer, plus the id of the question that carries it, so a driver can draw
 * the card before the user has answered. It resolves to null when the turn
 * ended or was stopped before an answer landed, which is what lets a driver
 * settle its own promise instead of hanging on the protocol.
 */
export type QuestionTicket = Promise<QuestionAnswer | null> & { readonly questionId: RequestId };

export interface TurnContext {
  thread: ThreadSummary;
  account: Account;
  provider: ProviderDescriptor;
  turn: Turn;
  prompt: string;
  /** An authenticated agent message at a safe tool boundary, never a user instruction. */
  coordination?(): string | null;
  /**
   * The images sent with the prompt, already checked by the core (format,
   * size, count, and the provider's `capabilities.images`). Empty for most
   * turns; a driver hands each one to its agent in that protocol's shape.
   */
  attachments: ImageAttachment[];
  sessionId: string | null;
  /** The isolation environment of this account, empty for the provider's own login. */
  accountEnv: Record<string, string>;
  /**
   * `warmProcessMinutes` as it stands when this turn starts. Zero means the
   * driver drops its process with the turn; above zero it may keep it for that
   * many minutes of idleness and give the next turn of the thread the same one.
   */
  warmProcessMinutes: number;
  emit: EmitSink;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * The `/name` commands the agent takes, whole, whenever the driver learns or
   * relearns them: the core keeps the list per thread and tells the clients
   * when it changed. Names are deduplicated, the first wins.
   */
  commands(list: AgentCommand[]): void;
  tasks?(list: import('@boite/contracts').AgentTask[]): void;
  /**
   * The context meter: what the agent's last request carried and the model's
   * window when the agent names it. The core writes it on the thread and
   * tells the clients; a driver calls it once per turn, at the end.
   */
  context(use: Omit<import('@boite/contracts').ContextUse, 'at'>): void;
  requestPermission(toolName: string, input: unknown, description: string | null): PermissionTicket;
  /** The inline question card. One call per question, and they are asked in order. */
  askQuestion(ask: QuestionAsk): QuestionTicket;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): SpawnedProcess;
  /** Same registry as `spawn`, node streams and node events, environment as given. */
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
  /**
   * Terminates every process this thread launched, grandchildren included,
   * through the registry that traced them. For a driver whose only stop is the
   * process itself: the agent's own tools die with it instead of outliving it.
   */
  killTree?(): void;
}

export interface TurnResult {
  status: 'done' | 'stopped' | 'error';
  sessionId: string | null;
  usage: Usage | null;
  error?: string;
}

export interface TurnHandle {
  done: Promise<TurnResult>;
  stop(): void;
  /** False means not ready, rejection means uncertain dispatch and must not be replayed. */
  steer?(message: string): Promise<boolean>;
}

/**
 * What a probe is given. No thread and no turn: it asks one agent process what
 * it can run, under the account's environment, and writes nothing.
 */
export interface ProbeContext {
  provider: ProviderDescriptor;
  accountId: AccountId;
  /** The isolation environment of this account, empty for the provider's own login. */
  accountEnv: Record<string, string>;
  /** The core's data directory: the probe session belongs to no project. */
  cwd: string;
  /** The registry that traces the probe process, under the thread `probe:<providerId>:<accountId>`. */
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
  /** Terminates whatever that synthetic thread launched. Called on every path. */
  killTree(): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface ProbeResult {
  models: ModelInfo[];
  probedAt: Timestamp;
}

/**
 * What a title is written from. No turn and no message sink: the driver asks
 * its agent for a few words and answers them, or null when it has none to
 * give, and the core falls back to the first line of the prompt.
 */
export interface TitleContext {
  thread: ThreadSummary;
  provider: ProviderDescriptor;
  account: Account;
  /** The isolation environment of this account, empty for the provider's own login. */
  accountEnv: Record<string, string>;
  /** The first prompt of the thread, its text parts only. */
  prompt: string;
  /** The first answer of the thread, its text parts only. Empty when the agent wrote no text. */
  answer: string;
  /** Traced under the thread the title is for, like a turn's process. */
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/** Which cached probes to drop. An empty filter drops them all. */
export interface ProbeFilter {
  providerId?: ProviderId;
  accountId?: AccountId;
}

export interface Driver {
  protocol: Protocol;
  startTurn(ctx: TurnContext): TurnHandle;
  /**
   * The models the agent itself lists, for a protocol whose descriptor cannot
   * know them. Cached per provider and account; two callers at once share one
   * agent process.
   */
  probe?(ctx: ProbeContext): Promise<ProbeResult>;
  /** What the last probe read, without running one. Null when nothing was probed. */
  probedModels?(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null;
  /** Drop cached probes: a reload, a changed account, a removed one. */
  forgetProbes?(filter?: ProbeFilter): void;
  /**
   * A title for the thread, in the agent's own words. A driver without one
   * leaves the title to the core's cut of the prompt, and one that answers
   * null or throws gets the same fallback, with the error on the log.
   */
  title?(ctx: TitleContext): Promise<string | null>;
  /** Drop whatever this thread keeps alive between turns: a warm process, a session. */
  releaseThread?(threadId: ThreadId): void;
  /** Core shutdown: drop what every thread keeps alive between turns. */
  shutdown?(): void;
}
