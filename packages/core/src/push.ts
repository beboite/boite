import { createHash, ECDH, randomUUID } from 'node:crypto';
import { lastAgentText, NOTIFICATION_KINDS, notificationExcerpt, notifiesOnFinish, quotaAlertLeft, quotaAlertTitle, requestExcerpt, requestKind } from '@boite/contracts';
import type { CoordinationPeer, NotificationKind, NotificationLabel, PushPayload, QuotaAlert, RpcEvents, RpcParams } from '@boite/contracts';
import type { PushSubscription } from 'web-push';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import type { AttentionReport } from './threads/focus.ts';
import { deviceElsewhere, ownDevice } from './group/devices.ts';
import { backgroundWaitOf } from './threads/records.ts';

/** A device's destination; without `kinds`, written before devices chose, it receives every kind. */
type Subscription = RpcParams<'push.subscribe'>;
/** What a push says before it has a badge; the title is the thread's unless the news brings one. */
type News = Pick<PushPayload, 'body' | 'label' | 'values'> & { kind: NotificationKind; title?: string };
type Keys = { publicKey: string; privateKey: string };
const SUBSCRIPTIONS = 'web-push.subscriptions';
const KEYS = 'web-push.keys';
const LABELS: readonly NotificationLabel[] = ['done', 'failed', 'needsYou', 'connected', 'limitFiveHour', 'limitWeekly'];

/**
 * What a member sends the home machine of a device: the push, without the id of
 * the machine it is about, which the home adds. `id` is the same on every
 * address the sender tries, so the home pushes once however many reach it.
 */
type Forwarded = { id: string; device: string; push: Omit<PushPayload, 'core'> };
/** How long a forwarded push's id is remembered: past the minute a coordination request is accepted in. */
const FORWARD_IDS_MS = 120_000;

/** A push a member forwarded, read field by field: it lands on this machine's subscription and nowhere else. */
function readForwarded(value: unknown): Forwarded {
  const bad = (field: string) => invalidParams(`group.push ${field} is malformed`, { field });
  if (typeof value !== 'object' || value === null) throw bad('payload');
  const { id, device, push } = value as { id?: unknown; device?: unknown; push?: Record<string, unknown> };
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
  // A member older than kinds sends none: its pushes go to every subscription, as they did.
  const kind = push['kind'];
  if (kind !== undefined && !NOTIFICATION_KINDS.includes(kind as NotificationKind)) throw bad('push.kind');
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw bad('id');
  const values = push['values'];
  if (values !== undefined && (typeof values !== 'object' || values === null || Object.keys(values).some((name) => name !== 'percent')
    || typeof (values as { percent?: unknown }).percent !== 'string' || (values as { percent: string }).percent.length > 16)) throw bad('push.values');
  return {
    id,
    device,
    push: {
      title: string('title', 300), body: string('body', 2000), threadId, tag: string('tag', 200),
      ...(label === undefined ? {} : { label: label as NotificationLabel }),
      ...(kind === undefined ? {} : { kind: kind as NotificationKind }),
      ...(badge === undefined ? {} : { badge: badge as number }),
      ...(values === undefined ? {} : { values: { percent: (values as { percent: string }).percent } }),
    },
  };
}

/** The kinds a device chose, each once, in the settings' order. */
export function validateKinds(value: unknown, method: string): NotificationKind[] {
  if (!Array.isArray(value) || value.some(kind => !NOTIFICATION_KINDS.includes(kind))) {
    throw invalidParams(`${method} kinds must be a list of ${NOTIFICATION_KINDS.join(', ')}`, { field: 'kinds', expected: NOTIFICATION_KINDS });
  }
  return NOTIFICATION_KINDS.filter(kind => value.includes(kind));
}

/** Whether a subscription receives a push of this kind. One without a kind, the test, goes to all. */
function wants(subscription: Subscription, kind: NotificationKind | undefined): boolean {
  return kind === undefined || subscription.kinds === undefined || subscription.kinds.includes(kind);
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
  const kinds = value.kinds === undefined ? undefined : validateKinds(value.kinds, 'push.subscribe');
  return { endpoint: url.href, keys: { ...value.keys }, ...(kinds === undefined ? {} : { kinds }) };
}

/** Loaded by the core without loading the encryption library or making a network request. */
export class PushStore {
  readonly #off: () => void;
  #pending = new Set<Promise<unknown>>();
  #closed = false;
  #keysPromise: Promise<Keys> | null = null;
  /** By tag, the pushes held back while their thread is watched (`notify`). */
  readonly #held = new Map<string, { threadId: string; text: News; at: number }>();
  #heldTimer: ReturnType<typeof setTimeout> | undefined;
  /** When each forwarded push arrived, by sender and id (`relayed`). */
  readonly #forwards = new Map<string, number>();
  readonly #offAttention: () => void;

  readonly #core: Core;

  constructor(core: Core) {
    this.#core = core;
    this.#offAttention = core.threads.focus.onAttention(report => this.#attention(report));
    this.#off = core.bus.onAny((name, payload) => {
      if (name === 'sessions.updated' && (payload as RpcEvents['sessions.updated']).state === 'revoked') {
        this.remove((payload as RpcEvents['sessions.updated']).sessionId);
      } else if (name === 'permission.requested' || name === 'question.asked') {
        const request = payload as RpcEvents['permission.requested'] | RpcEvents['question.asked'];
        const text = requestExcerpt(request);
        const kind = requestKind(request);
        this.notify(request.threadId, text ? { body: text, kind } : { body: 'Needs your answer', label: 'needsYou', kind }, `request-${request.id}`, true);
      } else if (name === 'message.started') {
        // A capture waiting on the owner's consent card, which no question or permission event announces.
        const message = payload as RpcEvents['message.started'];
        const consent = message.parts.find(part => part.type === 'window_consent');
        if (consent?.type === 'window_consent') this.notify(message.threadId, { body: `Wants to capture ${consent.process}`, kind: 'approvals' }, `request-${consent.requestId}`, true);
      } else if (name === 'secret.requested') {
        // Only that the user is needed: the push service is a third party, and a value never comes this way.
        const request = payload as RpcEvents['secret.requested'];
        this.notify(request.threadId, { body: 'Needs your answer', label: 'needsYou', kind: 'questions' }, `request-${request.id}`, true);
      } else if (name === 'turn.finished') {
        const turn = payload as RpcEvents['turn.finished'];
        if (this.#closed || this.#core.journal.isClosed() || (turn.status !== 'done' && turn.status !== 'error') || !this.reachable()) return;
        const thread = this.#core.journal.getThread(turn.threadId);
        if (thread === null || !notifiesOnFinish(thread, turn, this.#activeChildren(thread.id))) return;
        // The reply is the news; an error's own message is often a stack or a
        // provider's JSON, so the phone says only that the turn failed.
        const reply = turn.status === 'done' ? this.#lastReply(turn.threadId, turn.id) : null;
        const kind = turn.status === 'done' ? 'finished' : 'errors';
        this.notify(turn.threadId, reply ? { body: reply, kind }
          : turn.status === 'done' ? { body: 'Done', label: 'done', kind } : { body: 'The agent encountered an error', label: 'failed', kind }, `turn-${turn.id}`);
      } else if (name === 'quotas.alerted') {
        if (this.#closed || this.#core.journal.isClosed() || !this.reachable()) return;
        this.#deliverAll(null, limitNews(payload as QuotaAlert), `limit-${(payload as QuotaAlert).accountId}-${(payload as QuotaAlert).window.id}`);
      }
    });
  }

  /** A bot's private post to the owner in a team chat, which runs no turn of its own to report. */
  teamPost(threadId: string, body: string, tag: string): void {
    if (this.#closed || this.#core.journal.isClosed()) return;
    this.notify(threadId, { body: notificationExcerpt(body), kind: 'finished' }, tag);
  }

  /** The start of what the agent last wrote in the turn, one line. */
  #lastReply(threadId: string, turnId: string): string | null {
    for (const message of this.#core.journal.walkAgentMessagesBackwards(threadId, turnId)) {
      const text = lastAgentText([message]);
      if (text) return text;
    }
    return null;
  }

  /** The parent's delegated agents with a turn still under way, or at rest waiting on their own background work. */
  #activeChildren(threadId: string): number {
    const rows = this.#core.journal.db
      .query('SELECT id, status FROM threads WHERE parent_thread_id = ?')
      .all(threadId) as { id: string; status: string }[];
    return rows.filter(row => {
      // A persistent agent's memory pass is Boite's own housekeeping: the answer it follows is already the news.
      if (this.#core.workforce?.memory.owns(row.id)) return false;
      if (row.status === 'queued' || row.status === 'running' || row.status === 'waiting') return true;
      const live = this.#core.threads.agentState.background.get(row.id) ?? [];
      if (live.length > 0) return true;
      const thread = this.#core.journal.getThread(row.id);
      return thread !== null && backgroundWaitOf(this.#core, thread, live)?.state === 'waiting';
    }).length;
  }

  /**
   * Whether a push could reach anybody: a subscription here, or another member
   * a device paired with this machine gets its pushes through. Checked when the
   * news happens, so a phone that subscribes mid-turn hears the next one.
   */
  private reachable(): boolean {
    return Object.keys(this.#subscriptions()).length > 0 || this.#core.group.peers().length > 0;
  }

  #subscriptions(): Record<string, Subscription> {
    return (this.#core.journal.getSetting(SUBSCRIPTIONS) as Record<string, Subscription> | null) ?? {};
  }

  #requireSession(sessionId: string | null): string {
    if (!sessionId || !this.#core.journal.getSession(sessionId)) throw refused('push requires a paired device session');
    return sessionId;
  }

  private keys(): Promise<Keys> {
    this.#keysPromise ??= (async () => {
      const existing = this.#core.journal.getSetting(KEYS) as Keys | null;
      if (existing) return existing;
      const { default: webpush } = await import('web-push');
      const generated = webpush.generateVAPIDKeys();
      // Secrets belong to private storage, never the append-only event payload.
      this.#core.journal.setSetting(KEYS, generated);
      return generated;
    })().catch(error => { this.#keysPromise = null; throw error; });
    return this.#keysPromise;
  }

  async status(sessionId: string | null) {
    const id = this.#requireSession(sessionId);
    const subscription = this.#subscriptions()[id];
    return { publicKey: (await this.keys()).publicKey, subscribed: Boolean(subscription), ...(subscription ? { kinds: subscription.kinds ?? [...NOTIFICATION_KINDS] } : {}) };
  }

  subscribe(sessionId: string | null, input: Subscription) {
    const id = this.#requireSession(sessionId);
    // A device key subscribes on the machine whose page it installed, this one: the others send its notifications here from now on.
    const keyed = this.#core.group.clients.deviceOf(id);
    // A pairing of the older kind gets its pushes through the machine it paired with (`deliverAll`): one here would come without the machine the thread is on.
    const home = keyed === undefined ? deviceElsewhere(this.#core, id)?.home : undefined;
    if (home !== undefined) throw refused(`notifications of this device come through ${home.name}, the machine it was paired with: enable them there`);
    const subscription = validateSubscription(input);
    const all = this.#subscriptions();
    // A new pairing of the same browser replaces its old delivery destination.
    for (const [key, previous] of Object.entries(all)) if (previous.endpoint === subscription.endpoint) delete all[key];
    all[id] = subscription;
    this.#core.journal.append({ type: 'push.subscribed', threadId: null, version: 1, payload: { sessionId: id } }, () => {
      this.#core.journal.setSetting(SUBSCRIPTIONS, all);
    });
    // Once the subscription is written, never before, and outside its transaction: the others send its notifications here from then on.
    if (keyed !== undefined) this.#core.group.clients.pushedHere(keyed);
    return { ok: true } as const;
  }

  /** The kinds this device's subscription receives from now on: the subscription stays, only what reaches it changes. */
  setKinds(sessionId: string | null, params: RpcParams<'push.kinds'>) {
    const id = this.#requireSession(sessionId);
    const kinds = validateKinds(params?.kinds, 'push.kinds');
    const all = this.#subscriptions();
    const subscription = all[id];
    if (!subscription) throw refused('Enable notifications on this device first');
    all[id] = { ...subscription, kinds };
    this.#core.journal.append({ type: 'push.kinds', threadId: null, version: 1, payload: { sessionId: id, kinds } }, () => {
      this.#core.journal.setSetting(SUBSCRIPTIONS, all);
    });
    return { ok: true } as const;
  }

  remove(sessionId: string) {
    const all = this.#subscriptions();
    if (all[sessionId]) {
      delete all[sessionId];
      this.#core.journal.append({ type: 'push.unsubscribed', threadId: null, version: 1, payload: { sessionId } }, () => {
        this.#core.journal.setSetting(SUBSCRIPTIONS, all);
      });
    }
    return { ok: true } as const;
  }

  unsubscribe(sessionId: string | null) { return this.remove(this.#requireSession(sessionId)); }

  /**
   * What the app icon's badge says: the threads waiting for the user, the
   * same count the window title shows. The thread being notified about counts
   * even when its row has not caught up with the event yet.
   */
  badge(threadId: string | null = null): number {
    if (this.#core.journal.isClosed()) return 0;
    const rows = this.#core.journal.db
      .query("SELECT id FROM threads WHERE archived = 0 AND (unread != 0 OR status = 'waiting')")
      .all() as { id: string }[];
    const ids = new Set(rows.map((row) => row.id));
    // A question asked without stopping leaves the status alone: its thread waits on the user all the same.
    for (const question of this.#core.threads?.cards.listQuestions() ?? []) {
      if (question.async === true && this.#core.journal.getThread(question.threadId)?.archived === false) ids.add(question.threadId);
    }
    if (threadId !== null && this.#core.journal.getThread(threadId)?.archived === false) ids.add(threadId);
    return ids.size;
  }

  /**
   * The thread is on a screen someone is looking at, on any of their devices:
   * push would only interrupt. It waits instead. Using that screen after the
   * news arrived shows it was seen and drops it; looking away, a page going
   * quiet or a lease nobody renews sends it. Requests for input go immediately:
   * an attended thread does not prove the user noticed its question or permission.
   */
  private notify(threadId: string, text: News, tag: string, needsInput = false) {
    if (this.#closed || !this.reachable()) return;
    if (!needsInput && this.#core.threads.focus.attended(threadId)) {
      this.#held.set(tag, { threadId, text, at: Date.now() });
      this.releaseHeld();
    } else this.#deliverAll(threadId, text, tag);
  }

  /** What a report says of the held pushes: use of their thread since they arrived drops them, then any no longer watched go. */
  #attention({ threadId, activeAt }: AttentionReport) {
    if (threadId !== null && activeAt !== null) {
      for (const [tag, held] of this.#held) if (held.threadId === threadId && activeAt >= held.at) this.#held.delete(tag);
    }
    this.releaseHeld();
  }

  /** Sends the held pushes nobody is watching any more and wakes up when the next lease ends. Public for tests that move the clock. */
  releaseHeld() {
    clearTimeout(this.#heldTimer);
    this.#heldTimer = undefined;
    if (this.#closed) return;
    let next = Infinity;
    for (const [tag, held] of this.#held) {
      const until = this.#core.threads.focus.attendedUntil(held.threadId);
      if (until > 0) { next = Math.min(next, until); continue; }
      this.#held.delete(tag);
      this.#deliverAll(held.threadId, held.text, tag);
    }
    if (next !== Infinity) {
      this.#heldTimer = setTimeout(() => this.releaseHeld(), Math.max(0, next - Date.now()) + 50);
      this.#heldTimer.unref?.();
    }
  }

  #deliverAll(threadId: string | null, text: News, tag: string) {
    const { title: own, ...news } = text;
    const title = own ?? (threadId === null ? null : this.#core.journal.getThread(threadId)?.title) ?? 'Boite';
    const badge = this.badge(threadId);
    const subscriptions = this.#subscriptions();
    for (const [sessionId, subscription] of Object.entries(subscriptions)) {
      // The device turned this kind off: it stays subscribed and hears nothing of it.
      if (!wants(subscription, text.kind)) continue;
      // A device of the group may run a page no machine serves: its push says which machine the thread is on.
      const self = this.#core.group.clients.deviceOf(sessionId) === undefined ? undefined : this.#core.coordination.card().coreId;
      this.#track(this.deliver(sessionId, { title, ...news, threadId, tag, badge, ...(self === undefined ? {} : { core: self }) }).catch(() => {
        // `deliver` already wrote the warning with its cause: this one is detail.
        this.#core.logs.debug('Web Push delivery failed; the conversation remains available in Boite', { source: 'push', event: 'push.delivery-failed' });
      }));
    }
    // A device paired with another member of the group installed that member's page, and its push
    // subscription is there: the news goes through that machine, once per device.
    const forwarded = new Set<string>();
    for (const session of this.#core.journal.listSessions()) {
      if (subscriptions[session.id]) continue;
      const target = deviceElsewhere(this.#core, session.id);
      if (target === null || forwarded.has(target.device)) continue;
      forwarded.add(target.device);
      // Cut to what the home machine reads (`readForwarded`), so a long title or reply still arrives.
      // The home holds the device's subscription and its kinds: it filters, from the kind sent along.
      const payload: Forwarded = { id: randomUUID(), device: target.device, push: { title: title.slice(0, 300), body: text.body.slice(0, 2000),
        ...(text.label === undefined ? {} : { label: text.label }), ...(text.values === undefined ? {} : { values: text.values }),
        kind: text.kind, threadId: threadId === null ? null : threadId.slice(0, 128), tag: tag.slice(0, 200), badge } };
      this.#track(this.forward(target.home, payload).catch(() => {
        this.#core.log('warn', `a notification for a device of ${target.home.name} did not reach that machine; the conversation remains available in Boite`);
      }));
    }
  }

  /** Overridden in tests that count what crosses without a second machine's push service. */
  forward = (home: CoordinationPeer, payload: Forwarded): Promise<unknown> => this.#core.coordination.request(home, 'group.push', payload);

  /**
   * A push another member of the group sends a device of this machine. It goes
   * to that device's subscription here, marked with the machine the thread is
   * on so a tap opens it there. Accepted only for a device the roster lists as
   * this machine's: a member cannot push to anything else through it.
   */
  relayed(from: CoordinationPeer, value: unknown): { delivered: boolean } {
    if (!this.#core.group.peers().some((member) => member.coreId === from.coreId)) throw refused('only a machine of this group sends its devices notifications');
    const { id, device, push } = readForwarded(value);
    const sessionId = ownDevice(this.#core, device);
    if (sessionId === null) throw refused(`group.push device ${device} is not a device of this machine`);
    // A slow first address makes the sender try the others, and two of them can lead here: one push.
    const now = Date.now();
    for (const [key, at] of this.#forwards) if (now - at > FORWARD_IDS_MS) this.#forwards.delete(key);
    const key = `${from.coreId}:${id}`;
    if (this.#forwards.has(key)) return { delivered: true };
    this.#forwards.set(key, now);
    const subscription = this.#subscriptions()[sessionId];
    if (this.#closed || !subscription) return { delivered: false };
    // Received and dropped on purpose: the device turned this kind off.
    if (!wants(subscription, push.kind)) return { delivered: true };
    // The icon counts the threads waiting here as well as there.
    const badge = (push.badge ?? 0) + this.badge();
    // A tag of that machine's never replaces a notification of this one's.
    const tag = `${from.coreId.slice(0, 16)}:${push.tag}`;
    this.#track(this.deliver(sessionId, { ...push, tag, badge, core: from.coreId }).catch(() => {
      this.#core.logs.debug(`Web Push delivery of a notification from ${from.name} failed`, { source: 'push', event: 'push.delivery-failed' });
    }));
    return { delivered: true };
  }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task)).catch(() => undefined);
    return task;
  }

  /** Override the sender in tests to exercise lifecycle without contacting push providers. */
  send = async (subscription: PushSubscription, payload: string, keys: Keys, topic: string): Promise<void> => {
    const { default: webpush } = await import('web-push');
    await webpush.sendNotification(subscription, payload, {
      vapidDetails: { ...keys, subject: this.#core.settings.get().publicUrl ?? 'https://github.com/mtsu-dev/boite' },
      TTL: 300, timeout: 10_000, urgency: 'normal', topic
    });
  };

  private async deliver(sessionId: string, payload: PushPayload): Promise<void> {
    // Subscriptions made before the admin policy turned push off are kept and sent nothing.
    if (this.#core.policy.networkOff('push')) return;
    let keys: Keys;
    try { keys = await this.keys(); }
    catch (error) {
      // The callers log a delivery failure as detail: this cause is said here, once.
      this.#core.logs.warn(`Web Push keys could not be read or created: ${error instanceof Error ? error.message : String(error)}`, { source: 'push', event: 'push.failed', ...(payload.threadId && !payload.core ? { threadId: payload.threadId } : {}), data: { sessionId, stage: 'keys' } });
      throw error;
    }
    if (this.#closed || !this.#core.journal.getSession(sessionId)) return;
    const subscription = this.#subscriptions()[sessionId];
    // The policy may have turned push off while the keys were read.
    if (!subscription || this.#core.policy.networkOff('push')) return;
    try {
      await this.send({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), keys, createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32));
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      const gone = (status === 404 || status === 410) && this.#subscriptions()[sessionId]?.endpoint === subscription.endpoint;
      if (gone) this.remove(sessionId);
      // Only the status and the push service's host: the endpoint path is the device's address.
      let service = 'unknown';
      try { service = new URL(subscription.endpoint).hostname; } catch { /* stays unknown */ }
      this.#core.logs.warn(`Web Push to session ${sessionId} via ${service} failed${status ? ` with HTTP ${status}` : ' before an answer'}${gone ? '; the subscription is gone and was removed' : ''}`, {
        // A relayed push names a thread of another machine: no local thread is blamed for it.
        source: 'push', event: 'push.failed', ...(payload.threadId && !payload.core ? { threadId: payload.threadId } : {}), data: { sessionId, status: status ?? null, service, removed: gone, code: (error as { code?: string }).code ?? null },
      });
      // Provider errors often contain the endpoint and encryption material. Do not forward them.
      throw refused(`Web Push delivery failed${status ? ` (${status})` : ''}`);
    }
  }

  async test(sessionId: string | null) {
    const id = this.#requireSession(sessionId);
    if (!this.#subscriptions()[id]) throw refused('Enable notifications on this device first');
    await this.#track(this.deliver(id, { title: 'Boite', body: 'Notifications are connected', label: 'connected', threadId: null, tag: 'test' }));
    return { ok: true } as const;
  }

  async close() {
    this.#closed = true;
    this.#off();
    this.#offAttention();
    clearTimeout(this.#heldTimer);
    this.#held.clear();
    await Promise.allSettled([...this.#pending]);
  }
}

/**
 * A limit alert as a push: the account in the title, the period and the share
 * used in the body, which the page's words replace by `label` in its language.
 */
export function limitNews(alert: QuotaAlert): News {
  const percent = String(quotaAlertLeft(alert));
  const weekly = alert.period === 'weekly';
  return { title: quotaAlertTitle(alert), body: `${weekly ? 'Weekly' : '5-hour'} limit: ${percent}% left`,
    label: weekly ? 'limitWeekly' : 'limitFiveHour', values: { percent }, kind: 'limits' };
}

export function registerPushMethods(core: Core) {
  core.router.register('push.status', (_params, ctx) => core.push.status(ctx.connection.identity.sessionId));
  core.router.register('push.subscribe', (params, ctx) => core.push.subscribe(ctx.connection.identity.sessionId, params));
  core.router.register('push.unsubscribe', (_params, ctx) => core.push.unsubscribe(ctx.connection.identity.sessionId));
  core.router.register('push.test', (_params, ctx) => core.push.test(ctx.connection.identity.sessionId));
  core.router.register('push.kinds', (params, ctx) => core.push.setKinds(ctx.connection.identity.sessionId, params));
}
