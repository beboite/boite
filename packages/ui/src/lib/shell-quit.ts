import { threadActive } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';
import { count as formatCount } from './format';
import { QuitHold } from './quit-hold';

export const QUIT_CHECK_TIMEOUT_MS = 1500;

/** A cancelled or failed close request permits another keyboard attempt. */
export function confirmedQuitHold(request: () => Promise<void>, options: {
  onHolding: (holding: boolean) => void;
  hasQuit: () => boolean;
  failed: (error: unknown) => void;
}): QuitHold {
  const hold = new QuitHold({
    onHolding: options.onHolding,
    onQuit: () => { void request().catch(options.failed).finally(() => { if (!options.hasQuit()) hold.reset(); }); },
  });
  return hold;
}

async function quitState(store: Store) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!store.client || store.connection !== 'ready') throw new Error('offline');
    const unavailable = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('quit state timed out')), QUIT_CHECK_TIMEOUT_MS);
    });
    const threads = await Promise.race([store.client.call('threads.list', { includeArchived: true }), unavailable]);
    return { threads, unknown: false };
  } catch {
    return { threads: store.threads, unknown: true };
  } finally { clearTimeout(timer); }
}

export function desktopQuit(stores: () => Store[], closed: () => void): () => Promise<void> {
  return shellQuit(stores, async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('quit_shell');
    closed();
  });
}

/** Listen before enabling the shell guard, so early startup can still close. */
export function installQuitGuard(request: () => Promise<void>, failed: (error: unknown) => void): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  void import('@tauri-apps/api/event').then(async ({ listen }) => {
    if (disposed) return;
    stop = await listen('boite:quit-requested', () => { void request().catch(failed); });
    if (disposed) { stop(); return; }
    const { invoke } = await import('@tauri-apps/api/core');
    if (!disposed) await invoke('quit_guard');
  }).catch(failed);
  return () => { disposed = true; stop?.(); };
}

/** All exit gestures share one pending check and confirmation. */
export function shellQuit(stores: () => Store[], quit: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  async function request() {
    const owners = [...new Set(stores())];
    const snapshots = await Promise.all(owners.map(quitState));
    const count = snapshots.reduce((n, s) => n + s.threads.filter(t => threadActive(t.status)).length, 0);
    const unknown = snapshots.some(s => s.unknown);
    if (count || unknown) {
      const words = strings.titlebar;
      const body = [count ? count === 1 ? words.quitWorkingOne : fill(words.quitWorkingMany, { count: formatCount(count) }) : '', unknown ? words.quitUnknownBody : '', words.quitResidentBody].filter(Boolean).join('\n\n');
      if (!await confirm.ask({ title: words.quitTitle, body, confirmLabel: words.quitConfirm, cancelLabel: words.quitCancel, danger: true })) return;
    }
    await quit();
  }
  return () => pending ??= request().finally(() => { pending = null; });
}
