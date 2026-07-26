import type { Component } from "svelte";

/**
 * Defers a component's chunk until something actually needs it.
 *
 * xterm and CodeMirror are megabytes that a session may never touch before
 * the window is up, and a static import puts them in the entry graph where
 * they are parsed before first paint. Holding them behind `import()` moves
 * that cost off the boot path; `ensure()` is idempotent so a prefetch and a
 * real mount racing each other still load the chunk once.
 */
export function lazyComponent<T extends Component<never>>(
  load: () => Promise<{ default: T }>,
) {
  let current = $state.raw<T | null>(null);
  let pending: Promise<void> | null = null;

  function ensure(): Promise<void> {
    // Cleared on failure so a transient import error can be retried instead
    // of leaving the slot permanently empty.
    pending ??= load().then(
      (mod) => {
        current = mod.default;
      },
      (err: unknown) => {
        pending = null;
        console.error("lazy component failed to load:", err);
      },
    );
    return pending;
  }

  return {
    get current() {
      return current;
    },
    ensure,
  };
}

/**
 * Warms a lazy component once the browser is idle. Callers use this for
 * chunks the user is very likely to need soon but which must not compete
 * with first paint.
 */
export function prefetchWhenIdle(lazy: { ensure: () => Promise<void> }): void {
  if (typeof window === "undefined") return;
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (idle) idle(() => void lazy.ensure(), { timeout: 2000 });
  else setTimeout(() => void lazy.ensure(), 0);
}
