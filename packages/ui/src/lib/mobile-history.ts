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
 *
 * Safari's swipe from the edge, and Chrome's where it draws one, slide a
 * picture of the screen underneath before the Back lands: what that Back
 * closes leaves without a slide of its own (`browserAnimatedBack`).
 */
import { secureId } from './secure-id';

const live = new Set<string>();
let pops = 0;
let queued: (() => void)[] = [];
let listening = false;
/** On while the app answers a Back the browser animated, until the next task. */
let animatedBack = false;
/** A finger that came down at an edge of the screen, where a swipe back starts: still down, or when it lifted. */
let edgeHeld = false;
let edgeLifted = -Infinity;
const edge = 24;

function touched(event: TouchEvent): void {
  if (event.type === 'touchstart') {
    const x = event.touches[0]?.clientX ?? -1;
    edgeHeld = event.touches.length === 1 && (x <= edge || x >= window.innerWidth - edge);
    edgeLifted = -Infinity;
  } else if (edgeHeld && event.touches.length === 0) {
    edgeHeld = false;
    edgeLifted = performance.now();
  }
}

/**
 * `hasUAVisualTransition` says whether the browser animated this Back (Safari
 * 18, Chrome 118). Older ones do not say: a swipe from the edge, still under
 * the finger or lifted within the second, counts as the browser's.
 */
function drawnByBrowser(event: PopStateEvent): boolean {
  if ('hasUAVisualTransition' in event) return (event as PopStateEvent & { hasUAVisualTransition: boolean }).hasUAVisualTransition;
  return edgeHeld || performance.now() - edgeLifted < 1000;
}

/** Whether the Back being answered was already animated by the browser: a screen or a panel it closes leaves at once. */
export function browserAnimatedBack(): boolean {
  return animatedBack;
}

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
  window.addEventListener('popstate', (event) => {
    // The app's own `history.back()` is never animated.
    animatedBack = pops === 0 && drawnByBrowser(event);
    if (animatedBack) setTimeout(() => { animatedBack = false; });
    if (pops > 0) pops -= 1;
    const id = (history.state as { boiteOverlay?: unknown } | null)?.boiteOverlay;
    if (typeof id === 'string' && !live.has(id)) {
      pop();
      return;
    }
    if (pops === 0) for (const run of queued.splice(0)) run();
  });
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) window.addEventListener(type, touched, { capture: true, passive: true });
}

export function mobileOverlay(close: () => void): () => void {
  if (!window.matchMedia('(max-width: 720px)').matches) return () => {};
  listen();
  const id = secureId();
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
