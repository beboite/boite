import { rpcTrace } from './fixtures/journal-rpc-trace.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../src/client.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
let opened: { harness?: TestCore; owner?: CoreClient; agent?: CoreClient } = {};
let trace: ReturnType<typeof rpcTrace>;
function browserTest(name: string, body: () => Promise<void>) {
  test(name, async () => { try { await body(); } catch (error) { trace.printFailure(); throw error; } });
}
beforeEach(async () => {
  opened = {};
  trace = rpcTrace({ label: 'browser', browser: true, methods: ['hello', 'pairing.grant', 'threads.subscribe', 'browser.host', 'browser.command', 'browser.complete', 'browser.remoteFrame', 'browser.remoteInput'] });
  try {
    opened.harness = harness = await startTestCore();
    opened.owner = owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    opened.agent = agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  } catch (error) { trace.printFailure(); trace.restore(); throw error; }
});
afterEach(async () => { try { opened.agent?.close(); opened.owner?.close(); await opened.harness?.stop(); } finally { trace?.restore(); } });

browserTest('a desktop keeps hosting a background conversation after switching its chat subscription', async () => {
  await owner.call('threads.subscribe', { threadId });
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  await owner.call('threads.unsubscribe', { threadId });
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  const waiting = owner.next('browser.requested', r => r.threadId === threadId);
  const result = agent.call('browser.command', { threadId, action: { kind: 'evaluate', expression: 'document.title' } });
  const request = await waiting;
  await owner.call('browser.complete', { requestId: request.requestId, result: { value: 'Background page' } });
  expect(await result).toEqual({ value: 'Background page' });
});

browserTest('an agent controls only its conversation; only the registered owner socket can answer', async () => {
  await expect(agent.call('browser.command', { threadId, action: { kind: 'snapshot' } })).rejects.toThrow('desktop app');
  await owner.call('threads.subscribe', { threadId });
  await expect(owner.call('browser.host', { threadId, enabled: true })).rejects.toThrow('explicit consent');
  await expect(owner.call('browser.host', { threadId, enabled: true, allowAgentControl: false })).rejects.toThrow('explicit consent');
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  await expect(agent.call('browser.host', { threadId, enabled: true })).rejects.toThrow("agent's methods");
  await expect(agent.call('browser.command', { threadId: 'another-thread', action: { kind: 'snapshot' } })).rejects.toThrow('not thread');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'file:///secret' } })).rejects.toThrow('HTTP');
  const requested = owner.next('browser.requested', () => true);
  const reply = agent.call('browser.command', { threadId, action: { kind: 'snapshot' } });
  const request = await requested;
  const stranger = await harness.connect();
  try {
    await expect(stranger.call('browser.complete', { requestId: request.requestId, result: { value: 'spoof' } })).rejects.toThrow('does not belong');
    await expect(agent.call('browser.complete', { requestId: request.requestId, result: { value: 'spoof' } })).rejects.toThrow("agent's methods");
    await owner.call('browser.complete', { requestId: request.requestId, result: { tabId: 'browser:test', value: { text: 'Rendered page' } } });
    expect(await reply).toEqual({ tabId: 'browser:test', value: { text: 'Rendered page' } });
    await expect(owner.call('browser.complete', { requestId: request.requestId, result: {} })).rejects.toThrow('does not belong');
  } finally { stranger.close(); }
});

browserTest('leaving or losing the host settles in-flight work and requires a fresh registration', async () => {
  await owner.call('threads.subscribe', { threadId });
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  const requested = owner.next('browser.requested', () => true);
  const reply = agent.call('browser.command', { threadId, action: { kind: 'screenshot' } });
  const rejected = reply.catch(error => error as Error);
  const request = await requested;
  await owner.call('browser.host', { threadId, enabled: false });
  expect((await rejected as Error).message).toContain('host left');
  await expect(owner.call('browser.complete', { requestId: request.requestId, result: {} })).rejects.toThrow('does not belong');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'evaluate', expression: 'document.cookie' } })).rejects.toThrow('enable Agent browser control');
  await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
  const again = owner.next('browser.requested', () => true);
  const lost = agent.call('browser.command', { threadId, action: { kind: 'snapshot' } }).catch(error => error as Error);
  await again; owner.close(); expect((await lost as Error).message).toContain('host left');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'status' } })).rejects.toThrow('desktop app');
});

browserTest('paired viewers require desktop consent and a fresh frame of their own; capture does not block agent input', async () => {
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await owner.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
    await expect(phone.call('browser.remoteFrame', { threadId })).rejects.toThrow('subscribe');
    await phone.call('threads.subscribe', { threadId });
    await expect(phone.call('browser.remoteFrame', { threadId })).rejects.toThrow('experiment');
    await expect(phone.call('browser.host', { threadId, enabled: true, remote: true })).rejects.toThrow('owner');
    await expect(phone.call('browser.command', { threadId, action: { kind: 'evaluate', expression: '1' } })).rejects.toThrow('owner');
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: true });
    const waiting = owner.next('browser.requested', r => r.action.kind === 'remote-frame');
    const image = phone.call('browser.remoteFrame', { threadId });
    const request = await waiting;
    const actionWaiting = owner.next('browser.requested', r => r.action.kind === 'click');
    const action = agent.call('browser.command', { threadId, action: { kind: 'click', selector: '#go' } });
    const actionRequest = await actionWaiting;
    await owner.call('browser.complete', { requestId: actionRequest.requestId, result: { value: { ok: true } } });
    expect((await action).value).toEqual({ ok: true });
    await owner.call('browser.complete', { requestId: request.requestId, result: { frame: { id: 'frame-1', tabId: 'browser:test', width: 800, height: 600, title: 'Shared', base64: 'aGVsbG8=', at: Date.now() } } });
    expect((await image).base64).toBe('aGVsbG8=');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'unknown', input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('refresh');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'frame-1', input: { kind: 'tap', x: .5, y: .5, width: 900, height: 600 } })).rejects.toThrow('viewport');
    const clickWaiting = owner.next('browser.requested', r => r.action.kind === 'remote-input');
    const click = phone.call('browser.remoteInput', { threadId, frameId: 'frame-1', input: { kind: 'tap', x: .5, y: .5, width: 800, height: 600 } });
    const clickRequest = await clickWaiting;
    expect(clickRequest.tabId).toBe('browser:test');
    await owner.call('browser.complete', { requestId: clickRequest.requestId, result: { value: { ok: true } } });
    expect(await click).toEqual({ ok: true });
    for (const width of [0, 239, 3841, 393.5, NaN]) {
      await expect(phone.call('browser.remoteInput', { threadId, frameId: 'frame-1', input: { kind: 'viewport', width, height: 700 } })).rejects.toThrow('240 to 3840');
    }
    for (const input of [{ kind: 'viewport', width: 393, height: 700 }, { kind: 'reset-viewport' }] as const) {
      const waiting = owner.next('browser.requested', r => r.action.kind === 'remote-input');
      const result = phone.call('browser.remoteInput', { threadId, frameId: 'frame-1', input });
      const request = await waiting;
      expect(request.tabId).toBe('browser:test');
      expect(request.action).toEqual({ kind: 'remote-input', frameId: 'frame-1', input });
      await owner.call('browser.complete', { requestId: request.requestId, result: {} });
      expect(await result).toEqual({ ok: true });
    }
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: false });
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'frame-1', input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('experiment');
  } finally { phone.close(); }
});

browserTest('disabling sharing while a frame is in flight does not deliver it to a paired viewer', async () => {
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant });
  try {
    await owner.call('threads.subscribe', { threadId }); await phone.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: true });
    const waiting = owner.next('browser.requested', r => r.action.kind === 'remote-frame');
    const image = phone.call('browser.remoteFrame', { threadId }).catch(e => e as Error);
    const request = await waiting;
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: false });
    await owner.call('browser.complete', { requestId: request.requestId, result: { frame: { id: 'late', tabId: 'browser:test', width: 800, height: 600, title: 'Private', base64: 'aGVsbG8=', at: Date.now() } } });
    expect((await image as Error).message).toContain('experiment');
  } finally { phone.close(); }
});

test('a share-only desktop serves a paired viewer, never the agent, and tells its viewers when the tab comes and goes', async () => {
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant });
  try {
    await expect(phone.call('browser.remoteStatus', { threadId })).rejects.toThrow('subscribe');
    await owner.call('threads.subscribe', { threadId }); await phone.call('threads.subscribe', { threadId });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: false });
    // Sharing alone shows nothing: the panel needs a browser tab.
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: false, remote: true });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: false });
    await expect(owner.call('browser.host', { threadId, enabled: true, remote: true, live: 'yes' as never })).rejects.toThrow('live must be booleans');
    const shown = phone.next('browser.remoteChanged', e => e.threadId === threadId);
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: false, remote: true, live: true });
    expect(await shown).toEqual({ threadId, live: true });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: true });
    await expect(agent.call('browser.command', { threadId, action: { kind: 'snapshot' } })).rejects.toThrow('Agent browser control');
    await expect(phone.call('browser.remoteFrame', { threadId, quality: 95 })).rejects.toThrow('quality');
    const waiting = owner.next('browser.requested', r => r.action.kind === 'remote-frame');
    const image = phone.call('browser.remoteFrame', { threadId, maxWidth: 780, quality: 40 });
    const request = await waiting;
    expect(request.action).toEqual({ kind: 'remote-frame', maxWidth: 780, quality: 40 });
    await owner.call('browser.complete', { requestId: request.requestId, result: { frame: { id: 'f', tabId: 'browser:test', width: 800, height: 600, title: 'Docs', base64: 'aGVsbG8=', at: 0, url: 'https://example.com/a' } } });
    expect((await image).url).toBe('https://example.com/a');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'f', input: { kind: 'navigate', url: 'javascript:alert(1)' } })).rejects.toThrow('HTTP');
    const navWaiting = owner.next('browser.requested', r => r.action.kind === 'remote-input');
    const nav = phone.call('browser.remoteInput', { threadId, frameId: 'f', input: { kind: 'history', direction: 'back' } });
    await owner.call('browser.complete', { requestId: (await navWaiting).requestId, result: {} });
    expect(await nav).toEqual({ ok: true });
    // Withdrawing consent hides the tab, and so does the desktop going away.
    const hidden = phone.next('browser.remoteChanged', e => e.threadId === threadId);
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: false, live: true });
    expect(await hidden).toEqual({ threadId, live: false });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: false, remote: true, live: true });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: true });
    const gone = phone.next('browser.remoteChanged', e => e.threadId === threadId);
    owner.close();
    expect(await gone).toEqual({ threadId, live: false });
  } finally { phone.close(); }
});
