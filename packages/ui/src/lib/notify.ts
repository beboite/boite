/*
 * Notifications: a toast when a thread finishes, fails, or asks something
 * while the user is looking elsewhere. "Elsewhere" is either another thread
 * in this window or another window altogether; the open thread on a focused
 * window says it on the screen already and gets no toast.
 *
 * The decision is pure and tested; the delivery is the shell's notification
 * plugin, or the Web Notifications API on a phone, and nothing at all where
 * neither answers. The switch lives in `localStorage` under
 * `boite.notifications`, on by default, per machine like the theme: it is a
 * client's choice, so the core never hears of it.
 */

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
}

/** The words for each kind, so the store never builds prose. */
export function toastFor(kind: NotifyKind, title: string, detail: string | null): Toast {
  const body =
    kind === 'done'
      ? strings.notify.done
      : kind === 'error'
        ? (detail ?? strings.notify.failed)
        : strings.notify.needsYou;
  return { title, body };
}

type Sender = (toast: Toast) => Promise<void>;

let sender: Sender | null = null;

/** A test hands in its own sender; the app uses the platform one below. */
export function setNotificationSender(next: Sender | null): void {
  sender = next;
}

async function shellSender(toast: Toast): Promise<void> {
  const plugin = await import('@tauri-apps/plugin-notification');
  let granted = await plugin.isPermissionGranted();
  if (!granted) granted = (await plugin.requestPermission()) === 'granted';
  if (!granted) return;
  plugin.sendNotification({ title: toast.title, body: toast.body });
}

async function webSender(toast: Toast): Promise<void> {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  new Notification(toast.title, { body: toast.body });
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
    if (window.__TAURI_INTERNALS__ !== undefined) {
      const plugin = await import('@tauri-apps/plugin-notification');
      if (await plugin.isPermissionGranted()) return true;
      return (await plugin.requestPermission()) === 'granted';
    }
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
