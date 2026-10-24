/*
 * Notifications: a toast when a thread finishes, fails, or asks something
 * while the user is looking elsewhere. "Elsewhere" is either another thread
 * in this window or another window altogether; the open thread on a focused
 * window says routine news on the screen already. Questions and permissions
 * still notify: an open window does not prove the user noticed the request.
 *
 * The decision is pure and tested; the delivery is the shell's `notify`
 * command (a Windows toast whose click comes back as `notification://open`),
 * or the Web Notifications API on a phone, and nothing at all where neither
 * answers. A click on either opens the thread the toast was about. The switch
 * lives in `localStorage` under `boite.notifications`, on by default, per
 * machine like the theme: it is a client's choice. Under it, each kind
 * (approvals, questions, finished, errors) can be turned off; the kinds off
 * live under `boite.notifications.muted`, so a kind added later starts on.
 * A device with Web Push tells its core the same choice (`pushKinds`), since
 * the core is the one that sends those.
 */

import { NOTIFICATION_KINDS, notifiesOnFinish, quotaAlertLeft, quotaAlertTitle, threadBusy, type NotificationKind, type NotificationLabel, type QuotaAlert, type ThreadSummary, type Turn } from '@boite/contracts';
import type { Client } from './client';
import { PUSH_ENABLED_KEY } from './pwa';
import { fill, strings } from './strings';

export const NOTIFICATIONS_STORAGE_KEY = 'boite.notifications';
export const NOTIFICATION_MUTED_STORAGE_KEY = 'boite.notifications.muted';

export type NotifyKind = NotificationKind;

export interface NotifyDecision {
  kind: NotifyKind;
  threadId: string;
  openThreadId: string | null;
  /** `document.hasFocus()` at the time of the event. */
  focused: boolean;
  enabled: boolean;
  /** The kinds this device keeps. */
  kinds: readonly NotifyKind[];
}

/** Requests for input notify wherever the user is; routine news only when looking elsewhere. */
export function shouldNotify(input: NotifyDecision): boolean {
  if (!input.enabled || !input.kinds.includes(input.kind)) return false;
  if (input.kind === 'approvals' || input.kind === 'questions') return true;
  if (!input.focused) return true;
  return input.openThreadId !== input.threadId;
}

/**
 * Whether a finished turn is news at all, the core's push rule
 * (`notifiesOnFinish`) applied to the threads this client holds. A thread it
 * does not hold yet reads as a top-level one with nothing at work under it.
 * `upkeep`: the memory passes its machine named (`upkeepOf`).
 */
export function finishNotifies(threads: readonly ThreadSummary[], turn: Pick<Turn, 'threadId' | 'status' | 'execution' | 'quiet'> & { finishedAt?: number | null }, upkeep: ReadonlySet<string> = new Set()): boolean {
  const thread = threads.find((t) => t.id === turn.threadId);
  if (thread === undefined) return notifiesOnFinish({ parentThreadId: null }, turn, 0);
  // A persistent agent's memory pass is a child the core starts as the turn
  // ends: its answer waits on nothing there. The snapshot names it once read;
  // until then, a child of an agent's thread born after the turn ended is one.
  const upkept = (t: ThreadSummary) => upkeep.has(t.id) || (!!thread.agentSessionId && typeof turn.finishedAt === 'number' && t.createdAt >= turn.finishedAt);
  // A child waiting on its own background work is still at work: its result has not come back.
  const activeChildren = threads.filter((t) => t.parentThreadId === thread.id && threadBusy(t) && !upkept(t)).length;
  return notifiesOnFinish(thread, turn, activeChildren);
}

export function readNotifications(): boolean {
  try {
    return window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeNotifications(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
    else window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, 'off');
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** The kinds this device keeps, every one unless turned off. */
export function readNotificationKinds(): NotifyKind[] {
  try {
    const muted: unknown = JSON.parse(window.localStorage.getItem(NOTIFICATION_MUTED_STORAGE_KEY) ?? '[]');
    return NOTIFICATION_KINDS.filter((kind) => !Array.isArray(muted) || !muted.includes(kind));
  } catch {
    return [...NOTIFICATION_KINDS];
  }
}

export function writeNotificationKinds(kinds: readonly NotifyKind[]): void {
  try {
    const muted = NOTIFICATION_KINDS.filter((kind) => !kinds.includes(kind));
    if (muted.length === 0) window.localStorage.removeItem(NOTIFICATION_MUTED_STORAGE_KEY);
    else window.localStorage.setItem(NOTIFICATION_MUTED_STORAGE_KEY, JSON.stringify(muted));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** What this device's push subscription receives: its kinds, none while the switch is off. */
export function pushKinds(): NotifyKind[] {
  return readNotifications() ? readNotificationKinds() : [];
}

/** Whether two lists hold the same kinds, whatever their order. */
export function sameKinds(a: readonly NotifyKind[], b: readonly NotifyKind[]): boolean {
  return a.length === b.length && a.every((kind) => b.includes(kind));
}

export interface Toast {
  title: string;
  body: string;
  /** The core that owns this event, for per-origin Web Push deduplication. */
  origin?: string;
  /** Unqualified ID for the same-origin service worker's click handler. */
  coreThreadId?: string;
  /**
   * The machine's id in the group (`GroupLinks.coreOf`), for a machine that
   * does not serve this page: the worker's notice then carries the tag and
   * data a push of that machine would, so a tap opens it there.
   */
  core?: string;
  /** The thread a click on the toast opens, or a limit alert's `limitsKey`. */
  threadId: string;
  /** A limit alert: through the worker, it carries the data of the core's push, which opens Limits. */
  limits?: true;
}

/**
 * The body: `detail` is what happened in the agent's own words, the start of
 * its reply or the question it asks; without one, the words for the kind.
 */
export function toastFor(kind: NotifyKind, threadId: string, title: string, detail: string | null): Toast {
  const body = detail
    || (kind === 'finished' ? strings.notify.done : kind === 'errors' ? strings.notify.failed : strings.notify.needsYou);
  return { title, body, threadId };
}

/** The words a push labelled by the core is shown with, in the language this app speaks; `sw.js` fills `{percent}`. */
export function notificationWords(): Record<NotificationLabel, string> {
  return { done: strings.notify.done, failed: strings.notify.failed, needsYou: strings.notify.needsYou, connected: strings.notify.connected,
    limitFiveHour: strings.notify.limitFiveHour, limitWeekly: strings.notify.limitWeekly };
}

/** What a toast about limits carries in place of a thread: a click opens Settings, Limits, on that machine. */
const LIMITS_KEY = 'boite-limits:';

export function limitsKey(machineId: string | null): string {
  return `${LIMITS_KEY}${machineId ?? ''}`;
}

/** The machine a limits toast is about, `''` for the one serving the page; null for a thread's key. */
export function limitsMachine(key: string): string | null {
  return key.startsWith(LIMITS_KEY) ? key.slice(LIMITS_KEY.length) : null;
}

/**
 * The words of the core's push (`limitNews`): the account in the title, with
 * the model or group a scoped window names, and the period and share in the body.
 */
export function limitToast(alert: QuotaAlert, key: string): Toast {
  const percent = String(quotaAlertLeft(alert));
  const body = fill(alert.period === 'weekly' ? strings.notify.limitWeekly : strings.notify.limitFiveHour, { percent });
  return { title: quotaAlertTitle(alert), body, threadId: key, limits: true };
}

/** Where `sw.js` reads them. Not a `boite-ui-` cache: those go with each new build. */
export const NOTIFICATION_WORDS_CACHE = 'boite-notify';
export const NOTIFICATION_WORDS_PATH = '/notification-words';

/**
 * Leaves the words where the service worker finds them. The core speaks no
 * language: the page knows the user's, and writes it again when it changes.
 */
export async function storeNotificationWords(words: Record<NotificationLabel, string>): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(NOTIFICATION_WORDS_CACHE);
    await cache.put(NOTIFICATION_WORDS_PATH, new Response(JSON.stringify(words), { headers: { 'content-type': 'application/json' } }));
  } catch { /* A push then shows the core's English body. */ }
}

/** Where `sw.js` reads the page's language when it installs, to store that catalogue with the shell. */
export const WORKER_LOCALE_PATH = '/locale';

/**
 * Leaves the language this page speaks beside the words. The next worker
 * precaches that catalogue, so an offline open of a new build still has one;
 * before the first write it goes by the device's languages.
 */
export async function storeWorkerLocale(locale: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(NOTIFICATION_WORDS_CACHE);
    await cache.put(WORKER_LOCALE_PATH, new Response(locale, { headers: { 'content-type': 'text/plain' } }));
  } catch { /* The worker then goes by the device's languages. */ }
}

/**
 * Whether a push brings the same notice to this device: its own core pushes
 * to it, or `viaGroup`, the notice is about a member of the group, which
 * forwards it to this device's push home. The service worker must show every
 * push on iOS, so the page is the one that stays quiet: showing both doubled
 * each notice on an iPhone, tag or not.
 */
export async function pushCovers(origin: string | undefined, viaGroup = false): Promise<boolean> {
  try {
    if (!navigator.serviceWorker || (!viaGroup && (origin === undefined || origin !== location.origin))) return false;
    if (localStorage.getItem(PUSH_ENABLED_KEY) !== 'on' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(await registration?.pushManager?.getSubscription());
  } catch {
    return false;
  }
}

/**
 * The machine holding this device's push subscription, by its address in this
 * page (`''` for the core serving it): the one the Phone app settings enabled
 * push on. Its kinds change there, whichever machine is shown.
 */
export const PUSH_HOME_STORAGE_KEY = 'boite.web-push.home';

/** The push home's address, or null before one was recorded (a subscription older than this record). */
export function readPushHome(): string | null {
  try {
    return window.localStorage.getItem(PUSH_HOME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writePushHome(endpointUrl: string | null | false): void {
  try {
    if (endpointUrl === false) window.localStorage.removeItem(PUSH_HOME_STORAGE_KEY);
    else window.localStorage.setItem(PUSH_HOME_STORAGE_KEY, endpointUrl ?? '');
  } catch {
    /* the next status read records it again */
  }
}

let pushHomeOf: ((home: string) => Pick<Client, 'call'> | null) | null = null;

/** The workspace finds the push home's connection among its machines; it imports the store, so it hands this in. */
export function setPushHomeClient(resolve: ((home: string) => Pick<Client, 'call'> | null) | null): void {
  pushHomeOf = resolve;
}

export function pushHomeClient(home: string): Pick<Client, 'call'> | null {
  try {
    return pushHomeOf?.(home) ?? null;
  } catch {
    return null;
  }
}

let coreOfStore: ((store: object) => string | undefined) | null = null;

/** The workspace says which group member a machine's store is (`GroupLinks.coreOf`); it imports the store, so it hands this in. */
export function setNotificationCore(resolve: ((store: object) => string | undefined) | null): void {
  coreOfStore = resolve;
}

/** The group id of the machine whose store raised a toast, when the workspace knows it. */
export function notificationCore(store: object): string | undefined {
  try {
    return coreOfStore?.(store);
  } catch {
    return undefined;
  }
}

type Sender = (toast: Toast) => Promise<void>;
type Opener = (threadId: string) => void;

let sender: Sender | null = null;
let opener: Opener | null = null;

/** A test hands in its own sender; the app uses the platform one below. */
export function setNotificationSender(next: Sender | null): void {
  sender = next;
}

/**
 * What a click on a toast does: the store hands in `open`. In the shell the
 * click arrives as the `notification://open` event, which this listens for;
 * on the web it is the notification's own `onclick`. Returns the way to stop.
 */
export function onNotificationOpen(next: Opener | null): () => void {
  opener = next;
  if (next === null || window.__TAURI_INTERNALS__ === undefined) return () => {};
  let stop: (() => void) | undefined;
  let disposed = false;
  void import('@tauri-apps/api/event').then(async ({ listen }) => {
    const unlisten = await listen<string>('notification://open', (event) => opener?.(event.payload));
    if (disposed) unlisten();
    else stop = unlisten;
  });
  return () => {
    disposed = true;
    stop?.();
    if (opener === next) opener = null;
  };
}

async function shellSender(toast: Toast): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('notify', { title: toast.title, body: toast.body, threadId: toast.threadId });
}

async function webSender(toast: Toast): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  // Through the worker whenever there is one: Android refuses `new Notification`
  // on a page, and the phone app's page serves no machine. The tag and data are
  // the ones a push about that thread uses (`sw.js`), so a later push replaces
  // this notice and a tap opens the thread where it is.
  if (toast.limits && navigator.serviceWorker) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const core = toast.origin === location.origin ? undefined : toast.core;
        await registration.showNotification(toast.title, {
          body: toast.body, tag: `limit-${toast.threadId}-${toast.title}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
          data: core ? { limits: true, core } : { limits: true }
        });
        return;
      }
    } catch { /* A missing worker must not disable the browser fallback. */ }
  }
  if (toast.coreThreadId && navigator.serviceWorker) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const id = toast.coreThreadId;
        const own = toast.origin === location.origin;
        const core = own ? undefined : toast.core;
        await registration.showNotification(toast.title, {
          body: toast.body,
          tag: core ? `thread-${core}-${id}` : own ? `thread-${id}` : `thread-${toast.threadId}`,
          icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
          // A machine with no group id: the window opens it by this window's own key for the thread.
          data: core ? { threadId: id, core } : own ? { threadId: id } : { threadId: id, key: toast.threadId }
        });
        return;
      }
    } catch { /* A missing worker must not disable the browser fallback. */ }
  }
  const notification = new Notification(toast.title, { body: toast.body, tag: toast.threadId });
  notification.onclick = () => {
    window.focus();
    notification.close();
    opener?.(toast.threadId);
  };
}

/** Sends, and never throws: a toast that cannot go out is not an error the chat should show. */
export async function sendNotification(toast: Toast): Promise<void> {
  try {
    const send = sender ?? (window.__TAURI_INTERNALS__ !== undefined ? shellSender : webSender);
    await send(toast);
  } catch {
    /* no notification surface here */
  }
}

/**
 * Asks the platform for the permission ahead of the first toast, from the
 * settings switch: the prompt then arrives on a click the user made, not
 * in the middle of a turn. True when notifications may go out.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    // A Windows toast asks nobody: the system's own switch decides, silently.
    if (window.__TAURI_INTERNALS__ !== undefined) return true;
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
