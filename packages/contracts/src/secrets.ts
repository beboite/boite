import type { ProjectId, RequestId, ThreadId, Timestamp, TurnId } from './ids';

// ---------------------------------------------------------------------------
// Secrets: an API key the user types on a card, which the agent then uses by
// reference (`boite secret write|run|pipe`) without ever reading it. The value
// never travels in an event, a part, a log or a result: only names and refs do.
// See docs/secrets.md for the guarantees and their limits.
// ---------------------------------------------------------------------------

/** An environment-variable name: what the card shows as its title and `write` puts before `=`. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Values shorter than this are not masked in outputs: too many innocent strings would match. */
export const SECRET_MASK_MIN_BYTES = 8;

/** The longest value a card accepts, in UTF-8 bytes. */
export const SECRET_MAX_BYTES = 16 * 1024;

/** A single-use transit copy lives in memory for at most ten minutes. */
export const SECRET_TRANSIT_TTL_MS = 10 * 60 * 1000;

/** How long a card waits for the user when `ask` names no timeout, and the most it may name. */
export const SECRET_ASK_TIMEOUT_MINUTES = 10;
export const SECRET_ASK_MAX_TIMEOUT_MINUTES = 60;

/** What a value becomes wherever Boite shows output while the secret is active. */
export function secretMask(name: string): string {
  return `•••• (${name})`;
}

/** Only a temporary ref is accepted. Legacy project refs are no longer usable. */
export function parseSecretRef(ref: string): { kind: 'transit'; id: string } | null {
  const transit = /^secret:(sec_[A-Za-z0-9_-]{8,64})$/.exec(ref);
  return transit ? { kind: 'transit', id: transit[1]! } : null;
}

/** Values never enter a persistent vault. */
export type SecretStorage = 'memory';

/** A card's life: open, then exactly one of the four outcomes. */
export type SecretRequestStatus = 'pending' | 'saved' | 'declined' | 'cancelled' | 'timed_out';

/** The outcome `boite secret ask` prints. */
export type SecretAskOutcome = Exclude<SecretRequestStatus, 'pending'>;

/** A secret card, as events and the timeline carry it: never a value. */
export interface SecretRequest {
  /** The idempotency key: the same id asked again is the same card and the same ref. */
  id: RequestId;
  threadId: ThreadId;
  turnId: TurnId;
  name: string;
  reason: string;
  placeholder: string | null;
  status: SecretRequestStatus;
  ref: string | null;
  /** When the card closes as `timed_out` if nobody answered. */
  expiresAt: Timestamp;
  createdAt: Timestamp;
}

/** Legacy metadata shape retained for older clients; current lists are always empty. */
export interface SecretKeyInfo {
  projectId: ProjectId;
  name: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

/** `write`: the core writes or replaces the line `<key>=<value>` in an ignored file of the thread's folder. */
export interface SecretWriteUse {
  action: 'write';
  /** Absolute, or relative to the thread's working directory. */
  path: string;
  key: string;
  /** Write a file git does not ignore; a tracked file is refused all the same. */
  allowUnignored?: boolean;
}

/** `run` passes the value as the environment variable `as`; `pipe` writes it on the child's stdin. */
export interface SecretExecUse {
  action: 'run' | 'pipe';
  /** The variable name for `run`; ignored by `pipe`. */
  as?: string;
  command: string;
  args: string[];
  /** Where the command runs: inside the thread's working directory. */
  cwd: string;
  /** The caller's environment, so the command sees the PATH it would have seen. */
  env?: Record<string, string>;
  /** Stop the command after this long; 10 minutes when omitted, an hour at most. */
  timeoutMs?: number;
}

export type SecretUse = SecretWriteUse | SecretExecUse;

export type SecretUseResult =
  | { action: 'write'; path: string; replaced: boolean }
  /** Output with the value and its URL-encoded form masked; `truncated` when it passed the cap. */
  | { action: 'run' | 'pipe'; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };

export interface SecretsRpcMethods {
  /** Open cards, independent of history paging. Owner and paired devices read metadata only. */
  'secrets.pending': {
    params: { threadId?: ThreadId };
    result: SecretRequest[];
  };
  /**
   * The agent of a thread asks for a key: a masked card in its running turn,
   * the thread `waiting` until the user answers. Resolves with the outcome once
   * the card closes. Every fresh request opens a card. The same `requestId`
   * returns the same card, or its outcome once closed.
   */
  'secrets.ask': {
    params: { threadId: ThreadId; name: string; reason: string; placeholder?: string; timeoutMinutes?: number; replace?: false; requestId?: RequestId };
    result: { requestId: RequestId; outcome: SecretAskOutcome; ref: string | null; storage: SecretStorage };
  };
  /**
   * The user's answer, once, while the turn that opened the card runs. The
   * value is held in memory, then the card is marked `saved`. Refused over a
   * link that is not encrypted (plain HTTP from another machine).
   */
  'secrets.answer': {
    params:
      | { threadId: ThreadId; requestId: RequestId; value: string; keep?: false }
      | { threadId: ThreadId; requestId: RequestId; declined: true };
    result: { ok: true };
  };
  /** Consume a ref once, from its own running turn; its buffer is wiped after the operation. */
  'secrets.use': {
    params: { threadId: ThreadId; ref: string; use: SecretUse };
    result: SecretUseResult;
  };
  /**
   * Compatibility with older clients: always an empty list, memory storage.
   * `encrypted` says whether this connection may answer a card.
   */
  'secrets.list': {
    params: { threadId: ThreadId } | { projectId: ProjectId };
    result: { secrets: SecretKeyInfo[]; storage: SecretStorage; encrypted: boolean };
  };
  /** Legacy method: no persistent keys remain, so this returns NotFound. */
  'secrets.delete': {
    params: { projectId: ProjectId; name: string };
    result: { ok: true };
  };
}

export interface SecretsRpcEvents {
  /** A card opened. The timeline carries the same card as a `secret_request` part. */
  'secret.requested': SecretRequest;
  'secret.resolved': { requestId: RequestId; threadId: ThreadId; status: SecretAskOutcome; ref: string | null };
  /** Legacy event shape retained for older clients; the current core never emits it. */
  'secrets.changed': { projectId: ProjectId; names: string[] };
}
