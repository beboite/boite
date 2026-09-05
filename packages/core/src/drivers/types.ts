import type {
  Account,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  Protocol,
  ProviderDescriptor,
  RequestId,
  ThreadSummary,
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

export interface TurnContext {
  thread: ThreadSummary;
  account: Account;
  provider: ProviderDescriptor;
  turn: Turn;
  prompt: string;
  sessionId: string | null;
  /** The isolation environment of this account, empty for the provider's own login. */
  accountEnv: Record<string, string>;
  emit: EmitSink;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  requestPermission(toolName: string, input: unknown, description: string | null): PermissionTicket;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): SpawnedProcess;
  /** Same registry as `spawn`, node streams and node events, environment as given. */
  spawnChild(cmd: string, args: string[], opts?: SpawnOptions): SpawnedChild;
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
}

export interface Driver {
  protocol: Protocol;
  startTurn(ctx: TurnContext): TurnHandle;
}
