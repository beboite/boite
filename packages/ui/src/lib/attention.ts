import { ATTENTION_IDLE_MS } from '@boite/contracts';

/**
 * Whether the user is looking at this page now: shown, focused and used in the
 * last few minutes. A phone app in the background or locked, a desktop window
 * behind another one and a PC left alone all say no. The core sends no push
 * about the conversation an attentive page shows (`threads.focus`).
 * Calls `report` with the first answer and each change; returns the way to stop.
 */
export function watchAttention(report: (attentive: boolean) => void): () => void {
  let usedAt = Date.now(), timer: ReturnType<typeof setTimeout> | undefined, current: boolean | null = null;
  const set = (attentive: boolean) => {
    if (attentive !== current) { current = attentive; report(attentive); }
  };
  const check = () => {
    clearTimeout(timer);
    const idle = Date.now() - usedAt;
    const attentive = document.visibilityState === 'visible' && document.hasFocus() && idle < ATTENTION_IDLE_MS;
    if (attentive) timer = setTimeout(check, ATTENTION_IDLE_MS - idle);
    set(attentive);
  };
  // Cheap while attentive: the idle timer reads the time of the latest use.
  const used = () => { usedAt = Date.now(); if (!current) check(); };
  // Leaving the page may give no visibility change before iOS suspends it.
  const leaving = () => { clearTimeout(timer); set(false); };
  const windowEvents = ['focus', 'blur', 'pageshow'] as const;
  const inputs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  document.addEventListener('visibilitychange', check);
  for (const name of windowEvents) window.addEventListener(name, check);
  for (const name of inputs) window.addEventListener(name, used, { capture: true, passive: true });
  window.addEventListener('pagehide', leaving);
  check();
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', check);
    for (const name of windowEvents) window.removeEventListener(name, check);
    for (const name of inputs) window.removeEventListener(name, used, { capture: true });
    window.removeEventListener('pagehide', leaving);
  };
}
