/**
 * Secrets an agent asks for on a card and then uses by ref. The value goes
 * from the card to the system vault and from the vault to the file or the
 * command the agent names; it never enters the journal, an event, a log or
 * an error. See docs/secrets.md for what is and is not promised.
 */
import {
  parseSecretRef, projectSecretRef, SECRET_ASK_MAX_TIMEOUT_MINUTES, SECRET_ASK_TIMEOUT_MINUTES, SECRET_MAX_BYTES, SECRET_NAME_PATTERN,
  SECRET_TRANSIT_TTL_MS,
} from '@boite/contracts';
import type {
  Message, MessagePart, ProjectId, RpcEvents, RpcMethods, SecretAskOutcome, SecretKeyInfo, SecretRequest, SecretStorage, SecretUseResult, ThreadId,
} from '@boite/contracts';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { notFound, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { SecretVault } from '../platform/types.ts';
import type { Connection } from '../router.ts';
import { setThreadStatus } from '../threads/records.ts';
import { SecretIndex, type KeptEntry, type TransitEntry } from './index-file.ts';
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
  /** A value is being stored for this card; a second answer meanwhile is refused. */
  answering?: boolean;
  done: Promise<AskResult>;
  resolve: (result: AskResult) => void;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SETTLED_KEPT = 200;
const SWEEP_EVERY_MS = 60 * 60_000;
const encoder = new TextEncoder();

const threadScope = (threadId: string): string => `thread:${threadId}`;
const projectScope = (projectId: string): string => `project:${projectId}`;

export class SecretStore {
  readonly masks = new SecretMasks();
  readonly index: SecretIndex;
  /** The clock of every expiry; a test moves it to cross the 24 h without waiting. */
  now: () => number = () => Date.now();
  #vault: Promise<SecretVault> | null = null;
  /** The opened vault's kind; every card opens it first, so a settled one reads it here. */
  #storage: SecretStorage = 'memory';
  readonly #pending = new Map<string, Pending>();
  /** Answers already given, so a retried `ask` with the same request id gets the same card's outcome. */
  readonly #settled = new Map<string, { threadId: ThreadId; result: AskResult }>();
  readonly #projects = new Map<ThreadId, ProjectId | null>();
  #sweeper: ReturnType<typeof setTimeout> | null = null;
  #stopBus: (() => void) | null = null;

  constructor(private readonly core: Core, private readonly openVault: (dir: string) => Promise<SecretVault>) {
    this.index = new SecretIndex(join(core.dataDir, 'secrets'));
  }

  /** The system vault, opened by the first secret saved or used, never at startup unless something is stored. */
  vault(): Promise<SecretVault> {
    this.#vault ??= this.openVault(this.index.dir).then((vault) => {
      this.#storage = vault.kind;
      return vault;
    }, (error: unknown) => {
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
    if (this.core.journal.isClosed()) return;
    for (const pending of [...this.#pending.values()]) this.#settle(pending, 'cancelled', null, false, false);
  }

  /** The next sweep: when the first transit copy reaches its 24 h, and at least hourly while anything is stored. */
  #arm(): void {
    if (this.#sweeper !== null) clearTimeout(this.#sweeper);
    this.#sweeper = null;
    if (this.#stopBus === null || !this.index.exists()) return;
    const { transit, kept } = this.index.data;
    if (transit.length === 0 && kept.length === 0) return;
    const next = Math.min(...transit.map(entry => entry.expiresAt), this.now() + SWEEP_EVERY_MS);
    const delay = Math.min(Math.max(next - this.now(), 1_000), SWEEP_EVERY_MS);
    this.#sweeper = setTimeout(() => {
      this.#sweeper = null;
      void this.sweep(false).catch(error => this.#warn('sweep failed', error)).finally(() => this.#arm());
    }, delay);
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
      if (request.expiresAt <= now) this.#settle(pending, 'timed_out', null, false);
      else requests.push({ ...request });
    }
    return requests;
  }

  #projectOf(threadId: ThreadId): ProjectId | null {
    if (!this.#projects.has(threadId)) this.#projects.set(threadId, this.core.journal.getThread(threadId)?.projectId ?? null);
    return this.#projects.get(threadId)!;
  }

  #scopes(threadId: ThreadId): string[] {
    const projectId = this.#projectOf(threadId);
    return projectId === null ? [threadScope(threadId)] : [threadScope(threadId), projectScope(projectId)];
  }

  /** The thread's text with every active secret's value replaced by `•••• (<NAME>)`. */
  mask(threadId: ThreadId, text: string): string {
    if (this.masks.empty) return text;
    return this.masks.mask(this.#scopes(threadId), text);
  }

  maskPart<T extends MessagePart>(threadId: ThreadId, part: T): T {
    if (this.masks.empty || part.type === 'secret_request') return part;
    const scopes = this.#scopes(threadId);
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
    const replace = params.replace === true;
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
    const storage = (await this.vault()).kind;
    // A retry with the same id may have opened the card while the vault loaded.
    const meanwhile = known();
    if (meanwhile !== undefined) return meanwhile;
    if (!replace && thread.projectId !== null && this.index.kept(thread.projectId, params.name)) {
      return { requestId: params.requestId ?? newId('sreq_'), outcome: 'saved', ref: projectSecretRef(params.name), storage };
    }
    if (replace && thread.projectId === null) throw refused('replace: this conversation has no project, so it keeps no key', { field: 'replace', expected: false });
    const turn = this.core.journal.runningTurn(thread.id);
    if (turn === null) throw refused('a secret card opens only while a turn runs', { threadId: thread.id });
    const createdAt = this.now();
    const request: SecretRequest = {
      id: params.requestId ?? newId('sreq_'), threadId: thread.id, turnId: turn.id, name: params.name, reason, placeholder, replace,
      status: 'pending', ref: null, expiresAt: createdAt + minutes * 60_000, createdAt,
    };
    const part: SecretPart = { type: 'secret_request', requestId: request.id, name: request.name, reason, placeholder, status: 'pending', ref: null, ...(replace ? { replace: true } : {}), expiresAt: request.expiresAt };
    const message: Message = { id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt: Date.now() };
    this.index.update(data => { data.cards.push({ requestId: request.id, threadId: thread.id, messageId: message.id, partIndex: 0 }); });
    this.core.journal.append({ type: 'message.started', threadId: thread.id, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    let resolve: (result: AskResult) => void = () => undefined;
    const done = new Promise<AskResult>(settle => { resolve = settle; });
    const timer = setTimeout(() => { const live = this.#pending.get(request.id); if (live) this.#settle(live, 'timed_out', null, false); }, minutes * 60_000);
    const pending: Pending = { request, messageId: message.id, partIndex: 0, part, timer, waiters: 0, done, resolve };
    this.#pending.set(request.id, pending);
    setThreadStatus(this.core, thread.id, 'waiting');
    this.core.bus.emit('secret.requested', request);
    this.core.logs.info(`Secret ${request.name} asked on a card${replace ? ', to replace a kept key' : ''}`, {
      source: 'secrets', event: 'secret.requested', threadId: thread.id, turnId: turn.id, requestId: request.id, data: { name: request.name, replace, timeoutMinutes: minutes, storage },
    });
    return this.#wait(pending, connection);
  }

  #wait(pending: Pending, connection: Connection | undefined): Promise<AskResult> {
    pending.waiters += 1;
    return new Promise<AskResult>((resolve, reject) => {
      const off = connection?.onClose?.(() => {
        pending.waiters -= 1;
        reject(refused('secrets.ask: the connection closed before the card was answered'));
        if (pending.waiters === 0 && !this.core.journal.isClosed()) this.#settle(pending, 'cancelled', null, false);
      });
      void pending.done.then((result) => { off?.(); resolve(result); });
    });
  }

  /** Writes the card's outcome where it is drawn, tells every client and wakes the waiting `ask`. */
  #settle(pending: Pending, status: SecretAskOutcome, ref: string | null, kept: boolean, touchStatus = true): void {
    const { request } = pending;
    if (this.#pending.get(request.id) !== pending) return;
    this.#pending.delete(request.id);
    clearTimeout(pending.timer);
    const threadId = request.threadId;
    const part: SecretPart = { ...pending.part, status, ref, ...(kept ? { kept: true } : {}) };
    this.core.journal.append(
      { type: 'message.part', threadId, version: 1, payload: { messageId: pending.messageId, partIndex: pending.partIndex, part } },
      () => this.core.journal.setMessagePart(pending.messageId, pending.partIndex, part),
    );
    this.core.bus.emit('message.part', { threadId, messageId: pending.messageId, partIndex: pending.partIndex, part });
    this.index.update(data => { data.cards = data.cards.filter(card => card.requestId !== request.id); });
    this.core.bus.emit('secret.resolved', { requestId: request.id, threadId, status, ref });
    this.core.logs.info(`Secret ${request.name} card closed: ${status}`, { source: 'secrets', event: 'secret.resolved', threadId, turnId: request.turnId, requestId: request.id, data: { name: request.name, status, kept } });
    if (touchStatus && this.core.journal.runningTurn(threadId)?.id === request.turnId) {
      setThreadStatus(this.core, threadId, this.core.threads.cards.waitingOn(threadId) ? 'waiting' : 'running');
    }
    const result: AskResult = { requestId: request.id, outcome: status, ref, storage: this.#storage };
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
    if (pending.answering) throw notFound('this secret card is already being answered', { requestId: params.requestId, field: 'requestId', expected: 'an open card' });
    if ('declined' in params && params.declined === true) {
      this.#settle(pending, 'declined', null, false);
      return { ok: true };
    }
    if (!encrypted) throw refused('secrets.answer: a value travels only over an encrypted link; answer from the PC or over HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
    const { request } = pending;
    if (this.core.journal.runningTurn(request.threadId)?.id !== request.turnId) {
      this.#settle(pending, 'cancelled', null, false, false);
      throw refused('the turn that asked for this secret has ended', { requestId: request.id });
    }
    const keep = 'keep' in params && params.keep === true;
    const raw = 'value' in params ? params.value : undefined;
    if (typeof raw !== 'string') throw refused('value: expected text', { field: 'value', expected: 'a string' });
    // The JS string the socket decoded cannot be wiped; the bytes made from it are, once stored.
    const value = encoder.encode(raw);
    // Held from here to the end, so two answers racing on one card store one value.
    pending.answering = true;
    try {
      if (value.length === 0 || value.length > SECRET_MAX_BYTES) throw refused(`value: expected 1 to ${SECRET_MAX_BYTES} bytes`, { field: 'value', expected: `1..${SECRET_MAX_BYTES} bytes` });
      const thread = this.core.threads.require(request.threadId);
      if (keep && thread.projectId === null) throw refused('keep: this conversation has no project to keep the key for', { field: 'keep', expected: false });
      const vault = await this.vault();
      // The card may close while the vault opens or stores; then the stored value is erased.
      const live = (): boolean => this.#pending.get(request.id) === pending;
      if (!live()) throw notFound('this secret card was already answered or closed', { requestId: request.id });
      const ref = keep ? await this.#keep(vault, thread.projectId!, request.name, value, live) : await this.#transit(vault, thread.id, thread.projectId, request.name, value, live);
      this.#settle(pending, 'saved', ref, keep);
      return { ok: true };
    } finally {
      pending.answering = false;
      value.fill(0);
    }
  }

  async #transit(vault: SecretVault, threadId: ThreadId, projectId: ProjectId | null, name: string, value: Uint8Array, live: () => boolean): Promise<string> {
    const createdAt = this.now();
    const entry: TransitEntry = { id: newId('sec_'), threadId, projectId, name, createdAt, expiresAt: createdAt + SECRET_TRANSIT_TTL_MS };
    // The index line first: a crash between the two leaves a line the sweep clears, never a value nobody knows of.
    this.index.update(data => { data.transit.push(entry); });
    await this.#put(vault, entry.id, value, live, () => this.index.update(data => { data.transit = data.transit.filter(item => item.id !== entry.id); }));
    this.masks.add(threadScope(threadId), `transit:${entry.id}`, name, value);
    this.#arm();
    return `secret:${entry.id}`;
  }

  async #keep(vault: SecretVault, projectId: ProjectId, name: string, value: Uint8Array, live: () => boolean): Promise<string> {
    const previous = this.index.kept(projectId, name);
    const now = this.now();
    const entry: KeptEntry = { id: newId('key_'), projectId, name, createdAt: now, lastUsedAt: null };
    this.index.update(data => { data.kept.push(entry); });
    await this.#put(vault, entry.id, value, live, () => this.index.update(data => { data.kept = data.kept.filter(item => item.id !== entry.id); }));
    if (previous) {
      await vault.delete(previous.id).catch(error => this.#warn(`could not erase the replaced key ${name}`, error));
      this.index.update(data => { data.kept = data.kept.filter(item => item.id !== previous.id); });
    }
    this.masks.add(projectScope(projectId), `kept:${name}`, name, value);
    this.#changed(projectId);
    if (this.#sweeper === null) this.#arm();
    return projectSecretRef(name);
  }

  /**
   * Stores the value under the index line written just before. A failed put
   * takes the line back; so does a card that closed meanwhile, after erasing
   * the value, so a replaced key stays as it was.
   */
  async #put(vault: SecretVault, id: string, value: Uint8Array, live: () => boolean, unlist: () => void): Promise<void> {
    try {
      await vault.put(id, value);
    } catch (error) {
      unlist();
      throw refused(`the ${vault.kind} vault did not store the value: ${error instanceof Error ? error.message : 'unknown error'}`, { storage: vault.kind });
    }
    if (live()) return;
    await vault.delete(id).catch(error => this.#warn('could not erase a value stored for a closed card', error));
    unlist();
    throw notFound('this secret card closed while the value was stored', { field: 'requestId', expected: 'an open card' });
  }

  #changed(projectId: ProjectId): void {
    const payload: RpcEvents['secrets.changed'] = { projectId, names: this.index.data.kept.filter(entry => entry.projectId === projectId).map(entry => entry.name) };
    this.core.bus.emit('secrets.changed', payload);
  }

  /** Every open card of the thread closes, as `cancelled`. */
  #closeCards(match: (request: SecretRequest) => boolean, touchStatus: boolean): void {
    for (const pending of [...this.#pending.values()]) if (match(pending.request)) this.#settle(pending, 'cancelled', null, false, touchStatus);
  }

  // ---- Use ----

  async use(params: UseParams, connection: Connection | undefined): Promise<SecretUseResult> {
    const thread = this.core.threads.require(params.threadId);
    if (thread.archived) throw refused('an archived conversation uses no secret', { threadId: thread.id, field: 'archived', expected: false });
    const parsed = typeof params.ref === 'string' ? parseSecretRef(params.ref) : null;
    if (parsed === null) throw refused('ref: expected secret:<id> or secret:project/<NAME>', { field: 'ref', expected: 'secret:<id> | secret:project/<NAME>' });
    const action = params.use?.action;
    if (action !== 'write' && action !== 'run' && action !== 'pipe') throw refused('use.action: expected write, run or pipe', { field: 'use.action', expected: 'write | run | pipe' });
    const vault = await this.vault();
    let vaultId: string;
    let name: string;
    let scope: string;
    let secretKey: string;
    if (parsed.kind === 'transit') {
      const entry = this.index.transit(parsed.id);
      if (entry === undefined) throw refused('ref: this secret was erased or never existed; ask for it again', { field: 'ref', expected: 'a live ref' });
      // Refused without touching the entry: the conversation it belongs to keeps it.
      if (entry.threadId !== thread.id || entry.projectId !== thread.projectId) throw refused('ref: this secret belongs to another conversation', { field: 'ref', expected: 'a ref this conversation received' });
      if (entry.expiresAt <= this.now()) {
        await this.#eraseTransit(entry);
        throw refused('ref: this secret expired after 24 hours and was erased; ask for it again', { field: 'ref', expected: 'a live ref' });
      }
      ({ id: vaultId, name } = entry);
      scope = threadScope(thread.id);
      secretKey = `transit:${entry.id}`;
    } else {
      if (thread.projectId === null) throw refused('ref: this conversation has no project, so it has no kept key', { field: 'ref', expected: 'secret:<id>' });
      const entry = this.index.kept(thread.projectId, parsed.name);
      if (entry === undefined) throw refused(`ref: no key named ${parsed.name} is kept for this project; run boite secret ask ${parsed.name}`, { field: 'ref', expected: 'a kept key of this project' });
      this.index.update(() => { entry.lastUsedAt = this.now(); });
      ({ id: vaultId, name } = entry);
      scope = projectScope(thread.projectId);
      secretKey = `kept:${entry.name}`;
    }
    const value = await vault.take(vaultId);
    if (value === null) {
      this.masks.remove(scope, secretKey);
      this.index.update(data => {
        data.transit = data.transit.filter(item => item.id !== vaultId);
        data.kept = data.kept.filter(item => item.id !== vaultId);
      });
      if (parsed.kind === 'project') this.#changed(thread.projectId!);
      throw refused(`ref: the ${vault.kind} vault no longer holds ${name}; ask for it again`, { field: 'ref', expected: 'a live ref' });
    }
    try {
      this.masks.add(scope, secretKey, name, value);
      this.core.logs.info(`Secret ${name} used: ${action}`, { source: 'secrets', event: 'secret.used', threadId: thread.id, data: { name, action, kind: parsed.kind } });
      if (params.use.action === 'write') return await writeSecret(this.core, thread.id, thread.cwd, params.use, value);
      return await execSecret(this.core, thread.id, thread.cwd, params.use, value, text => this.mask(thread.id, text), connection);
    } finally {
      value.fill(0);
    }
  }

  // ---- Kept keys ----

  async list(projectId: ProjectId | null): Promise<{ secrets: SecretKeyInfo[]; storage: SecretStorage }> {
    const storage = (await this.vault()).kind;
    if (projectId === null) return { secrets: [], storage };
    const secrets = this.index.data.kept.filter(entry => entry.projectId === projectId)
      .map(entry => ({ projectId: entry.projectId, name: entry.name, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { secrets, storage };
  }

  async delete(projectId: ProjectId, name: string): Promise<void> {
    const entry = typeof name === 'string' ? this.index.kept(projectId, name) : undefined;
    if (entry === undefined) throw notFound(`no key named ${String(name)} is kept for this project`, { field: 'name', expected: 'a kept key of this project' });
    await this.#eraseKept(entry);
    this.core.logs.info(`Kept secret ${entry.name} deleted`, { source: 'secrets', event: 'secret.deleted', data: { name: entry.name } });
  }

  // ---- Erasure ----

  async #eraseTransit(entry: TransitEntry): Promise<void> {
    this.masks.remove(threadScope(entry.threadId), `transit:${entry.id}`);
    const vault = await this.vault();
    await vault.delete(entry.id);
    this.index.update(data => { data.transit = data.transit.filter(item => item.id !== entry.id); });
  }

  async #eraseKept(entry: KeptEntry): Promise<void> {
    this.masks.remove(projectScope(entry.projectId), `kept:${entry.name}`);
    const vault = await this.vault();
    await vault.delete(entry.id);
    this.index.update(data => { data.kept = data.kept.filter(item => item.id !== entry.id); });
    this.#changed(entry.projectId);
  }

  /** Erases what a put-away or removed conversation held. */
  async #forgetThread(threadId: ThreadId): Promise<void> {
    this.#closeCards(request => request.threadId === threadId, false);
    if (!this.index.exists()) return;
    for (const entry of this.index.data.transit.filter(item => item.threadId === threadId)) await this.#eraseTransit(entry);
    this.masks.removeScope(threadScope(threadId));
  }

  async #forgetProject(projectId: ProjectId): Promise<void> {
    if (!this.index.exists()) return;
    for (const entry of this.index.data.kept.filter(item => item.projectId === projectId)) await this.#eraseKept(entry);
    for (const entry of this.index.data.transit.filter(item => item.projectId === projectId)) await this.#eraseTransit(entry);
    this.masks.removeScope(projectScope(projectId));
  }

  #onEvent(name: string, payload: unknown): void {
    if (name === 'turn.finished') {
      const turn = payload as RpcEvents['turn.finished'];
      this.#closeCards(request => request.turnId === turn.id, false);
    } else if (name === 'thread.updated') {
      const thread = payload as RpcEvents['thread.updated'];
      this.#projects.set(thread.id, thread.projectId);
      if (thread.archived && (this.waiting(thread.id) || (this.index.exists() && this.index.data.transit.some(entry => entry.threadId === thread.id)))) {
        void this.#forgetThread(thread.id).catch(error => this.#warn('erasing an archived conversation\'s secrets failed', error));
      }
    } else if (name === 'thread.removed') {
      const { threadId } = payload as RpcEvents['thread.removed'];
      this.#projects.delete(threadId);
      void this.#forgetThread(threadId).catch(error => this.#warn('erasing a removed conversation\'s secrets failed', error));
    } else if (name === 'project.removed') {
      const { projectId } = payload as RpcEvents['project.removed'];
      void this.#forgetProject(projectId).catch(error => this.#warn('erasing a removed project\'s keys failed', error));
    }
  }

  /**
   * Erases what outlived its rule: transit copies past 24 h, of a conversation
   * put away or gone, or lost with a memory vault; keys of a removed project;
   * vault entries the index does not know. At startup it also closes the cards
   * a stopped core left open and teaches the masks what survives.
   */
  async sweep(startup: boolean): Promise<void> {
    if (!this.index.exists()) return;
    const vault = await this.vault();
    const now = this.now();
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
    let erased = 0;
    for (const entry of [...this.index.data.transit]) {
      const thread = this.core.journal.getThread(entry.threadId);
      const gone = entry.expiresAt <= now || thread === null || thread.archived || thread.projectId !== entry.projectId || (startup && !vault.persistent);
      if (gone) { await this.#eraseTransit(entry); erased += 1; continue; }
      if (!startup) continue;
      // One unreadable entry is skipped, not erased: the next start may read it, and the others still mask.
      const value = await vault.take(entry.id).catch(error => { this.#warn(`could not read ${entry.name} at startup`, error); return undefined; });
      if (value === undefined) continue;
      if (value === null) { await this.#eraseTransit(entry); erased += 1; continue; }
      this.masks.add(threadScope(entry.threadId), `transit:${entry.id}`, entry.name, value);
      value.fill(0);
    }
    for (const entry of [...this.index.data.kept]) {
      if (this.core.journal.getProject(entry.projectId) === null) { await this.#eraseKept(entry); erased += 1; continue; }
      if (!startup) continue;
      const value = await vault.take(entry.id).catch(error => { this.#warn(`could not read the kept key ${entry.name} at startup`, error); return undefined; });
      if (value === undefined) continue;
      if (value === null) {
        this.index.update(data => { data.kept = data.kept.filter(item => item.id !== entry.id); });
        erased += 1;
        continue;
      }
      this.masks.add(projectScope(entry.projectId), `kept:${entry.name}`, entry.name, value);
      value.fill(0);
    }
    const known = new Set([...this.index.data.transit.map(entry => entry.id), ...this.index.data.kept.map(entry => entry.id)]);
    for (const id of (await vault.ids?.()) ?? []) {
      if (known.has(id)) continue;
      await vault.delete(id);
      erased += 1;
    }
    if (erased > 0) this.core.logs.info(`Secret sweep erased ${erased} ${erased === 1 ? 'entry' : 'entries'}`, { source: 'secrets', event: 'secret.swept', data: { erased, startup, storage: vault.kind } });
  }

  #warn(message: string, error: unknown): void {
    this.core.logs.warn(`secrets: ${message}: ${error instanceof Error ? error.message : 'unknown error'}`, { source: 'secrets', event: 'secret.error' });
  }
}
