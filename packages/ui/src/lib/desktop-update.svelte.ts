/*
 * The desktop app of this computer, seen from another machine of the group.
 * Only this window drives the shell's installer, so it reports its updater to
 * the core its own shell started (`core.desktopUpdateReport`), and installs
 * when that core relays a request from another machine (`ui.appUpdate`). The
 * owner's click over there is the consent: nobody may be here to confirm.
 */
import type { DesktopUpdateStatus } from '@boite/contracts';
import { appUpdater, type UpdateSnapshot } from './app-update.svelte';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';

/** How long download ticks of one phase wait before the next report: the core relays each to every owner window. */
const TICK_MS = 1000;

export function desktopStatusOf(snapshot: UpdateSnapshot): DesktopUpdateStatus {
  return { phase: snapshot.phase, currentVersion: snapshot.currentVersion, version: snapshot.version, channel: snapshot.channel,
    received: snapshot.received, total: snapshot.total, error: snapshot.error };
}

/** What a report says apart from its progress: a change here goes at once. */
const keyOf = (status: DesktopUpdateStatus): string => JSON.stringify([status.phase, status.version, status.currentVersion, status.channel, status.error]);

/** The core this window's own shell started, when it takes the report. */
function localStore(stores: readonly Store[]): Store | null {
  return stores.find((store) => store.localCore && store.connection === 'ready' && store.owner && store.client !== null
    && store.core?.features?.desktopUpdates === true) ?? null;
}

/**
 * Reports this window's updater to its own core on every change, and again
 * after each reconnect. Download ticks of one phase go at most once a second.
 * Returns the way to stop.
 */
export function reportDesktopUpdates(stores: () => readonly Store[]): () => void {
  let sentKey: string | null = null;
  let sentTo: unknown = null;
  let sentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = $effect.root(() => {
    $effect(() => {
      const snapshot = appUpdater.snapshot;
      const store = localStore(stores());
      clearTimeout(timer);
      if (!snapshot.supported || store === null) return;
      const client = store.client!;
      const status = desktopStatusOf(snapshot);
      const key = keyOf(status);
      const send = () => {
        sentKey = key; sentTo = client; sentAt = Date.now();
        void client.call('core.desktopUpdateReport', { status }).catch(() => { sentKey = null; });
      };
      if (key !== sentKey || client !== sentTo) send();
      else timer = setTimeout(send, Math.max(0, sentAt + TICK_MS - Date.now()));
    });
  });
  return () => { clearTimeout(timer); stop(); };
}

/**
 * Another machine asked this computer to install `version`. Only the window of
 * the core this shell started acts, and only for the release it offers itself.
 */
export function appUpdateRequested(from: Store, version: string): void {
  if (window.__TAURI_INTERNALS__ === undefined || !from.localCore) return;
  if (!appUpdater.snapshot.supported || appUpdater.snapshot.version !== version) return;
  from.reportError(fill(strings.desktopUpdate.requested, { version }), 'minor');
  void appUpdater.installRequested(version).catch((error: unknown) => { from.reportError(error); });
}
