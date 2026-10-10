import { createHash, ECDH } from 'node:crypto';
import { lastAgentText, notifiesOnFinish, requestExcerpt } from '@boite/contracts';
import type { CoordinationPeer, NotificationLabel, PushPayload, RpcEvents, RpcParams } from '@boite/contracts';
import type { PushSubscription } from 'web-push';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import type { AttentionReport } from './threads/focus.ts';
import { deviceElsewhere, ownDevice } from './group/devices.ts';

type Subscription = RpcParams<'push.subscribe'>;
type Keys = { publicKey: string; privateKey: string };
const SUBSCRIPTIONS = 'web-push.subscriptions';
const KEYS = 'web-push.keys';
const LABELS: readonly NotificationLabel[] = ['done', 'failed', 'needsYou', 'connected'];

/** What a member sends the home machine of a device: the push, without the id of the machine it is about, which the home adds. */
type Forwarded = { device: string; push: Omit<PushPayload, 'core'> };

/** A push a member forwarded, read field by field: it lands on this machine's subscription and nowhere else. */
function readForwarded(value: unknown): Forwarded {
  const bad = (field: string) => invalidParams(`group.push ${field} is malformed`, { field });
  if (typeof value !== 'object' || value === null) throw bad('payload');
  const { device, push } = value as { device?: unknown; push?: Record<string, unknown> };
  if (typeof device !== 'string' || device.length > 300) throw bad('device');
  if (typeof push !== 'object' || push === null) throw bad('push');
  const string = (field: string, max: number): string => {
    const text = push[field];
    if (typeof text !== 'string' || text.length > max) throw bad(`push.${field}`);
    return text;
  };
  const threadId = push['threadId'] === null ? null : string('threadId', 128);
  const label = push['label'];
  if (label !== undefined && !LABELS.includes(label as NotificationLabel)) throw bad('push.label');
  const badge = push['badge'];
  if (badge !== undefined && (!Number.isSafeInteger(badge) || (badge as number) < 0 || (badge as number) > 100_000)) throw bad('push.badge');
  return {
    device,
    push: {
      title: string('title', 300), body: string('body', 2000), threadId, tag: string('tag', 200),
      ...(label === undefined ? {} : { label: label as NotificationLabel }),
      ...(badge === undefined ? {} : { badge: badge as number }),
    },
  };
}

/** An authenticated phone cannot turn push delivery into a request to a local service. */
export function validateSubscription(value: Subscription): Subscription {
  let url: URL;
  try { url = new URL(value?.endpoint); } catch { throw invalidParams('push.subscribe endpoint must be an HTTPS push service URL'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowed || url.port || url.username || url.password || url.hash || value.endpoint.length > 4096) {
    throw invalidParams('push.subscribe endpoint must use HTTPS on an Apple, Google, Mozilla or Windows push service');
  }
  for (const [field, size] of [['p256dh', 65], ['auth', 16]] as const) {
    const key = value.keys?.[field];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key) || Buffer.from(key, 'base64url').length !== size) {
      throw invalidParams(`push.subscribe keys.${field} must be a ${size}-byte base64url key`);
    }
  }
  try { ECDH.convertKey(Buffer.from(value.keys.p256dh, 'base64url'), 'prime256v1'); }
  catch { throw invalidParams('push.subscribe keys.p256dh must be a valid P-256 public key'); }
  return { endpoint: url.href, keys: { ...value.keys } };
}

/** Loaded by the core without loading the encryption library or making a network request. */
export class PushStore {
  private readonly off: () => void;
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private keysPromise: Promise<Keys> | null = null;
  /** By tag, the pushes held back while their thread is watched (`notify`). */
  private readonly held = new Map<string, { threadId: string; text: Pick<PushPayload, 'body' | 'label'>; at: number }>();
  private heldTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly offAttention: () => void;

  constructor(private readonly core: Core) {
    this.offAttention = core.threads.focus.onAttention(report => this.attention(report));
    this.off = core.bus.onAny((name, payload) => {
      if (name === 'sessions.updated' && (payload as RpcEvents['sessions.updated']).state === 'revoked') {
        this.remove((payload as RpcEvents['sessions.updated']).sessionId);
      } else if (name === 'permission.requested' || name === 'question.asked') {
        const request = payload as RpcEvents['permission.requested'] | RpcEvents['question.asked'];
        const text = requestExcerpt(request);
        this.notify(request.threadId, text ? { body: text } : { body: 'Needs your answer', label: 'needsYou' }, `request-${request.id}`);
      } else if (name === 'turn.finished') {
        const turn = payload as RpcEvents['turn.finished'];
        if (this.closed || this.core.journal.isClosed() || (turn.status !== 'done' && turn.status !== 'error')) return;
        const thread = this.core.journal.getThread(turn.threadId);
        if (thread === null || !notifiesOnFinish(thread, turn, this.activeChildren(thread.id))) return;
        // The reply is the news; an error's own message is often a stack or a
        // provider's JSON, so the phone says only that the turn failed.
        const reply = turn.status === 'done' ? this.lastReply(turn.threadId, turn.id) : null;
        this.notify(turn.threadId, reply ? { body: reply }
          : turn.status === 'done' ? { body: 'Done', label: 'done' } : { body: 'The agent encountered an error', label: 'failed' }, `turn-${turn.id}`);
      }
    });
  }

  /** The start of what the agent last wrote in the turn, one line. */
  private lastReply(threadId: string, turnId: string): string | null {
    for (const message of this.core.journal.walkAgentMessagesBackwards(threadId, turnId)) {
      const text = lastAgentText([message]);
      if (text) return text;
    }
    return null;
  }

  /** The parent's delegated agents with a turn still under way. */
  private activeChildren(threadId: string): number {
    const row = this.core.journal.db
      .query("SELECT COUNT(*) AS count FROM threads WHERE parent_thread_id = ? AND status IN ('queued', 'running', 'waiting')")
      .get(threadId) as { count: number };
    return row.count;
  }

  private subscriptions(): Record<string, Subscription> {
    return (this.core.journal.getSetting(SUBSCRIPTIONS) as Record<string, Subscription> | null) ?? {};
  }

  private requireSession(sessionId: string | null): string {
    if (!sessionId || !this.core.journal.getSession(sessionId)) throw refused('push requires a paired device session');
    return sessionId;
  }

  private keys(): Promise<Keys> {
    this.keysPromise ??= (async () => {
      const existing = this.core.journal.getSetting(KEYS) as Keys | null;
      if (existing) return existing;
      const { default: webpush } = await import('web-push');
      const generated = webpush.generateVAPIDKeys();
      // Secrets belong to private storage, never the append-only event payload.
      this.core.journal.setSetting(KEYS, generated);
      return generated;
    })().catch(error => { this.keysPromise = null; throw error; });
    return this.keysPromise;
  }

  async status(sessionId: string | null) {
    const id = this.requireSession(sessionId);
    return { publicKey: (await this.keys()).publicKey, subscribed: Boolean(this.subscriptions()[id]) };
  }

  subscribe(sessionId: string | null, input: Subscription) {
    const id = this.requireSession(sessionId);
    // Its pushes go through the machine whose page it installed (`deliverAll`): one here would come without the machine the thread is on.
    const home = deviceElsewhere(this.core, id)?.home;
    if (home !== undefined) throw refused(`notifications of this device come through ${home.name}, the machine it was paired with: enable them there`);
    const subscription = validateSubscription(input);
    const all = this.subscriptions();
    // A new pairing of the same browser replaces its old delivery destination.
    for (const [key, previous] of Object.entries(all)) if (previous.endpoint === subscription.endpoint) delete all[key];
    all[id] = subscription;
    this.core.journal.append({ type: 'push.subscribed', threadId: null, version: 1, payload: { sessionId: id } }, () => {
      this.core.journal.setSetting(SUBSCRIPTIONS, all);
    });
    return { ok: true } as const;
  }

  remove(sessionId: string) {
    const all = this.subscriptions();
    if (all[sessionId]) {
      delete all[sessionId];
      this.core.journal.append({ type: 'push.unsubscribed', threadId: null, version: 1, payload: { sessionId } }, () => {
        this.core.journal.setSetting(SUBSCRIPTIONS, all);
      });
    }
    return { ok: true } as const;
  }

  unsubscribe(sessionId: string | null) { return this.remove(this.requireSession(sessionId)); }

  /**
   * What the app icon's badge says: the threads waiting for the user, the
   * same count the window title shows. The thread being notified about counts
   * even when its row has not caught up with the event yet.
   */
  badge(threadId: string | null = null): number {
    if (this.core.journal.isClosed()) return 0;
    const rows = this.core.journal.db
      .query("SELECT id FROM threads WHERE archived = 0 AND (unread != 0 OR status = 'waiting')")
      .all() as { id: string }[];
    const ids = new Set(rows.map((row) => row.id));
    // A question asked without stopping leaves the status alone: its thread waits on the user all the same.
    for (const question of this.core.threads?.cards.listQuestions() ?? []) {
      if (question.async === true && this.core.journal.getThread(question.threadId)?.archived === false) ids.add(question.threadId);
    }
    if (threadId !== null && this.core.journal.getThread(threadId)?.archived === false) ids.add(threadId);
    return ids.size;
  }

  /**
   * The thread is on a screen someone is looking at, on any of their devices:
   * push would only interrupt. It waits instead. Using that screen after the
   * news arrived shows it was seen and drops it; looking away, a page going
   * quiet or a lease nobody renews sends it.
   */
  private notify(threadId: string, text: Pick<PushPayload, 'body' | 'label'>, tag: string) {
    if (this.closed) return;
    if (this.core.threads.focus.attended(threadId)) {
      this.held.set(tag, { threadId, text, at: Date.now() });
      this.releaseHeld();
    } else this.deliverAll(threadId, text, tag);
  }

  /** What a report says of the held pushes: use of their thread since they arrived drops them, then any no longer watched go. */
  private attention({ threadId, activeAt }: AttentionReport) {
    if (threadId !== null && activeAt !== null) {
      for (const [tag, held] of this.held) if (held.threadId === threadId && activeAt >= held.at) this.held.delete(tag);
    }
    this.releaseHeld();
  }

  /** Sends the held pushes nobody is watching any more and wakes up when the next lease ends. Public for tests that move the clock. */
  releaseHeld() {
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    if (this.closed) return;
    let next = Infinity;
    for (const [tag, held] of this.held) {
      const until = this.core.threads.focus.attendedUntil(held.threadId);
      if (until > 0) { next = Math.min(next, until); continue; }
      this.held.delete(tag);
      this.deliverAll(held.threadId, held.text, tag);
    }
    if (next !== Infinity) {
      this.heldTimer = setTimeout(() => this.releaseHeld(), Math.max(0, next - Date.now()) + 50);
      this.heldTimer.unref?.();
    }
  }

  private deliverAll(threadId: string, text: Pick<PushPayload, 'body' | 'label'>, tag: string) {
    const title = this.core.journal.getThread(threadId)?.title ?? 'Boite';
    const badge = this.badge(threadId);
    const subscriptions = this.subscriptions();
    for (const sessionId of Object.keys(subscriptions)) {
      this.track(this.deliver(sessionId, { title, ...text, threadId, tag, badge }).catch(() => {
        this.core.log('warn', 'Web Push delivery failed; the conversation remains available in Boite');
      }));
    }
    // A device paired with another member of the group installed that member's page, and its push
    // subscription is there: the news goes through that machine, once per device.
    const forwarded = new Set<string>();
    for (const session of this.core.journal.listSessions()) {
      if (subscriptions[session.id]) continue;
      const target = deviceElsewhere(this.core, session.id);
      if (target === null || forwarded.has(target.device)) continue;
      forwarded.add(target.device);
      // Cut to what the home machine reads (`readForwarded`), so a long title or reply still arrives.
      const payload: Forwarded = { device: target.device, push: { title: title.slice(0, 300), body: text.body.slice(0, 2000),
        ...(text.label === undefined ? {} : { label: text.label }), threadId: threadId.slice(0, 128), tag: tag.slice(0, 200), badge } };
      this.track(this.forward(target.home, payload).catch(() => {
        this.core.log('warn', `a notification for a device of ${target.home.name} did not reach that machine; the conversation remains available in Boite`);
      }));
    }
  }

  /** Overridden in tests that count what crosses without a second machine's push service. */
  forward = (home: CoordinationPeer, payload: Forwarded): Promise<unknown> => this.core.coordination.request(home, 'group.push', payload);

  /**
   * A push another member of the group sends a device of this machine. It goes
   * to that device's subscription here, marked with the machine the thread is
   * on so a tap opens it there. Accepted only for a device the roster lists as
   * this machine's: a member cannot push to anything else through it.
   */
  relayed(from: CoordinationPeer, value: unknown): { delivered: boolean } {
    if (!this.core.group.peers().some((member) => member.coreId === from.coreId)) throw refused('only a machine of this group sends its devices notifications');
    const { device, push } = readForwarded(value);
    const sessionId = ownDevice(this.core, device);
    if (sessionId === null) throw refused(`group.push device ${device} is not a device of this machine`);
    if (this.closed || !this.subscriptions()[sessionId]) return { delivered: false };
    // The icon counts the threads waiting here as well as there.
    const badge = (push.badge ?? 0) + this.badge();
    // A tag of that machine's never replaces a notification of this one's.
    const tag = `${from.coreId.slice(0, 16)}:${push.tag}`;
    this.track(this.deliver(sessionId, { ...push, tag, badge, core: from.coreId }).catch(() => {
      this.core.log('warn', `Web Push delivery of a notification from ${from.name} failed`);
    }));
    return { delivered: true };
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  /** Override the sender in tests to exercise lifecycle without contacting push providers. */
  send = async (subscription: PushSubscription, payload: string, keys: Keys, topic: string): Promise<void> => {
    const { default: webpush } = await import('web-push');
    await webpush.sendNotification(subscription, payload, {
      vapidDetails: { ...keys, subject: this.core.settings.get().publicUrl ?? 'https://github.com/beboite/boite' },
      TTL: 300, timeout: 10_000, urgency: 'normal', topic
    });
  };

  private async deliver(sessionId: string, payload: PushPayload): Promise<void> {
    const keys = await this.keys();
    if (this.closed || !this.core.journal.getSession(sessionId)) return;
    const subscription = this.subscriptions()[sessionId];
    if (!subscription) return;
    try {
      await this.send(subscription, JSON.stringify(payload), keys, createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if ((status === 404 || status === 410) && this.subscriptions()[sessionId]?.endpoint === subscription.endpoint) this.remove(sessionId);
      // Provider errors often contain the endpoint and encryption material. Do not forward them.
      throw refused(`Web Push delivery failed${status ? ` (${status})` : ''}`);
    }
  }

  async test(sessionId: string | null) {
    const id = this.requireSession(sessionId);
    if (!this.subscriptions()[id]) throw refused('Enable notifications on this device first');
    await this.track(this.deliver(id, { title: 'Boite', body: 'Notifications are connected', label: 'connected', threadId: null, tag: 'test' }));
    return { ok: true } as const;
  }

  async close() {
    this.closed = true;
    this.off();
    this.offAttention();
    clearTimeout(this.heldTimer);
    this.held.clear();
    await Promise.allSettled([...this.pending]);
  }
}

export function registerPushMethods(core: Core) {
  core.router.register('push.status', (_params, ctx) => core.push.status(ctx.connection.identity.sessionId));
  core.router.register('push.subscribe', (params, ctx) => core.push.subscribe(ctx.connection.identity.sessionId, params));
  core.router.register('push.unsubscribe', (_params, ctx) => core.push.unsubscribe(ctx.connection.identity.sessionId));
  core.router.register('push.test', (_params, ctx) => core.push.test(ctx.connection.identity.sessionId));
}
