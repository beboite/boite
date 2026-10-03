import { ATTENTION_IDLE_MS } from '@boite/contracts';

/**
 * What the desktop shell knows and a page cannot: how long the whole system
 * has gone without a key or a mouse move (null where the OS does not say), and
 * whether the Boite window is the one in front. A webview's own focus and
 * visibility can stay true behind other windows or on a locked screen.
 */
export interface Presence { idleMs: number | null; foreground: boolean }
export type PresenceSource = () => Promise<Presence>;

/** How often the shell is asked while the page is shown. */
export const PRESENCE_POLL_MS = 5_000;

export function shellPresence(): PresenceSource | null {
  if (typeof window === 'undefined' || window.__TAURI_INTERNALS__ === undefined) return null;
  return async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Presence>('user_presence');
  };
}

/**
 * Whether the user is looking at this page now: shown, in front and used in
 * the last `ATTENTION_IDLE_MS`. A phone app in the background or locked, a
 * desktop window behind another one and a PC nobody touches all say no; in the
 * desktop shell, use means any key or mouse move on the system. The core holds
 * back push about the conversation an attentive page shows (`threads.focus`).
 * Calls `report` with the first answer and each change, and `active` with the
 * time of each use while attentive; returns the way to stop.
 */
export function watchAttention(
  report: (attentive: boolean) => void,
  active: (at: number) => void = () => {},
  presence: PresenceSource | null = shellPresence(),
): () => void {
  let usedAt = Date.now(), timer: ReturnType<typeof setTimeout> | undefined, current: boolean | null = null;
  let native: Presence | null = null, source = presence, stopped = false;
  const set = (attentive: boolean) => {
    if (attentive !== current) { current = attentive; report(attentive); }
  };
  const check = () => {
    clearTimeout(timer);
    const idle = Date.now() - usedAt;
    const front = native ? native.foreground : document.hasFocus();
    const attentive = document.visibilityState === 'visible' && front && idle < ATTENTION_IDLE_MS;
    if (attentive) timer = setTimeout(check, ATTENTION_IDLE_MS - idle);
    set(attentive);
  };
  // Cheap while attentive: the idle timer reads the time of the latest use.
  const use = (at: number) => {
    usedAt = Math.max(usedAt, at);
    if (!current) check();
    if (current) active(usedAt);
  };
  const used = () => use(Date.now());
  // Leaving the page may give no visibility change before iOS suspends it.
  const leaving = () => { clearTimeout(timer); set(false); };
  const ask = () => {
    if (!source || document.visibilityState !== 'visible') return;
    source().then((value) => {
      if (stopped) return;
      native = value;
      // The system's last input covers the page's own, and can be older than the last poll thought.
      if (value.idleMs !== null) usedAt = Date.now() - value.idleMs;
      check();
      if (current) active(usedAt);
    }, () => {
      // An older shell without the command: the page's own signals stand.
      source = null;
      clearInterval(poll);
    });
  };
  const poll = source ? setInterval(ask, PRESENCE_POLL_MS) : undefined;
  const windowEvents = ['focus', 'blur', 'pageshow'] as const;
  const inputs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  const shown = () => { check(); ask(); };
  document.addEventListener('visibilitychange', shown);
  document.addEventListener('resume', check);
  document.addEventListener('freeze', leaving);
  for (const name of windowEvents) window.addEventListener(name, shown);
  for (const name of inputs) window.addEventListener(name, used, { capture: true, passive: true });
  window.addEventListener('pagehide', leaving);
  check();
  ask();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(poll);
    document.removeEventListener('visibilitychange', shown);
    document.removeEventListener('resume', check);
    document.removeEventListener('freeze', leaving);
    for (const name of windowEvents) window.removeEventListener(name, shown);
    for (const name of inputs) window.removeEventListener(name, used, { capture: true });
    window.removeEventListener('pagehide', leaving);
  };
}
