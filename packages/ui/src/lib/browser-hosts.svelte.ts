import { untrack } from 'svelte';
import type { Store } from './store.svelte';
import { hostBrowser, hostsBrowser } from './browser-host';
import { rightPanel } from './right-panel.svelte';
import { experimentOn } from './experiments.svelte';

/** Keep visited conversations hosted until archive, disconnect or consent withdrawal. */
export function watchBrowserHosts(stores: () => Store[]): () => void {
  const hosted = new Map<Store, { client: Store['client']; machine: string; threads: Map<string, () => void> }>();
  const release = (store: Store) => {
    const entry = hosted.get(store);
    entry?.threads.forEach(stop => stop());
    hosted.delete(store);
  };
  const stop = $effect.root(() => {
    $effect(() => {
      const enabled = experimentOn('agent-browser-control') || experimentOn('remote-browser');
      const ready = stores().filter(store => enabled && store.connection === 'ready' && store.client && hostsBrowser(store));
      const snapshots = ready.map(store => {
        const alive = new Set(store.threads.filter(thread => !thread.archived).map(thread => thread.id));
        const selected = store.openThread;
        if (selected && !selected.archived) alive.add(selected.id);
        const wanted = new Set([...alive].filter(id => id === selected?.id || rightPanel.for(store.threadKey(id)).surfaces.some(surface => surface.kind === 'browser')));
        return { store, alive, wanted, client: store.client, machine: store.machineId };
      });
      untrack(() => {
        for (const store of hosted.keys()) if (!ready.includes(store)) release(store);
        for (const { store, alive, wanted, client, machine } of snapshots) {
          let entry = hosted.get(store);
          if (entry && (entry.client !== client || entry.machine !== machine)) { release(store); entry = undefined; }
          if (!entry) { entry = { client, machine, threads: new Map() }; hosted.set(store, entry); }
          for (const [id, stop] of entry.threads) if (!alive.has(id)) { stop(); entry.threads.delete(id); }
          for (const id of wanted) if (!entry.threads.has(id)) entry.threads.set(id, hostBrowser(store, id));
        }
      });
    });
  });
  return () => { stop(); for (const store of hosted.keys()) release(store); };
}
