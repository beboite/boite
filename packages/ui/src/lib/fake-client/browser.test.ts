import { expect, test } from 'vitest';
import type { RpcEvents } from '@boite/contracts';
import { FakeClient } from '../fake-client';

test('the agent opens, drives and closes its tabs; subscribed viewers hear each change and watch any tab', async () => {
  const client = new FakeClient({ delayMs: 0 }), threadId = 't-trace';
  const changes: RpcEvents['browser.remoteChanged'][] = [];
  client.on('browser.remoteChanged', event => changes.push(event));
  try {
    await client.connect();
    await expect(client.call('browser.remoteStatus', { threadId })).rejects.toThrow('subscribe');
    await client.call('threads.subscribe', { threadId });
    expect(await client.call('browser.remoteStatus', { threadId })).toEqual({ live: false, tabs: [], available: true });
    await expect(client.call('browser.remoteFrame', { threadId })).rejects.toThrow('no browser tab');
    await expect(client.call('browser.command', { threadId, action: { kind: 'open', url: 'file:///private' } })).rejects.toThrow('HTTP');
    await expect(client.call('browser.command', { threadId, tabId: 'main', action: { kind: 'snapshot' } })).rejects.toThrow('tabId');
    await expect(client.call('browser.command', { threadId, action: { kind: 'snapshot' } })).rejects.toThrow('browser open');

    const docs = await client.call('browser.command', { threadId, action: { kind: 'open', url: 'https://example.com/docs' } });
    const shop = await client.call('browser.command', { threadId, action: { kind: 'open', url: 'https://shop.example/' } });
    expect(changes.map(change => change.tabs.map(tab => [tab.url, tab.active]))).toEqual([
      [['https://example.com/docs', true]],
      [['https://example.com/docs', false], ['https://shop.example/', true]],
    ]);
    // The active tab without a tabId, any tab with one.
    expect((await client.call('browser.remoteFrame', { threadId, maxWidth: 780, quality: 40 })).tabId).toBe(shop.tabId);
    await new Promise(resolve => setTimeout(resolve, 230));
    const frame = await client.call('browser.remoteFrame', { threadId, tabId: docs.tabId });
    expect(frame).toMatchObject({ tabId: docs.tabId, url: 'https://example.com/docs', width: 1280, height: 800 });
    await expect(client.call('browser.remoteFrame', { threadId })).rejects.toThrow('wait before');
    await expect(client.call('browser.remoteFrame', { threadId, maxWidth: 99 })).rejects.toThrow('maxWidth');

    await client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'tap', x: 0.5, y: 0.2, width: frame.width, height: frame.height } });
    await client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'text', text: 'Bonjour' } });
    expect((await client.call('browser.command', { threadId, tabId: docs.tabId, action: { kind: 'snapshot' } })).value).toMatchObject({ text: expect.stringContaining('Taps: 1\nBonjour') });
    await expect(client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'tap', x: 0.5, y: 0.2, width: 10, height: 10 } })).rejects.toThrow('viewport changed');
    // A page that moves retires the frames taken of it.
    await client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'viewport', width: 393, height: 700 } });
    await expect(client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('page changed');

    await client.call('browser.command', { threadId, tabId: shop.tabId, action: { kind: 'close' } });
    expect(await client.call('browser.remoteStatus', { threadId })).toMatchObject({ live: true, tabs: [{ tabId: docs.tabId, active: true }] });
    await expect(client.call('browser.remoteFrame', { threadId, tabId: shop.tabId })).rejects.toThrow('closed');
    await client.call('browser.command', { threadId, action: { kind: 'close' } });
    expect(changes.at(-1)).toEqual({ threadId, live: false, tabs: [] });
  } finally { client.close(); }
});

test('archiving the conversation closes its agent browser', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const changes: RpcEvents['browser.remoteChanged'][] = [];
  client.on('browser.remoteChanged', event => changes.push(event));
  try {
    await client.connect();
    const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await client.call('threads.subscribe', { threadId: thread.id });
    await client.call('browser.command', { threadId: thread.id, action: { kind: 'open', url: 'https://example.com/' } });
    await client.call('threads.archive', { threadId: thread.id });
    expect(changes.at(-1)).toEqual({ threadId: thread.id, live: false, tabs: [] });
    await expect(client.call('browser.command', { threadId: thread.id, action: { kind: 'status' } })).rejects.toThrow('active conversation');
  } finally { client.close(); }
});

test('back and forward follow the tab position when a page was visited twice', async () => {
  const client = new FakeClient({ delayMs: 0 }), threadId = 't-trace';
  try {
    await client.connect();
    await client.call('threads.subscribe', { threadId });
    await client.call('browser.command', { threadId, action: { kind: 'open', url: 'https://a.example/' } });
    await client.call('browser.command', { threadId, action: { kind: 'navigate', url: 'https://b.example/' } });
    await client.call('browser.command', { threadId, action: { kind: 'navigate', url: 'https://a.example/' } });
    const step = async (direction: 'back' | 'forward') => {
      await new Promise(resolve => setTimeout(resolve, 230));
      const frame = await client.call('browser.remoteFrame', { threadId });
      await client.call('browser.remoteInput', { threadId, frameId: frame.id, input: { kind: 'history', direction } });
      return (await client.call('browser.remoteStatus', { threadId })).tabs[0]!.url;
    };
    expect(await step('back')).toBe('https://b.example/');
    expect(await step('back')).toBe('https://a.example/');
    expect(await step('forward')).toBe('https://b.example/');
  } finally { client.close(); }
});
