/**
 * Secrets an agent asks for on a card and then uses by ref. The value goes
 * from the card to temporary process memory and from there to the file or the
 * command the agent names; it never enters the journal, an event, a log or
 * an error. See docs/secrets.md for what is and is not promised.
 */
import {
  parseSecretRef, SECRET_ASK_MAX_TIMEOUT_MINUTES, SECRET_ASK_TIMEOUT_MINUTES, SECRET_MAX_BYTES, SECRET_NAME_PATTERN,
  SECRET_TRANSIT_TTL_MS,
} from '@boite/contracts';
import type {
  Message, MessagePart, ProjectId, RpcEvents, RpcMethods, SecretAskOutcome, SecretKeyInfo, SecretRequest, SecretUseResult, ThreadId, TurnId,
} from '@boite/contracts';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { SecretVault } from '../platform/types.ts';
import type { Connection } from '../router.ts';
import { setThreadStatus } from '../threads/records.ts';
import { SecretIndex, type TransitEntry } from './index-file.ts';
import { maskDeep, SecretMasks } from './mask.ts';
import { execSecret, writeSecret } from './use.ts';

type AskParams = RpcMethods['secrets.ask']['params'];
type AskResult = RpcMethods['secrets.ask']['result'];
type AnswerParams = RpcMethods['secrets.answer']['params'];
type UseParams = RpcMethods['secrets.use']['params'];
type SecretPart = Extract<MessagePart, { type: 'secret_request' }>;

interface Pending {
  request: SecretRequest;
  messageId: string;
  partIndex: number;
  part: SecretPart;
  timer: ReturnType<typeof setTimeout>;
  /** The `ask` calls waiting on the card; when the last one's socket closes, nobody would get the ref, so the card closes. */
  waiters: number;
  done: Promise<AskResult>;
  resolve: (result: AskResult) => void;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SETTLED_KEPT = 200;
const SWEEP_EVERY_MS = 60_000;
const encoder = new TextEncoder();

const threadScope = (threadId: string): string => `thread:${threadId}`;
interface Transit extends TransitEntry { turnId: TurnId; value: Uint8Array }

export class SecretStore {
  readonly masks = new SecretMasks();
  readonly index: SecretIndex;
  /** The clock of every expiry; tests cross the deadline without waiting. */
  now: () => number = () => Date.now();
  #vault: Promise<SecretVault> | null = null;
  readonly #transit = new Map<string, Transit>();
  readonly #pending = new Map<string, Pending>();
  /** Answers already given, so a retried `ask` with the same request id gets the same card's outcome. */
  readonly #settled = new Map<string, { threadId: ThreadId; result: AskResult }>();
  #sweeper: ReturnType<typeof setTimeout> | null = null;
  #stopBus: (() => void) | null = null;

  constructor(private readonly core: Core, private readonly openVault: (dir: string) => Promise<SecretVault>) {
    this.index = new SecretIndex(join(core.dataDir, 'secrets'));
  }

  /** Legacy vault, opened only to erase entries from older releases. Never used for new values. */
  vault(): Promise<SecretVault> {
    this.#vault ??= this.openVault(this.index.dir).catch((error: unknown) => {
      this.#vault = null;
      throw error;
    });
    return this.#vault;
  }

  start(): void {
    this.#stopBus = this.core.bus.onAny((name, payload) => this.#onEvent(name, payload));
    if (!this.index.exists()) return;
    setTimeout(() => {
      if (this.#stopBus === null) return;
      void this.sweep(true).catch(error => this.#warn('startup sweep failed', error)).finally(() => this.#arm());
    }, 0);
  }

  stop(): void {
    this.#stopBus?.();
    this.#stopBus = null;
    if (this.#sweeper !== null) clearTimeout(this.#sweeper);
    this.#sweeper = null;
    for (const entry of this.#transit.values()) entry.value.fill(0);
    this.#transit.clear();
    if (this.core.journal.isClosed()) return;
    for (const pending of [...this.#pending.values()]) this.#settle(pending, 'cancelled', null, false);
  }

  /** Expire memory copies at their deadline; retry unavailable legacy cleanup once a minute. */
  #arm(): void {
    if (this.#sweeper !== null) clearTimeout(this.#sweeper);
    this.#sweeper = null;
    if (this.#stopBus === null) return;
    const legacy = this.index.exists() && this.index.data.version === 1;
    if (this.#transit.size === 0 && !legacy) return;
    const next = Math.min(...[...this.#transit.values()].map(entry => entry.expiresAt), this.now() + SWEEP_EVERY_MS);
    this.#sweeper = setTimeout(() => {
      this.#sweeper = null;
      void this.sweep(false).catch(error => this.#warn('sweep failed', error)).finally(() => this.#arm());
    }, Math.max(next - this.now(), 1));
    this.#sweeper.unref?.();
  }

  /** Does a secret card hold this thread's turn? The thread then shows as waiting on the user. */
  waiting(threadId: ThreadId): boolean {
    for (const pending of this.#pending.values()) if (pending.request.threadId === threadId) return true;
    return false;
  }

  /** Open request metadata only: no vault access and no history page dependency. */
  pending(threadId?: ThreadId): SecretRequest[] {
    const now = this.now();
    const requests: SecretRequest[] = [];
    for (const pending of [...this.#pending.values()]) {
      const request = pending.request;
      if (threadId !== undefined && request.threadId !== threadId) continue;
      if (request.expiresAt <= now) this.#settle(pending, 'timed_out', null);
      else requests.push({ ...request });
    }
    return requests;
  }

  /** The thread's text with every active secret's value replaced by `•••• (<NAME>)`. */
  mask(threadId: ThreadId, text: string): string {
    if (this.masks.empty) return text;
    return this.masks.mask([threadScope(threadId)], text);
  }

  maskPart<T extends MessagePart>(threadId: ThreadId, part: T): T {
    if (this.masks.empty || part.type === 'secret_request') return part;
    const scopes = [threadScope(threadId)];
    if (!this.masks.has(scopes)) return part;
    return maskDeep(part, text => this.masks.mask(scopes, text));
  }

  maskAll(text: string): string {
    return this.masks.maskAll(text);
  }

  // ---- Cards ----

  async ask(params: AskParams, connection?: Connection): Promise<AskResult> {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('cannot ask for a secret on an archived conversation', { threadId: thread.id, field: 'archived', expected: false });
    if (typeof params.name !== 'string' || !SECRET_NAME_PATTERN.test(params.name)) {
      throw refused('name: expected capitals, digits and _, starting with a letter, at most 64 characters', { field: 'name', expected: SECRET_NAME_PATTERN.source });
    }
    const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
    if (reason.length === 0 || reason.length > 500) throw refused('reason: expected 1 to 500 characters', { field: 'reason', expected: '1..500 characters' });
    const placeholder = params.placeholder === undefined ? null : typeof params.placeholder === 'string' ? params.placeholder.trim().slice(0, 200) || null : null;
    const minutes = params.timeoutMinutes ?? SECRET_ASK_TIMEOUT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SECRET_ASK_MAX_TIMEOUT_MINUTES) {
      throw refused(`timeoutMinutes: expected 1 to ${SECRET_ASK_MAX_TIMEOUT_MINUTES}`, { field: 'timeoutMinutes', expected: `1..${SECRET_ASK_MAX_TIMEOUT_MINUTES}` });
    }
    if (params.requestId !== undefined && (typeof params.requestId !== 'string' || !REQUEST_ID.test(params.requestId))) {
      throw refused('requestId: expected 8 to 64 letters, digits, _ or -', { field: 'requestId', expected: REQUEST_ID.source });
    }
    if (params.replace !== undefined && params.replace !== false) throw refused('replace: project secrets are no longer supported', { field: 'replace', expected: false });
    const known = (): Promise<AskResult> | AskResult | undefined => {
      if (params.requestId === undefined) return undefined;
      const live = this.#pending.get(params.requestId);
      const settled = this.#settled.get(params.requestId);
      const owner = live?.request.threadId ?? settled?.threadId;
      if (owner !== undefined && owner !== thread.id) throw refused('requestId: already used by another conversation', { field: 'requestId', expected: 'a fresh id' });
      return live ? this.#wait(live, connection) : settled?.result;
    };
    const before = known();
    if (before !== undefined) return before;
    const storage = 'memory' as const;
    const turn = this.core.journal.runningTurn(thread.id);
    if (turn === null) throw refused('a secret card opens only while a turn runs', { threadId: thread.id });
    const createdAt = this.now();
    const request: SecretRequest = {
      id: params.requestId ?? newId('sreq_'), threadId: thread.id, turnId: turn.id, name: params.name, reason, placeholder,
      status: 'pending', ref: null, expiresAt: createdAt + minutes * 60_000, createdAt,
    };
    const part: SecretPart = { type: 'secret_request', requestId: request.id, name: request.name, reason, placeholder, status: 'pending', ref: null, expiresAt: request.expiresAt };
    const message: Message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt: Date.now() };
    this.index.update(data => { data.cards.push({ requestId: request.id, threadId: thread.id, messageId: message.id, partIndex: 0 }); });
    this.core.journal.append({ type: 'message.started', threadId: thread.id, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    let resolve: (result: AskResult) => void = () => undefined;
    const done = new Promise<AskResult>(settle => { resolve = settle; });
    const timer = setTimeout(() => { const live = this.#pending.get(request.id); if (live) this.#settle(live, 'timed_out', null); }, minutes * 60_000);
    const pending: Pending = { request, messageId: message.id, partIndex: 0, part, timer, waiters: 0, done, resolve };
    this.#pending.set(request.id, pending);
    setThreadStatus(this.core, thread.id, 'waiting');
    this.core.bus.emit('secret.requested', request);
    this.core.logs.info(`Secret ${request.name} asked on a card`, {
      source: 'secrets', event: 'secret.requested', threadId: thread.id, turnId: turn.id, requestId: request.id, data: { name: request.name, timeoutMinutes: minutes, storage },
    });
    return this.#wait(pending, connection);
  }

  #wait(pending: Pending, connection: Connection | undefined): Promise<AskResult> {
    pending.waiters += 1;
    return new Promise<AskResult>((resolve, reject) => {
      const off = connection?.onClose?.(() => {
        pending.waiters -= 1;
        reject(refused('secrets.ask: the connection closed before the card was answered'));
        if (pending.waiters === 0 && !this.core.journal.isClosed()) this.#settle(pending, 'cancelled', null);
      });
      void pending.done.then((result) => { off?.(); resolve(result); });
    });
  }

  /** Writes the card's outcome where it is drawn, tells every client and wakes the waiting `ask`. */
  #settle(pending: Pending, status: SecretAskOutcome, ref: string | null, touchStatus = true): void {
    const { request } = pending;
    if (this.#pending.get(request.id) !== pending) return;
    this.#pending.delete(request.id);
    clearTimeout(pending.timer);
    const threadId = request.threadId;
    const part: SecretPart = { ...pending.part, status, ref };
    this.core.journal.append(
      { type: 'message.part', threadId, version: 1, payload: { messageId: pending.messageId, partIndex: pending.partIndex, part } },
      () => this.core.journal.setMessagePart(pending.messageId, pending.partIndex, part),
    );
    this.core.bus.emit('message.part', { threadId, messageId: pending.messageId, partIndex: pending.partIndex, part });
    this.index.update(data => { data.cards = data.cards.filter(card => card.requestId !== request.id); });
    this.core.bus.emit('secret.resolved', { requestId: request.id, threadId, status, ref });
    this.core.logs.info(`Secret ${request.name} card closed: ${status}`, { source: 'secrets', event: 'secret.resolved', threadId, turnId: request.turnId, requestId: request.id, data: { name: request.name, status } });
    if (touchStatus && this.core.journal.runningTurn(threadId)?.id === request.turnId) {
      setThreadStatus(this.core, threadId, this.core.threads.cards.waitingOn(threadId) ? 'waiting' : 'running');
    }
    const result: AskResult = { requestId: request.id, outcome: status, ref, storage: 'memory' };
    this.#settled.set(request.id, { threadId, result });
    if (this.#settled.size > SETTLED_KEPT) this.#settled.delete(this.#settled.keys().next().value!);
    pending.resolve(result);
  }

  /**
   * The user's answer. The value is stored before the card says saved; a
   * decline stores nothing. Only a link nobody can read on the way carries a
   * value (`encrypted`).
   */
  async answer(params: AnswerParams, encrypted: boolean): Promise<{ ok: true }> {
    const pending = this.#pending.get(params.requestId);
    if (pending === undefined || pending.request.threadId !== params.threadId) {
      throw notFound('this secret card was already answered or closed', { requestId: params.requestId, field: 'requestId', expected: 'an open card' });
    }
    if ('declined' in params && params.declined === true) {
      this.#settle(pending, 'declined', null);
      return { ok: true };
    }
    if (!encrypted) throw refused('secrets.answer: a value travels only over an encrypted link; answer from the PC or over HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
    const { request } = pending;
    if (this.core.journal.runningTurn(request.threadId)?.id !== request.turnId) {
      this.#settle(pending, 'cancelled', null, false);
      throw refused('the turn that asked for this secret has ended', { requestId: request.id });
    }
    if ('keep' in params && params.keep !== undefined && params.keep !== false) throw refused('keep: Secret Drop is temporary and cannot keep project secrets', { field: 'keep', expected: false });
    if (request.expiresAt <= this.now()) {
      this.#settle(pending, 'timed_out', null);
      throw refused('requestId: this secret card expired', { field: 'requestId', expected: 'an open card' });
    }
    const raw = 'value' in params ? params.value : undefined;
    if (typeof raw !== 'string') throw refused('value: expected text', { field: 'value', expected: 'a string' });
    // The JS string the socket decoded cannot be wiped; the bytes made from it are, once stored.
    const value = encoder.encode(raw);
    try {
      if (value.length === 0 || value.length > SECRET_MAX_BYTES) throw refused(`value: expected 1 to ${SECRET_MAX_BYTES} bytes`, { field: 'value', expected: `1..${SECRET_MAX_BYTES} bytes` });
      const thread = this.core.threads.require(request.threadId);
      const createdAt = this.now();
      const entry: Transit = { id: newId('sec_'), threadId: thread.id, turnId: request.turnId, projectId: thread.projectId, name: request.name, createdAt, expiresAt: createdAt + SECRET_TRANSIT_TTL_MS, value: value.slice() };
      this.#transit.set(entry.id, entry);
      this.masks.add(threadScope(thread.id), `transit:${entry.id}`, entry.name, value);
      this.#arm();
      this.#settle(pending, 'saved', `secret:${entry.id}`);
      return { ok: true };
    } finally {
      value.fill(0);
    }
  }

  /** Every open card of the thread closes, as `cancelled`. */
  #closeCards(match: (request: SecretRequest) => boolean, touchStatus: boolean): void {
    for (const pending of [...this.#pending.values()]) if (match(pending.request)) this.#settle(pending, 'cancelled', null, touchStatus);
  }

  // ---- Use ----

  async use(params: UseParams, connection: Connection | undefined): Promise<SecretUseResult> {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('an archived conversation uses no secret', { threadId: thread.id, field: 'archived', expected: false });
    const parsed = typeof params.ref === 'string' ? parseSecretRef(params.ref) : null;
    if (parsed === null) throw refused('ref: expected a temporary secret:<id>; ask for it again', { field: 'ref', expected: 'secret:<id>' });
    const action = params.use?.action;
    if (action !== 'write' && action !== 'run' && action !== 'pipe') throw refused('use.action: expected write, run or pipe', { field: 'use.action', expected: 'write | run | pipe' });
    const entry = this.#transit.get(parsed.id);
    if (entry === undefined) throw refused('ref: this secret was erased or never existed; ask for it again', { field: 'ref', expected: 'a live ref' });
    if (entry.threadId !== thread.id || entry.projectId !== thread.projectId) throw refused('ref: this secret belongs to another conversation', { field: 'ref', expected: 'a ref this conversation received' });
    if (entry.expiresAt <= this.now()) {
      this.#eraseTransit(entry);
      throw refused('ref: this secret expired after ten minutes and was erased; ask for it again', { field: 'ref', expected: 'a live ref' });
    }
    if (this.core.journal.runningTurn(thread.id)?.id !== entry.turnId) {
      this.#eraseTransit(entry);
      throw refused('ref: this secret was erased when its turn ended; ask for it again', { field: 'ref', expected: 'a ref of the running turn' });
    }
    // Claim synchronously before the first await: concurrent uses cannot share a buffer.
    this.#transit.delete(entry.id);
    const value = entry.value;
    try {
      this.core.logs.info(`Secret ${entry.name} used: ${action}`, { source: 'secrets', event: 'secret.used', threadId: thread.id, data: { name: entry.name, action, kind: 'transit' } });
      if (params.use.action === 'write') return await writeSecret(this.core, thread.id, thread.cwd, params.use, value);
      return await execSecret(this.core, thread.id, thread.cwd, params.use, value, text => this.mask(thread.id, text), connection);
    } finally {
      value.fill(0);
      this.#arm();
    }
  }

  /** Compatibility metadata only; project secrets cannot be saved or reused. */
  async list(_projectId: ProjectId | null): Promise<{ secrets: SecretKeyInfo[]; storage: 'memory' }> {
    return { secrets: [], storage: 'memory' };
  }

  async delete(_projectId: ProjectId, name: string): Promise<void> {
    throw notFound(`no key named ${String(name)} is kept: Secret Drop is temporary`, { field: 'name', expected: 'no stored project keys' });
  }

  #eraseTransit(entry: Transit): void {
    entry.value.fill(0);
    this.#transit.delete(entry.id);
    // Keep hashes (never the value) for late output and diagnostic masking until shutdown.
  }

  #forgetThread(threadId: ThreadId): void {
    this.#closeCards(request => request.threadId === threadId, false);
    for (const entry of this.#transit.values()) if (entry.threadId === threadId) this.#eraseTransit(entry);
    this.#arm();
  }

  #onEvent(name: string, payload: unknown): void {
    if (name === 'turn.finished') {
      const turn = payload as RpcEvents['turn.finished'];
      this.#closeCards(request => request.turnId === turn.id, false);
      for (const entry of this.#transit.values()) if (entry.turnId === turn.id) this.#eraseTransit(entry);
      this.#arm();
    } else if (name === 'thread.updated') {
      const thread = payload as RpcEvents['thread.updated'];
      if (thread.archived) this.#forgetThread(thread.id);
    } else if (name === 'thread.removed') {
      this.#forgetThread((payload as RpcEvents['thread.removed']).threadId);
    } else if (name === 'project.removed') {
      const { projectId } = payload as RpcEvents['project.removed'];
      for (const entry of this.#transit.values()) if (entry.projectId === projectId) this.#eraseTransit(entry);
      this.#arm();
    }
  }

  /** Erase legacy values without reading them; retain failed entries so cleanup can retry. */
  async sweep(startup: boolean): Promise<void> {
    for (const entry of this.#transit.values()) {
      const thread = this.core.journal.getThread(entry.threadId);
      if (entry.expiresAt <= this.now() || !thread || thread.archived || thread.projectId !== entry.projectId || this.core.journal.runningTurn(entry.threadId)?.id !== entry.turnId) this.#eraseTransit(entry);
    }
    if (!this.index.exists()) return;
    if (startup) {
      for (const card of [...this.index.data.cards]) {
        if (this.#pending.has(card.requestId)) continue;
        const found = this.core.journal.messagePart(card.messageId, card.partIndex)?.part;
        if (found?.type === 'secret_request' && found.status === 'pending') {
          const part: SecretPart = { ...found, status: 'cancelled' };
          this.core.journal.append(
            { type: 'message.part', threadId: card.threadId, version: 1, payload: { messageId: card.messageId, partIndex: card.partIndex, part } },
            () => this.core.journal.setMessagePart(card.messageId, card.partIndex, part),
          );
          this.core.bus.emit('message.part', { threadId: card.threadId, messageId: card.messageId, partIndex: card.partIndex, part });
        }
        this.index.update(data => { data.cards = data.cards.filter(item => item.requestId !== card.requestId); });
      }
    }
    if (this.index.data.version !== 1) return;
    const vault = await this.vault();
    if (!vault.persistent && (this.index.data.transit.length > 0 || this.index.data.kept.length > 0)) {
      this.#vault = null;
      throw new Error('legacy secret vault unavailable; retained cleanup metadata for retry');
    }
    const ids = new Set([...this.index.data.transit, ...this.index.data.kept].map(entry => entry.id));
    for (const id of (await vault.ids?.()) ?? []) ids.add(id);
    for (const id of ids) {
      await vault.delete(id);
      this.index.update(data => {
        data.transit = data.transit.filter(entry => entry.id !== id);
        data.kept = data.kept.filter(entry => entry.id !== id);
      });
    }
    this.index.update(data => { data.version = 2; });
    if (ids.size > 0) this.core.logs.info(`Erased ${ids.size} legacy secrets`, { source: 'secrets', event: 'secret.swept', data: { erased: ids.size } });
  }

  #warn(message: string, error: unknown): void {
    this.core.logs.warn(`secrets: ${message}: ${error instanceof Error ? error.message : 'unknown error'}`, { source: 'secrets', event: 'secret.error' });
  }
}
