import { createHash, ECDH } from 'node:crypto';
import type { RpcEvents, RpcParams } from '@boite/contracts';
import type { PushSubscription } from 'web-push';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';

type Subscription = RpcParams<'push.subscribe'>;
type Payload = { title: string; body: string; threadId: string | null; tag: string };
type Keys = { publicKey: string; privateKey: string };
const SUBSCRIPTIONS = 'web-push.subscriptions';
const KEYS = 'web-push.keys';

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

  constructor(private readonly core: Core) {
    this.off = core.bus.onAny((name, payload) => {
      if (name === 'sessions.updated' && (payload as RpcEvents['sessions.updated']).state === 'revoked') {
        this.remove((payload as RpcEvents['sessions.updated']).sessionId);
      } else if (name === 'permission.requested' || name === 'question.asked') {
        const request = payload as RpcEvents['permission.requested'] | RpcEvents['question.asked'];
        this.notify(request.threadId, 'Needs your answer', `request-${request.id}`);
      } else if (name === 'turn.finished') {
        const turn = payload as RpcEvents['turn.finished'];
        if (turn.status === 'done' || turn.status === 'error') {
          this.notify(turn.threadId, turn.status === 'done' ? 'Done' : 'The agent encountered an error', `turn-${turn.id}`);
        }
      }
    });
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

  private notify(threadId: string, body: string, tag: string) {
    if (this.closed) return;
    const title = this.core.journal.getThread(threadId)?.title ?? 'Boite';
    for (const sessionId of Object.keys(this.subscriptions())) {
      this.track(this.deliver(sessionId, { title, body, threadId, tag }).catch(() => {
        this.core.log('warn', 'Web Push delivery failed; the conversation remains available in Boite');
      }));
    }
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

  private async deliver(sessionId: string, payload: Payload): Promise<void> {
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
    await this.track(this.deliver(id, { title: 'Boite', body: 'Notifications are connected', threadId: null, tag: 'test' }));
    return { ok: true } as const;
  }

  async close() {
    this.closed = true;
    this.off();
    await Promise.allSettled([...this.pending]);
  }
}

export function registerPushMethods(core: Core) {
  core.router.register('push.status', (_params, ctx) => core.push.status(ctx.connection.identity.sessionId));
  core.router.register('push.subscribe', (params, ctx) => core.push.subscribe(ctx.connection.identity.sessionId, params));
  core.router.register('push.unsubscribe', (_params, ctx) => core.push.unsubscribe(ctx.connection.identity.sessionId));
  core.router.register('push.test', (_params, ctx) => core.push.test(ctx.connection.identity.sessionId));
}
