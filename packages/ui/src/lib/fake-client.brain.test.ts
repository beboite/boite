import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';

test('the fake exposes manual skills independently of sharing until the folder is disconnected', async () => {
  const client = new FakeClient({ delayMs: 0 });
  try {
    await client.connect();
    expect(await client.call('brain.commands', {})).toEqual([]);
    await client.call('brain.configure', { path: '/shared/brain', enabled: true });
    expect(await client.call('brain.commands', {})).toEqual([{ name: 'focus', description: 'Work through one task at a time.', hint: null }]);
    await client.call('brain.configure', { path: '/shared/brain', enabled: false });
    expect(await client.call('brain.commands', {})).toEqual([{ name: 'focus', description: 'Work through one task at a time.', hint: null }]);
    await client.call('brain.configure', { path: null, enabled: false });
    expect(await client.call('brain.commands', {})).toEqual([]);
  } finally { client.close(); }
});

test('paired fake clients may read the manual menu without brain configuration access', async () => {
  const client = new FakeClient({ delayMs: 0, principal: 'session' });
  try {
    await client.connect();
    expect(await client.call('brain.commands', {})).toEqual([]);
    await expect(client.call('brain.status', {})).rejects.toThrow('owner');
  } finally { client.close(); }
});
