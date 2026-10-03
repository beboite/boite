/*
 * Notifications: a toast when a thread finishes, fails, or asks something
 * while the user is looking elsewhere. "Elsewhere" is either another thread
 * in this window or another window altogether; the open thread on a focused
 * window says it on the screen already and gets no toast.
 *
 * The decision is pure and tested; the delivery is the shell's `notify`
 * command (a Windows toast whose click comes back as `notification://open`),
 * or the Web Notifications API on a phone, and nothing at all where neither
 * answers. A click on either opens the thread the toast was about. The switch
 * lives in `localStorage` under `boite.notifications`, on by default, per
 * machine like the theme: it is a client's choice, so the core never hears
 * of it.
 */

import { notifiesOnFinish, threadActive, type NotificationLabel, type ThreadSummary, type Turn } from '@boite/contracts';
import { PUSH_ENABLED_KEY } from './pwa';
import { strings } from './strings';

export const NOTIFICATIONS_STORAGE_KEY = 'boite.notifications';

export type NotifyKind = 'done' | 'error' | 'needs-you';

export interface NotifyDecision {
  kind: NotifyKind;
  threadId: string;
  openThreadId: string | null;
  /** `document.hasFocus()` at the time of the event. */
  focused: boolean;
  enabled: boolean;
}

/** A toast goes out when the switch is on and the user could not have seen it happen. */
export function shouldNotify(input: NotifyDecision): boolean {
  if (!input.enabled) return false;
  if (!input.focused) return true;
  return input.openThreadId !== input.threadId;
}

/**
 * Whether a finished turn is news at all, the core's push rule
 * (`notifiesOnFinish`) applied to the threads this client holds. A thread it
 * does not hold yet keeps the old answer: a done or a failure is news.
 */
export function finishNotifies(threads: readonly ThreadSummary[], turn: Pick<Turn, 'threadId' | 'status' | 'execution'>): boolean {
  const thread = threads.find((t) => t.id === turn.threadId);
  if (thread === undefined) return turn.status === 'done' || turn.status === 'error';
  const activeChildren = threads.filter((t) => t.parentThreadId === thread.id && threadActive(t.status)).length;
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

export interface Toast {
  title: string;
  body: string;
  /** The core that owns this event, for per-origin Web Push deduplication. */
  origin?: string;
  /** Unqualified ID for the same-origin service worker's click handler. */
  coreThreadId?: string;
  /** The thread a click on the toast opens. */
  threadId: string;
}

/**
 * The body: `detail` is what happened in the agent's own words, the start of
 * its reply or the question it asks; without one, the words for the kind.
 */
export function toastFor(kind: NotifyKind, threadId: string, title: string, detail: string | null): Toast {
  const body = detail
    || (kind === 'done' ? strings.notify.done : kind === 'error' ? strings.notify.failed : strings.notify.needsYou);
  return { title, body, threadId };
}

/** The words a push labelled by the core is shown with, in the language this app speaks. */
export function notificationWords(): Record<NotificationLabel, string> {
  return { done: strings.notify.done, failed: strings.notify.failed, needsYou: strings.notify.needsYou, connected: strings.notify.connected };
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

/**
 * Whether this page's own core pushes the same notice to this device. The
 * service worker must show every push on iOS, so the page is the one that
 * stays quiet: showing both doubled each notice on an iPhone, tag or not.
 */
export async function pushCovers(origin: string | undefined): Promise<boolean> {
  try {
    if (origin === undefined || origin !== location.origin || !navigator.serviceWorker) return false;
    if (localStorage.getItem(PUSH_ENABLED_KEY) !== 'on' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(await registration?.pushManager?.getSubscription());
  } catch {
    return false;
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
  // A device without push: the same worker and tag a push would use.
  if (toast.origin === location.origin && toast.coreThreadId && navigator.serviceWorker) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(toast.title, {
          body: toast.body, tag: `thread-${toast.coreThreadId}`,
          icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
          data: { threadId: toast.coreThreadId }
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
