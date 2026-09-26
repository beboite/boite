/**
 * A browser Back dismisses the top mobile panel before leaving the conversation.
 *
 * Each open overlay owns one history entry, marked with its id and its depth in
 * the stack of overlays. Back closes every overlay deeper than the entry it
 * lands on, so it works the same in a browser tab, the installed Android app
 * (the system Back gesture) and the Tauri shell. Closing an overlay any other
 * way pops its entry when that entry is on top; an entry left under a newer
 * one is skipped the next time Back reaches it, as is one a reload left behind.
 *
 * `history.back()` lands in a later task, and an entry pushed before it lands
 * would be the one it pops. A push therefore waits for the pops in flight.
 */
const live = new Set<string>();
let pops = 0;
let queued: (() => void)[] = [];
let listening = false;

function depthOf(state: unknown): number {
  const depth = (state as { boiteDepth?: unknown } | null)?.boiteDepth;
  return typeof depth === 'number' ? depth : 0;
}

function pop(): void {
  pops += 1;
  history.back();
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('popstate', () => {
    if (pops > 0) pops -= 1;
    const id = (history.state as { boiteOverlay?: unknown } | null)?.boiteOverlay;
    if (typeof id === 'string' && !live.has(id)) {
      pop();
      return;
    }
    if (pops === 0) for (const run of queued.splice(0)) run();
  });
}

export function mobileOverlay(close: () => void): () => void {
  if (!window.matchMedia('(max-width: 720px)').matches) return () => {};
  listen();
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  let depth = 0;
  let pushed = false;
  let cancelled = false;
  const back = () => {
    if (depthOf(history.state) < depth) close();
  };
  const push = () => {
    if (cancelled) return;
    depth = depthOf(history.state) + 1;
    history.pushState({ ...history.state, boiteOverlay: id, boiteDepth: depth }, '');
    live.add(id);
    pushed = true;
    window.addEventListener('popstate', back);
  };
  if (pops > 0) queued.push(push);
  else push();
  return () => {
    cancelled = true;
    live.delete(id);
    if (!pushed) return;
    window.removeEventListener('popstate', back);
    if ((history.state as { boiteOverlay?: unknown } | null)?.boiteOverlay === id) pop();
  };
}
