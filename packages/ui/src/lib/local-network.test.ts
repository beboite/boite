import { afterEach, expect, test, vi } from 'vitest';
import { localNetwork } from './local-network.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
  localNetwork.state = 'unknown';
});

class Status extends EventTarget {
  constructor(public state: PermissionState) { super(); }
  set(state: PermissionState) {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }
}

test('Chrome 142 to 144 answer under the older name, and turning to granted retries the machines once', async () => {
  const status = new Status('denied');
  const asked: string[] = [];
  vi.stubGlobal('navigator', {
    permissions: {
      query: async ({ name }: { name: string }) => {
        asked.push(name);
        // Chrome before 145 does not know the split name and throws, as for any unknown permission.
        if (name === 'local-network') throw new TypeError(`'${name}' is not a valid value for enumeration PermissionName.`);
        return status;
      }
    }
  });
  const allowed = vi.fn();
  const stop = localNetwork.start(allowed);
  await vi.waitFor(() => expect(localNetwork.state).toBe('denied'));
  expect(asked).toEqual(['local-network', 'local-network-access']);
  status.set('prompt');
  expect(localNetwork.state).toBe('prompt');
  expect(allowed).not.toHaveBeenCalled();
  status.set('granted');
  status.set('granted');
  expect(allowed).toHaveBeenCalledOnce();
  stop();
  // Stopped: later changes reach nothing, and the screen stops speaking of the network.
  expect(localNetwork.state).toBe('unknown');
  status.set('denied');
  expect(localNetwork.state).toBe('unknown');
});

test('a browser that knows neither name blocks nothing and asks nothing of the user', async () => {
  const query = vi.fn(async () => { throw new TypeError('not a valid value'); });
  vi.stubGlobal('navigator', { permissions: { query } });
  const stop = localNetwork.start(vi.fn());
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
  expect(localNetwork.state).toBe('unknown');
  stop();
});
