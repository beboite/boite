import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';

/**
 * Brings the Device tab forward when a device opens in the conversation, by
 * the agent or by someone else watching it: T3 Code's panel shows the
 * simulator the moment the agent starts it. A device already open when the
 * conversation opens does not pull the panel out; its tab stays as it was.
 */
export function watchDevices(store: Store, threadId: string): () => void {
  const client = store.client;
  if (!client) return () => {};
  const panel = rightPanel.for(store.threadKey(threadId));
  let known: Set<string> | null = null;
  const off = client.on('devices.changed', (event) => {
    if (event.threadId !== threadId) return;
    const before = known ?? new Set<string>();
    known = new Set(event.sessions.map((session) => session.deviceId));
    if (!event.sessions.some((session) => !before.has(session.deviceId))) return;
    const tab = panel.surfaces.find((surface) => surface.kind === 'device');
    if (tab) panel.activate(tab.id);
    else panel.open('device');
  });
  void client.call('devices.sessions', { threadId }).then(
    ({ sessions }) => { known ??= new Set(sessions.map((session) => session.deviceId)); },
    () => {}
  );
  return off;
}
