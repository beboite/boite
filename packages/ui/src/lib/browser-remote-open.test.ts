import { afterEach, expect, test, vi } from 'vitest';
import type { RpcEvents } from '@boite/contracts';
import { REMOTE_READY_MS, shareBrowserOnRequest } from './browser-remote-open';
import { writeExperiments } from './experiments';
import { rightPanel } from './right-panel.svelte';
import type { Store } from './store.svelte';

vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn(), on: vi.fn(), destroy: vi.fn() } }));
afterEach(() => { writeExperiments([]); rightPanel.forget('wanted'); vi.useRealTimers(); vi.restoreAllMocks(); });

test('a sharing desktop renews its readiness and shows the asked conversation on a browser tab', async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
  let asked: (event: RpcEvents['browser.remoteOpenRequested']) => void = () => {};
  const client = { call: vi.fn(async () => ({})), on: vi.fn((_name: string, callback: typeof asked) => { asked = callback; return () => {}; }) };
  const fake = {
    client, owner: true, openThread: { id: 'other' }, threadKey: (id: string) => id,
    open: vi.fn(async (id: string) => { fake.openThread = { id }; }),
  };
  const store = fake as unknown as Store;
  shareBrowserOnRequest(store)();
  expect(client.call).not.toHaveBeenCalled();
  writeExperiments(['remote-browser']);
  const stop = shareBrowserOnRequest(store);
  expect(client.call).toHaveBeenLastCalledWith('browser.remoteReady', { enabled: true });
  vi.advanceTimersByTime(REMOTE_READY_MS);
  expect(client.call).toHaveBeenCalledTimes(2);
  asked({ threadId: 'wanted' });
  await vi.waitFor(() => expect(rightPanel.for('wanted').active?.kind).toBe('browser'));
  expect(fake.open).toHaveBeenCalledWith('wanted');
  const first = rightPanel.for('wanted').active!.id;
  // Asked again, the tab it has is shown rather than a second one opened.
  rightPanel.for('wanted').open('files');
  asked({ threadId: 'wanted' });
  await vi.waitFor(() => expect(rightPanel.for('wanted').active?.id).toBe(first));
  expect(rightPanel.for('wanted').surfaces.filter(surface => surface.kind === 'browser')).toHaveLength(1);
  stop();
  expect(client.call).toHaveBeenLastCalledWith('browser.remoteReady', { enabled: false });
});
