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

/** How long a transit copy lives at most, from the moment it was saved. */
export const SECRET_TRANSIT_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a card waits for the user when `ask` names no timeout, and the most it may name. */
export const SECRET_ASK_TIMEOUT_MINUTES = 10;
export const SECRET_ASK_MAX_TIMEOUT_MINUTES = 60;

/** What a value becomes wherever Boite shows output while the secret is active. */
export function secretMask(name: string): string {
  return `•••• (${name})`;
}

/** The ref of a key kept for the project: `secret:project/<NAME>`. */
export function projectSecretRef(name: string): string {
  return `secret:project/${name}`;
}

/** `secret:<id>` for a transit copy, `secret:project/<NAME>` for a kept key; null for anything else. */
export function parseSecretRef(ref: string): { kind: 'transit'; id: string } | { kind: 'project'; name: string } | null {
  const project = /^secret:project\/([A-Z][A-Z0-9_]{0,63})$/.exec(ref);
  if (project) return { kind: 'project', name: project[1]! };
  const transit = /^secret:(sec_[A-Za-z0-9_-]{8,64})$/.exec(ref);
  return transit ? { kind: 'transit', id: transit[1]! } : null;
}

/**
 * Where saved values live on this machine. `memory` means no system vault was
 * reachable: values are lost when the core restarts, and the agent is told so.
 */
export type SecretStorage = 'dpapi' | 'keychain' | 'libsecret' | 'memory';

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
  /** The card replaces a key kept for the project once the user confirms. */
  replace: boolean;
  status: SecretRequestStatus;
  ref: string | null;
  /** When the card closes as `timed_out` if nobody answered. */
  expiresAt: Timestamp;
  createdAt: Timestamp;
}

/** A key kept for a project, as Settings lists it. */
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
   * the card closes. A name already kept for the project answers `saved` with
   * its project ref and draws nothing, unless `replace`. The same `requestId`
   * returns the same card, or its outcome once closed.
   */
  'secrets.ask': {
    params: { threadId: ThreadId; name: string; reason: string; placeholder?: string; timeoutMinutes?: number; replace?: boolean; requestId?: RequestId };
    result: { requestId: RequestId; outcome: SecretAskOutcome; ref: string | null; storage: SecretStorage };
  };
  /**
   * The user's answer, once, while the turn that opened the card runs. The
   * value is stored first, then the card is marked `saved`. Refused over a
   * link that is not encrypted (plain HTTP from another machine).
   */
  'secrets.answer': {
    params:
      | { threadId: ThreadId; requestId: RequestId; value: string; keep: boolean }
      | { threadId: ThreadId; requestId: RequestId; declined: true };
    result: { ok: true };
  };
  /** Use a ref from its own thread: write it to an ignored file, or hand it to one command. */
  'secrets.use': {
    params: { threadId: ThreadId; ref: string; use: SecretUse };
    result: SecretUseResult;
  };
  /**
   * The keys kept for a project: names and dates, never values. An agent names
   * its thread and reads its project's; Settings names the project. `encrypted`
   * says whether this connection may answer a card or delete a key.
   */
  'secrets.list': {
    params: { threadId: ThreadId } | { projectId: ProjectId };
    result: { secrets: SecretKeyInfo[]; storage: SecretStorage; encrypted: boolean };
  };
  /** Erase a kept key from the vault. The owner's, or a paired device's over an encrypted link. */
  'secrets.delete': {
    params: { projectId: ProjectId; name: string };
    result: { ok: true };
  };
}

export interface SecretsRpcEvents {
  /** A card opened. The timeline carries the same card as a `secret_request` part. */
  'secret.requested': SecretRequest;
  'secret.resolved': { requestId: RequestId; threadId: ThreadId; status: SecretAskOutcome; ref: string | null };
  /** A project's kept keys changed: names only. */
  'secrets.changed': { projectId: ProjectId; names: string[] };
}
