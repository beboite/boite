import {
  RpcErrorCode,
  SECRET_ASK_MAX_TIMEOUT_MINUTES,
  SECRET_ASK_TIMEOUT_MINUTES,
  SECRET_MAX_BYTES,
  SECRET_NAME_PATTERN,
  SECRET_TRANSIT_TTL_MS,
  type Message,
  type MessagePart,
  type RpcResult,
  type SecretAskOutcome,
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

/** A synthetic one-use copy: only metadata is retained, never a value. */
export interface FakeSecretTransit {
  threadId: string;
  turnId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

type SecretPart = Extract<MessagePart, { type: 'secret_request' }>;

const STORAGE = 'memory' as const;
const encoder = new TextEncoder();

function refused(message: string, data: Record<string, unknown> = {}): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

/** As the core's `connection.encrypted`: a phone over plain HTTP carries no value. */
function encrypted(ctx: FakeContext): boolean {
  return !ctx.plainLink;
}

function forget(ctx: FakeContext, ref: string): void {
  const copy = ctx.secretTransits.get(ref);
  if (copy) clearTimeout(copy.timer);
  ctx.secretTransits.delete(ref);
}

/** Closing the synthetic core clears pending cards and all transit metadata. */
export function closeSecrets(ctx: FakeContext): void {
  for (const threadId of new Set([...ctx.pendingSecrets.values()].map(card => card.request.threadId))) cancelSecretCards(ctx, threadId);
  for (const ref of ctx.secretTransits.keys()) forget(ctx, ref);
  ctx.settledSecrets.clear();
}

/** Rewrites the card where it is drawn, tells every client and wakes the `ask`, as the core's `#settle`. */
function settle(ctx: FakeContext, thread: Thread | undefined, card: FakeSecretCard, status: SecretAskOutcome, ref: string | null): void {
  if (ctx.pendingSecrets.get(card.request.id) !== card) return;
  ctx.pendingSecrets.delete(card.request.id);
  clearTimeout(card.timer);
  const drawn = card.message.parts[0] as SecretPart;
  const part: SecretPart = { ...drawn, status, ref };
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
  for (const [ref, copy] of ctx.secretTransits) {
    if (copy.threadId === threadId && (turnId === undefined || copy.turnId === turnId)) forget(ctx, ref);
  }
  for (const card of [...ctx.pendingSecrets.values()]) {
    if (card.request.threadId !== threadId || (turnId !== undefined && card.request.turnId !== turnId)) continue;
    const thread = ctx.threads.get(threadId);
    settle(ctx, thread, card, 'cancelled', null);
  }
}

export function secretMethods(ctx: FakeContext) {
  // What a closed card answered, so a retry with its id gets it again, as the core's `#settled`.
  const settled = ctx.settledSecrets;
  return {
    'secrets.pending': async (params) => {
      if ('threadId' in params) {
        if (typeof params.threadId !== 'string') throw refused('secrets.pending: threadId must be a string', { field: 'threadId', expected: 'a thread id' });
        ctx.thread(params.threadId);
      }
      const rows: SecretRequest[] = [];
      for (const card of [...ctx.pendingSecrets.values()]) {
        if (params.threadId !== undefined && card.request.threadId !== params.threadId) continue;
        if (card.request.expiresAt <= Date.now()) settle(ctx, ctx.thread(card.request.threadId), card, 'timed_out', null);
        else rows.push(structuredClone(card.request));
      }
      return rows;
    },
    'secrets.ask': async (params) => {
      const thread = ctx.thread(params.threadId);
      if ((params as { replace?: unknown }).replace !== undefined && params.replace !== false) throw refused('replace: persistent project keys are no longer supported', { field: 'replace', expected: false });
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
      // Like `questions.ask` here, the last turn stands in for a running one, so a demo draws a card after the echo reply.
      const turn = thread.turns.find((entry) => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) throw refused('a secret card opens only while a turn runs', { threadId: thread.id });
      const createdAt = ctx.now();
      const placeholder = params.placeholder?.trim() || null;
      // The fake's clock starts in the past; the card compares its deadline with the real one, so this one is real.
      const request: SecretRequest = {
        id: params.requestId ?? `sreq_${++ctx.seq}`, threadId: thread.id, turnId: turn.id, name: params.name, reason, placeholder,
        status: 'pending', ref: null, expiresAt: Date.now() + minutes * 60_000, createdAt
      };
      const part: SecretPart = { type: 'secret_request', requestId: request.id, name: request.name, reason, placeholder, status: 'pending', ref: null, expiresAt: request.expiresAt };
      const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [part], state: 'complete', createdAt };
      thread.messages.push(message);
      ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
      ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
      let wake!: (result: RpcResult<'secrets.ask'>) => void;
      const done = new Promise<RpcResult<'secrets.ask'>>((resolve) => { wake = resolve; });
      const timer = setTimeout(() => {
        const card = ctx.pendingSecrets.get(request.id);
        if (card) settle(ctx, thread, card, 'timed_out', null);
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
      if ('keep' in params && params.keep !== undefined && params.keep !== false) throw refused('keep: persistent project keys are no longer supported', { field: 'keep', expected: false });
      const card = ctx.pendingSecrets.get(params.requestId);
      if (!card || card.request.threadId !== params.threadId) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'this secret card was already answered or closed', data: { requestId: params.requestId, field: 'requestId', expected: 'an open card' } });
      }
      const thread = ctx.thread(params.threadId);
      if ('declined' in params && params.declined === true) {
        settle(ctx, thread, card, 'declined', null);
        return { ok: true };
      }
      if (!encrypted(ctx)) throw refused('secrets.answer: a value travels only over an encrypted link; answer from the PC or over HTTPS', { field: 'connection', expected: 'loopback, Tailscale or HTTPS' });
      const raw = 'value' in params ? params.value : undefined;
      if (typeof raw !== 'string') throw refused('value: expected text', { field: 'value', expected: 'a string' });
      // Validate the bytes, then discard them: the fake never executes with a value.
      const buffer = encoder.encode(raw);
      const bytes = buffer.length;
      buffer.fill(0);
      if (bytes === 0 || bytes > SECRET_MAX_BYTES) throw refused(`value: expected 1 to ${SECRET_MAX_BYTES} bytes`, { field: 'value', expected: `1..${SECRET_MAX_BYTES} bytes` });
      if (card.request.expiresAt <= Date.now()) {
        settle(ctx, thread, card, 'timed_out', null);
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'this secret card has expired', data: { field: 'requestId', expected: 'an open card' } });
      }
      const ref = `secret:sec_${String(++ctx.seq).padStart(8, '0')}`;
      const timer = setTimeout(() => forget(ctx, ref), SECRET_TRANSIT_TTL_MS);
      ctx.secretTransits.set(ref, { threadId: thread.id, turnId: card.request.turnId, expiresAt: Date.now() + SECRET_TRANSIT_TTL_MS, timer });
      settle(ctx, thread, card, 'saved', ref);
      return { ok: true };
    },
    'secrets.use': async (params) => {
      const thread = ctx.thread(params.threadId);
      const copy = ctx.secretTransits.get(params.ref);
      if (!copy || copy.threadId !== thread.id) throw ctx.notFound('secret ref', params.ref);
      if (copy.expiresAt <= Date.now() || thread.archived || thread.turns.at(-1)?.id !== copy.turnId) {
        forget(ctx, params.ref);
        throw ctx.notFound('secret ref', params.ref);
      }
      // An operation consumes the copy even when it fails. Never simulate a successful file write or command.
      forget(ctx, params.ref);
      throw refused('the in-memory core runs no command and writes no file with a secret', { field: 'use', expected: 'a real core' });
    },
    'secrets.list': async (params) => {
      if ('projectId' in params) {
        if (!ctx.projects.some((project) => project.id === params.projectId)) throw ctx.notFound('project', params.projectId);
      } else ctx.thread(params.threadId);
      return { secrets: [], storage: STORAGE, encrypted: encrypted(ctx) };
    },
    'secrets.delete': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'Secret Drop keeps no persistent project keys', data: { projectId: params.projectId, name: params.name, field: 'name', expected: 'no persistent project key' } });
    }
  } satisfies Partial<FakeMethods>;
}
