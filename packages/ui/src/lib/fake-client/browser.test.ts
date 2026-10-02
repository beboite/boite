import { expect, test, vi } from 'vitest';
import type { RpcEvents } from '@boite/contracts';
import { FakeClient } from '../fake-client';

test('remote capture coexists with input and a revoked capture stays revoked after sharing resumes', async () => {
  const client = new FakeClient({ delayMs: 0 }), threadId = 't-trace';
  const requests: RpcEvents['browser.requested'][] = [];
  client.on('browser.requested', request => requests.push(request));
  try {
    await client.connect(); await client.call('threads.subscribe', { threadId });
    await expect(client.call('browser.host', { threadId, enabled: true, remote: true })).rejects.toThrow('explicit consent');
    await client.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: true });
    const capture = client.call('browser.remoteFrame', { threadId }).catch(error => error as Error);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const input = client.call('browser.command', { threadId, action: { kind: 'click', selector: '#go' } });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await client.call('browser.complete', { requestId: requests[1]!.requestId, result: { value: { ok: true } } });
    expect((await input).value).toEqual({ ok: true });
    await client.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: false });
    await client.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: true });
    await client.call('browser.complete', { requestId: requests[0]!.requestId, result: { frame: { id: 'late', tabId: 'browser:test', width: 800, height: 600, title: 'Private', base64: 'aGVsbG8=', at: Date.now() } } });
    expect((await capture as Error).message).toContain('shared browser changed');
    await expect(client.call('browser.remoteInput', { threadId, frameId: 'late', input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('refresh');
  } finally { client.close(); }
});

test('fake remote resize shares the bounded contract and routes to the captured tab', async () => {
  const client = new FakeClient({ delayMs: 0 }), threadId = 't-trace';
  const requests: RpcEvents['browser.requested'][] = [];
  client.on('browser.requested', request => requests.push(request));
  try {
    await client.connect(); await client.call('threads.subscribe', { threadId });
    await client.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: true });
    const image = client.call('browser.remoteFrame', { threadId });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await client.call('browser.complete', { requestId: requests[0]!.requestId, result: { frame: { id: 'size', tabId: 'browser:test', width: 800, height: 600, title: 'Fixture', base64: 'aGVsbG8=', at: Date.now() } } });
    await image;
    await expect(client.call('browser.remoteInput', { threadId, frameId: 'size', input: { kind: 'viewport', width: 9000, height: 700 } })).rejects.toThrow('240 to 3840');
    for (const input of [{ kind: 'viewport', width: 393, height: 700 }, { kind: 'reset-viewport' }] as const) {
      const count = requests.length;
      const action = client.call('browser.remoteInput', { threadId, frameId: 'size', input });
      await vi.waitFor(() => expect(requests).toHaveLength(count + 1));
      const request = requests[count]!;
      expect(request.tabId).toBe('browser:test');
      expect(request.action).toEqual({ kind: 'remote-input', frameId: 'size', input });
      await client.call('browser.complete', { requestId: request.requestId, result: {} });
      expect(await action).toEqual({ ok: true });
    }
  } finally { client.close(); }
});
