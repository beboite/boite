import {
  RpcErrorCode,
  SECRET_ASK_MAX_TIMEOUT_MINUTES,
  SECRET_ASK_TIMEOUT_MINUTES,
  SECRET_MAX_BYTES,
  SECRET_NAME_PATTERN,
  projectSecretRef,
  type Message,
  type MessagePart,
  type ProjectId,
  type RpcResult,
  type SecretAskOutcome,
  type SecretKeyInfo,
  type SecretRequest,
  type Thread
} from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** An open card: the request, where its part is drawn and what wakes the waiting `ask`. */
export interface FakeSecretCard {
  request: SecretRequest;
  message: Message;
  timer: ReturnType<typeof setTimeout>;
  /** What the first `ask` waits on; a retry with the same id waits on it too. */
  done: Promise<RpcResult<'secrets.ask'>>;
  resolve: (result: RpcResult<'secrets.ask'>) => void;
}

/** A kept key as the vault's index holds it: the value's length stands in for the value. */
export type FakeSecretKey = SecretKeyInfo & { bytes: number };

type SecretPart = Extract<MessagePart, { type: 'secret_request' }>;

const STORAGE = 'dpapi' as const;
const encoder = new TextEncoder();

function refused(message: string, data: Record<string, unknown> = {}): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

/** As the core's `connection.encrypted`: a phone over plain HTTP carries no value. */
function encrypted(ctx: FakeContext): boolean {
  return !ctx.plainLink;
}

function changed(ctx: FakeContext, projectId: ProjectId): void {
  ctx.emit('secrets.changed', { projectId, names: ctx.secretKeys.filter((key) => key.projectId === projectId).map((key) => key.name) });
}

/** Rewrites the card where it is drawn, tells every client and wakes the `ask`, as the core's `#settle`. */
function settle(ctx: FakeContext, thread: Thread | undefined, card: FakeSecretCard, status: SecretAskOutcome, ref: string | null, kept: boolean): void {
  if (ctx.pendingSecrets.get(card.request.id) !== card) return;
  ctx.pendingSecrets.delete(card.request.id);
  clearTimeout(card.timer);
  const drawn = card.message.parts[0] as SecretPart;
  const part: SecretPart = { ...drawn, status, ref, ...(kept ? { kept: true } : {}) };
  card.message.parts[0] = part;
  const threadId = card.request.threadId;
  ctx.emitToThread(threadId, 'message.part', { threadId, messageId: card.message.id, partIndex: 0, part: structuredClone(part) });
  ctx.emit('secret.resolved', { requestId: card.request.id, threadId, status, ref });
  if (thread && !thread.archived && thread.turns.some((turn) => turn.id === card.request.turnId && turn.status === 'running')) {
    thread.status = 'running';
    ctx.touch(thread);
  }
  card.resolve({ requestId: card.request.id, outcome: status, ref, storage: STORAGE });
}

/** Lifecycle events close cards even when no client is subscribed to their history. */
export function cancelSecretCards(ctx: FakeContext, threadId: string, turnId?: string): void {
  for (const card of [...ctx.pendingSecrets.values()]) {
    if (card.request.threadId !== threadId || (turnId !== undefined && card.request.turnId !== turnId)) continue;
    const thread = ctx.threads.get(threadId);
    settle(ctx, thread, card, 'cancelled', null, false);
  }
}

export function secretMethods(ctx: FakeContext) {
  // What a closed card answered, so a retry with its id gets it again, as the core's `#settled`.
  const settled = new Map<string, { threadId: Thread['id']; result: RpcResult<'secrets.ask'> }>();
  return {
    'secrets.pending': async (params) => {
      if ('threadId' in params) {
        if (typeof params.threadId !== 'string') throw refused('secrets.pending: threadId must be a string', { field: 'threadId', expected: 'a thread id' });
        ctx.thread(params.threadId);
      }
      const rows: SecretRequest[] = [];
      for (const card of [...ctx.pendingSecrets.values()]) {
        if (params.threadId !== undefined && card.request.threadId !== params.threadId) continue;
        if (card.request.expiresAt <= Date.now()) settle(ctx, ctx.thread(card.request.threadId), card, 'timed_out', null, false);
        else rows.push(structuredClone(card.request));
      }
      return rows;
    },
    'secrets.ask': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refused('cannot ask for a secret on an archived conversation', { threadId: thread.id, field: 'archived', expected: false });
      if (params.requestId !== undefined) {
        const live = ctx.pendingSecrets.get(params.requestId);
        const closed = settled.get(params.requestId);
        const owner = live?.request.threadId ?? closed?.threadId;
        if (owner !== undefined && owner !== thread.id) throw refused('requestId: already used by another conversation', { field: 'requestId', expected: 'a fresh id' });
        if (live) return live.done;
        if (closed) return closed.result;
      }
      if (!SECRET_NAME_PATTERN.test(params.name)) {
        throw refused('name: expected capitals, digits and _, starting with a letter, at most 64 characters', { field: 'name', expected: SECRET_NAME_PATTERN.source });
      }
      const reason = params.reason.trim();
      if (reason.length === 0 || reason.length > 500) throw refused('reason: expected 1 to 500 characters', { field: 'reason', expected: '1..500 characters' });
      const minutes = params.timeoutMinutes ?? SECRET_ASK_TIMEOUT_MINUTES;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > SECRET_ASK_MAX_TIMEOUT_MINUTES) {
        throw refused(`timeoutMinutes: expected 1 to ${SECRET_ASK_MAX_TIMEOUT_MINUTES}`, { field: 'timeoutMinutes', expected: `1..${SECRET_ASK_MAX_TIMEOUT_MINUTES}` });
      }
      const replace = params.replace === true;
      if (!replace && thread.projectId !== null && ctx.secretKeys.some((key) => key.projectId === thread.projectId && key.name === params.name)) {
        return { requestId: params.requestId ?? `sreq_${++ctx.seq}`, outcome: 'saved', ref: projectSecretRef(params.name), storage: STORAGE };
      }
      if (replace && thread.projectId === null) throw refused('replace: this conversation has no project, so it keeps no key', { field: 'replace', expected: false });
      // Like `questions.ask` here, the last turn stands in for a running one, so a demo draws a card after the echo reply.
      const turn = thread.turns.find((entry) => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) throw refused('a secret card opens only while a turn runs', { threadId: thread.id });
      const createdAt = ctx.now();
      const placeholder = params.placeholder?.trim() || null;
      // The fake's clock starts in the past; the card compares its deadline with the real one, so this one is real.
      const request: SecretRequest = {
        id: params.requestId ?? `sreq_${++ctx.seq}`, threadId: thread.id, turnId: turn.id, name: params.name, reason, placeholder, replace,
        status: 'pending', ref: null, expiresAt: Date.now() + minutes * 60_000, createdAt
      };
      const part: SecretPart = { type: 'secret_request', requestId: request.id, name: request.name, reason, placeholder, status: 'pending', ref: null, ...(replace ? { replace: true } : {}), expiresAt: request.expiresAt };
      const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt };
      thread.messages.push(message);
      ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
      ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
      let wake!: (result: RpcResult<'secrets.ask'>) => void;
      const done = new Promise<RpcResult<'secrets.ask'>>((resolve) => { wake = resolve; });
      const timer = setTimeout(() => {
        const card = ctx.pendingSecrets.get(request.id);
        if (card) settle(ctx, thread, card, 'timed_out', null, false);
      }, minutes * 60_000);
      const resolve = (result: RpcResult<'secrets.ask'>): void => { settled.set(request.id, { threadId: thread.id, result }); wake(result); };
      ctx.pendingSecrets.set(request.id, { request, message, timer, done, resolve });
      if (turn.status === 'running') {
        thread.status = 'waiting';
        ctx.touch(thread);
      }
      ctx.emit('secret.requested', structuredClone(request));
      return done;
    },
    'secrets.answer': async (params) => {
      const card = ctx.pendingSecrets.get(params.requestId);
      if (!card || card.request.threadId !== params.threadId) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'this secret card was already answered or closed', data: { requestId: params.requestId, field: 'requestId', expected: 'an open card' } });
      }
      const thread = ctx.thread(params.threadId);
      if ('declined' in params && params.declined === true) {
        settle(ctx, thread, card, 'declined', null, false);
        return { ok: true };
      }
      if (!encrypted(ctx)) throw refused('secrets.answer: a value travels only over an encrypted link; answer from the PC or over HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
      const keep = 'keep' in params && params.keep === true;
      const raw = 'value' in params ? params.value : undefined;
      if (typeof raw !== 'string') throw refused('value: expected text', { field: 'value', expected: 'a string' });
      // Only the length is kept: the fake stands in for a vault it never needs to read back.
      const bytes = encoder.encode(raw).length;
      if (bytes === 0 || bytes > SECRET_MAX_BYTES) throw refused(`value: expected 1 to ${SECRET_MAX_BYTES} bytes`, { field: 'value', expected: `1..${SECRET_MAX_BYTES} bytes` });
      const projectId = thread.projectId;
      if (keep && projectId === null) throw refused('keep: this conversation has no project to keep the key for', { field: 'keep', expected: false });
      if (keep && projectId !== null) {
        const name = card.request.name;
        ctx.secretKeys = [...ctx.secretKeys.filter((key) => !(key.projectId === projectId && key.name === name)), { projectId, name, createdAt: Date.now(), lastUsedAt: null, bytes }];
        changed(ctx, projectId);
        settle(ctx, thread, card, 'saved', projectSecretRef(name), true);
        return { ok: true };
      }
      settle(ctx, thread, card, 'saved', `secret:sec_${String(++ctx.seq).padStart(8, '0')}`, false);
      return { ok: true };
    },
    'secrets.use': async () => {
      throw refused('the in-memory core runs no command and writes no file with a secret', { field: 'use', expected: 'a real core' });
    },
    'secrets.list': async (params) => {
      const projectId = 'projectId' in params ? params.projectId : ctx.thread(params.threadId).projectId;
      if ('projectId' in params && !ctx.projects.some((project) => project.id === projectId)) throw ctx.notFound('project', params.projectId);
      const secrets = projectId === null ? [] : ctx.secretKeys
        .filter((key) => key.projectId === projectId)
        .map(({ projectId: owner, name, createdAt, lastUsedAt }) => ({ projectId: owner, name, createdAt, lastUsedAt }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { secrets, storage: STORAGE, encrypted: encrypted(ctx) };
    },
    'secrets.delete': async (params) => {
      if (!encrypted(ctx) && ctx.bus.principal !== 'owner') {
        throw refused('secrets.delete: a paired device deletes a key only over an encrypted link; delete from the PC or over HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
      }
      const kept = ctx.secretKeys.find((key) => key.projectId === params.projectId && key.name === params.name);
      if (!kept) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no key named ${params.name} is kept for this project`, data: { field: 'name', expected: 'a kept key of this project' } });
      ctx.secretKeys = ctx.secretKeys.filter((key) => key !== kept);
      changed(ctx, params.projectId);
      return { ok: true };
    }
  } satisfies Partial<FakeMethods>;
}
