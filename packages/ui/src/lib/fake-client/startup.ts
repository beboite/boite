import { FakeAttachmentUploads } from './attachment-uploads';
import { RpcErrorCode, type RpcParams, type Thread } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';
import { createFakeThread, publishFakeThread } from './create-thread';
import { toSummary } from './shared';
import { pathKey } from './checks';

type Reservation = { params: RpcParams<'drafts.prepare'>; thread: Thread; expires: number };
type State = { reservations: Map<string, Reservation>; canceled: Set<string>; epoch: number; pending: Map<string, { key: string; promise: Promise<Reservation> }>; uploads: FakeAttachmentUploads; receipt?: { id: string; key: string; threadId: string; expires: number } };
const states = new WeakMap<FakeContext, State>();
const ttl = 10 * 60_000;
const refusal = (reason: string) => new RpcFailure({ code: RpcErrorCode.Refused, message: reason, data: { reason } });
const selection = (p: RpcParams<'threads.create'>) => JSON.stringify([p.projectId, p.providerId, p.accountId, p.model ?? null,
  p.effort ?? null, p.speed ?? null, p.permissionMode ?? 'default', p.cwd ?? null, p.worktree ?? null, p.incognito ?? false, p.context ?? null]);
function dispose(ctx: FakeContext, reservation: Reservation): void {
  if (reservation.thread.branch) ctx.worktrees = ctx.worktrees.filter(worktree => pathKey(worktree.path) !== pathKey(reservation.thread.cwd));
}
export function resetStartup(ctx: FakeContext): void {
  const state = states.get(ctx);
  if (!state) return;
  for (const reservation of state.reservations.values()) dispose(ctx, reservation);
  state.epoch++; state.receipt = undefined; state.reservations.clear(); state.canceled.clear(); state.pending.clear(); state.uploads.clear();
}

/** The fake leases use the connection lifecycle and never appear in thread lists. */
export function startupMethods(ctx: FakeContext, threads: Pick<FakeMethods, 'threads.create' | 'turns.start'>): Pick<FakeMethods, 'drafts.prepare' | 'drafts.release' | 'attachments.upload' | 'attachments.release' | 'threads.create' | 'turns.start'> {
  const state: State = { reservations: new Map(), canceled: new Set(), epoch: 0, pending: new Map(), uploads: new FakeAttachmentUploads(ctx) };
  states.set(ctx, state);
  return {
    'drafts.prepare': async params => {
      if (typeof params.preparationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(params.preparationId)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'preparationId: expected 8 to 128 URL-safe characters' });
      if (state.canceled.has(params.preparationId)) throw refusal('draft-preparation-expired');
      const held = state.reservations.get(params.preparationId);
      if (held) {
        if (held.expires <= Date.now()) { dispose(ctx, held); state.reservations.delete(params.preparationId); state.canceled.add(params.preparationId); throw refusal('draft-preparation-expired'); }
        if (selection(held.params) !== selection(params)) throw refusal('draft-preparation-mismatch');
        return { preparationId: params.preparationId, threadId: held.thread.id };
      }
      for (const [id, prior] of state.reservations) if (id !== params.preparationId) {
        dispose(ctx, prior); state.reservations.delete(id); state.canceled.add(id);
      }
      for (const id of state.pending.keys()) if (id !== params.preparationId) { state.canceled.add(id); state.pending.delete(id); }
      const existing = state.pending.get(params.preparationId);
      if (existing && existing.key !== selection(params)) throw refusal('draft-preparation-mismatch');
      const epoch = state.epoch;
      const pending = existing ?? { key: selection(params), promise: createFakeThread(ctx, params).then(thread => {
        const reservation = { params, thread, expires: Date.now() + ttl };
        if (state.epoch !== epoch || state.canceled.has(params.preparationId)) { dispose(ctx, reservation); throw refusal('draft-preparation-expired'); }
        state.reservations.set(params.preparationId, reservation);
        return reservation;
      }) };
      state.pending.set(params.preparationId, pending);
      try {
        const reserved = await pending.promise;
        return { preparationId: params.preparationId, threadId: reserved.thread.id };
      } finally { if (state.pending.get(params.preparationId) === pending) state.pending.delete(params.preparationId); }
    },
    'drafts.release': async ({ preparationId }) => {
      if (typeof preparationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(preparationId)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'preparationId: expected 8 to 128 URL-safe characters' });
      if (state.canceled.size >= 32) state.canceled.delete(state.canceled.values().next().value!);
      state.canceled.add(preparationId);
      const held = state.reservations.get(preparationId);
      if (held) dispose(ctx, held);
      state.reservations.delete(preparationId);
      return { ok: true };
    },
    'threads.create': async params => {
      const held = params.preparationId ? state.reservations.get(params.preparationId) : undefined;
      if (!held || held.expires <= Date.now()) {
        if (held) { dispose(ctx, held); state.reservations.delete(params.preparationId!); }
        const receipt = state.receipt;
        if (receipt && receipt.id === params.preparationId && receipt.key === selection(params) && receipt.expires > Date.now()) {
          if (params.subscribe) ctx.bus.subscribed.add(receipt.threadId);
          return structuredClone(toSummary(ctx.thread(receipt.threadId)));
        }
        return threads['threads.create'](params);
      }
      if (selection(held.params) !== selection(params)) throw refusal('draft-preparation-mismatch');
      state.reservations.delete(params.preparationId!);
      if (params.title) held.thread.title = params.title;
      state.receipt = { id: params.preparationId!, key: selection(params), threadId: held.thread.id, expires: Date.now() + ttl };
      return publishFakeThread(ctx, held.thread, params.subscribe);
    },
    ...state.uploads.methods(),
    'turns.start': params => threads['turns.start'](state.uploads.resolve(params))
  };
}
