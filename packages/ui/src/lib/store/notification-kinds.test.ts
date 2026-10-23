import { afterEach, expect } from 'vitest';
import { test } from '../../test/fake-client';
import { PUSH_HOME_STORAGE_KEY, setPushHomeClient } from '../notify';

afterEach(() => {
  setPushHomeClient(null);
  localStorage.clear();
});

test('a kind turned off while one machine is shown is off on every machine, and the next click turns it back on', async ({ ready }) => {
  localStorage.clear();
  const a = await ready();
  const b = await ready();
  a.store.setNotificationKind('finished', false);
  expect(a.store.notificationKinds).not.toContain('finished');
  expect(b.store.notificationKinds).not.toContain('finished');
  b.store.setNotificationKind('finished', true);
  expect(a.store.notificationKinds).toContain('finished');
});

test('kinds changed while another machine is shown go to the machine holding the push subscription', async ({ ready }) => {
  localStorage.clear();
  const home = await ready();
  const shown = await ready();
  home.store.endpointUrl = 'https://home.test';
  shown.store.endpointUrl = 'https://shown.test';
  localStorage.setItem('boite.web-push', 'on');
  localStorage.setItem(PUSH_HOME_STORAGE_KEY, 'https://home.test');
  const calls: { on: string; params: unknown }[] = [];
  for (const [name, owned] of [['home', home], ['shown', shown]] as const) {
    const call = owned.store.client!.call.bind(owned.store.client!);
    owned.store.client!.call = (async (method: string, params: unknown) => {
      if (method === 'push.kinds') { calls.push({ on: name, params }); return { ok: true }; }
      return call(method as never, params as never);
    }) as typeof call;
  }
  setPushHomeClient((address) => (address === 'https://home.test' ? home.store.client : null));
  shown.store.setNotificationKind('questions', false);
  expect(calls).toEqual([{ on: 'home', params: { kinds: ['approvals', 'finished', 'errors', 'limits'] } }]);
});
