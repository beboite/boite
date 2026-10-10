import { expect, test, vi } from 'vitest';
import type { BrowserEvent } from './browser-bridge';
import { BROWSER_HOST_BATCH_BYTES } from '@boite/contracts';
import { AGENT_VIEW_PREFIX, BrowserHostRelay, HOST_PAGE_EVENTS, type HostBridge, type HostClient } from './browser-host';

/** The shell's webviews, as the relay sees them: what it created, asked and closed. */
function fakeBridge() {
  const handlers = new Set<(event: BrowserEvent) => void>();
  const listeners = new Map<string, (method: string, params: Record<string, unknown>) => void>();
  const created: Array<{ id: string; url: string; profile?: string }> = [], destroyed: string[] = [];
  const cookieCalls: Array<{ profile: string; view?: string; cookies?: unknown[] }> = [];
  const protocol = vi.fn(async (id: string, method: string) => (method === 'Runtime.evaluate' ? { result: { value: id } } : {}));
  const bridge: HostBridge = {
    create(id, url, profile) { created.push({ id, url, ...(profile === undefined ? {} : { profile }) }); },
    destroy(id) { destroyed.push(id); },
    relay: protocol,
    async events(id, names, listener) { expect(names).toEqual(HOST_PAGE_EVENTS); listeners.set(id, listener); return () => listeners.delete(id); },
    on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    async cookies(profile, view) { cookieCalls.push({ profile, ...(view ? { view } : {}) }); return [{ name: 'sid', value: profile }]; },
    async setCookies(profile, cookies, view) { cookieCalls.push({ profile, cookies, ...(view ? { view } : {}) }); },
  };
  return { bridge, created, destroyed, protocol, listeners, cookieCalls, emit: (event: BrowserEvent) => { for (const handler of handlers) handler(event); } };
}

/** The core's side: messages it sends per profile, and what came back on each. */
function fakeClient() {
  let deliver: ((payload: { profile: string; message: string }) => void) | null = null;
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: HostClient = {
    call: (async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true }; }) as HostClient['call'],
    on: (_event, handler) => { deliver = handler; return () => { deliver = null; }; },
  };
  let next = 1;
  const send = (profile: string, method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = next++;
    deliver!({ profile, message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) });
    return id;
  };
  /** Every message the relay sent back on `profile`, parsed. */
  const replies = (profile: string) => calls.filter(call => call.method === 'browser.hostReply' && (call.params as { profile: string }).profile === profile)
    .flatMap(call => (call.params as { messages: string[] }).messages.map(text => JSON.parse(text) as Record<string, any>));
  const answer = async (profile: string, id: number) => {
    for (let i = 0; i < 20; i++) { const found = replies(profile).find(reply => reply.id === id); if (found) return found; await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); }
    throw new Error(`no answer to ${id}`);
  };
  return { client, calls, send, replies, answer };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the app answers the core as a browser: a target is a webview, its session is that webview, and it closes on request', async () => {
  const shell = fakeBridge(), core = fakeClient();
  const relay = new BrowserHostRelay(core.client, shell.bridge);
  await relay.start();
  expect(core.calls[0]).toEqual({ method: 'browser.hostAttach', params: {} });

  expect((await core.answer('work', core.send('work', 'Browser.getVersion'))).result).toMatchObject({ product: 'WebView2' });
  // The core keeps a copy of the profile's cookies: read and restored through a webview made for it while no tab is open.
  expect((await core.answer('work', core.send('work', 'Storage.getCookies'))).result).toEqual({ cookies: [{ name: 'sid', value: 'work' }] });
  await core.answer('work', core.send('work', 'Storage.setCookies', { cookies: [{ name: 'kept', value: '1' }] }));
  expect(shell.cookieCalls).toEqual([{ profile: 'work' }, { profile: 'work', cookies: [{ name: 'kept', value: '1' }] }]);
  expect((await core.answer('private', core.send('private', 'Storage.getCookies'))).error.message).toContain('keeps no cookies');
  const { result: { targetId } } = await core.answer('work', core.send('work', 'Target.createTarget', { url: 'about:blank' }));
  expect(targetId.startsWith(AGENT_VIEW_PREFIX)).toBe(true);
  expect(shell.created).toEqual([{ id: targetId, url: 'about:blank', profile: 'work' }]);
  expect((await core.answer('work', core.send('work', 'Target.attachToTarget', { targetId, flatten: true }))).result).toEqual({ sessionId: targetId });

  // A page command goes to that webview's own channel, and its answer keeps the session.
  const evaluated = await core.answer('work', core.send('work', 'Runtime.evaluate', { expression: '1' }, targetId));
  expect(shell.protocol).toHaveBeenCalledWith(targetId, 'Runtime.evaluate', { expression: '1' });
  expect(evaluated).toMatchObject({ sessionId: targetId, result: { result: { value: targetId } } });
  // With a tab of the profile open, its cookies go through that webview: none is made.
  await core.answer('work', core.send('work', 'Storage.getCookies'));
  expect(shell.cookieCalls.at(-1)).toEqual({ profile: 'work', view: targetId });

  // The webview's events and its address come back tagged with it.
  shell.listeners.get(targetId)!('Page.frameNavigated', { frame: { url: 'https://example.com/' } });
  shell.emit({ type: 'url', id: targetId, url: 'https://example.com/' });
  shell.emit({ type: 'title', id: targetId, title: 'Example' });
  await settle(); await settle();
  expect(core.replies('work')).toEqual(expect.arrayContaining([
    { method: 'Page.frameNavigated', params: { frame: { url: 'https://example.com/' } }, sessionId: targetId },
    { method: 'Target.targetInfoChanged', params: { targetInfo: expect.objectContaining({ targetId, url: 'https://example.com/', title: 'Example' }) } },
  ]));

  // A window the page opens is a webview of the same profile that names its opener.
  shell.emit({ type: 'new-window', id: targetId, url: 'https://example.com/popup' });
  await settle(); await settle();
  const popup = core.replies('work').find(reply => reply.method === 'Target.targetCreated')!;
  expect(popup.params.targetInfo).toMatchObject({ type: 'page', openerId: targetId, url: 'https://example.com/popup' });
  expect(shell.created.at(-1)).toEqual({ id: popup.params.targetInfo.targetId, url: 'https://example.com/popup', profile: 'work' });

  // A throwaway context is a private webview, still answering on the profile that asked.
  const { result: { browserContextId } } = await core.answer('work', core.send('work', 'Target.createBrowserContext'));
  const scratch = (await core.answer('work', core.send('work', 'Target.createTarget', { url: 'about:blank', browserContextId }))).result.targetId;
  expect(shell.created.at(-1)).toEqual({ id: scratch, url: 'about:blank', profile: 'private' });
  await core.answer('work', core.send('work', 'Target.disposeBrowserContext', { browserContextId }));
  expect(shell.destroyed).toContain(scratch);

  // Closing a target destroys its webview and says so; a page command to it then fails.
  await core.answer('work', core.send('work', 'Target.closeTarget', { targetId }));
  expect(shell.destroyed).toContain(targetId);
  await settle();
  expect(core.replies('work')).toContainEqual({ method: 'Target.targetDestroyed', params: { targetId } });
  expect((await core.answer('work', core.send('work', 'Runtime.evaluate', {}, targetId))).error.message).toContain('closed');

  // What a browser does not answer here is an error, not silence.
  expect((await core.answer('work', core.send('work', 'Storage.clearCookies'))).error.message).toContain('Storage.clearCookies');

  relay.stop();
  expect(core.calls.at(-1)).toEqual({ method: 'browser.hostDetach', params: {} });
  expect(shell.destroyed).toContain(popup.params.targetInfo.targetId);
});

test('a burst of answers leaves in one call per profile, in order', async () => {
  const shell = fakeBridge(), core = fakeClient();
  const relay = new BrowserHostRelay(core.client, shell.bridge);
  await relay.start();
  const ids = Array.from({ length: 5 }, () => core.send('default', 'Target.setDiscoverTargets', { discover: true }));
  await settle(); await settle();
  const batches = core.calls.filter(call => call.method === 'browser.hostReply');
  expect(batches).toHaveLength(1);
  expect(core.replies('default').map(reply => reply.id)).toEqual(ids);
  relay.stop();
});

test('every reply fits an RPC frame: a burst splits by its size, and an answer too large for any becomes an error', async () => {
  const shell = fakeBridge(), core = fakeClient();
  const half = 'x'.repeat(Math.floor(BROWSER_HOST_BATCH_BYTES / 2) + 1000), whole = '"'.repeat(Math.floor(BROWSER_HOST_BATCH_BYTES / 2));
  shell.protocol.mockImplementation(async (_id: string, method: string, params?: any) => (method === 'Runtime.evaluate' ? { result: { value: params?.expression === 'whole' ? whole : half } } : {}));
  const relay = new BrowserHostRelay(core.client, shell.bridge);
  await relay.start();
  const { result: { targetId } } = await core.answer('work', core.send('work', 'Target.createTarget', { url: 'about:blank' }));
  const before = core.calls.length;
  // Two answers just over half the budget each, and one whose quotes double once escaped in the request.
  const ids = [core.send('work', 'Runtime.evaluate', { expression: 'half' }, targetId), core.send('work', 'Runtime.evaluate', { expression: 'half' }, targetId), core.send('work', 'Runtime.evaluate', { expression: 'whole' }, targetId)];
  for (const id of ids) await core.answer('work', id);
  const sent = core.calls.slice(before).filter(call => call.method === 'browser.hostReply');
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const call of sent) {
    const bytes = (call.params as { messages: string[] }).messages.reduce((sum, text) => sum + new TextEncoder().encode(JSON.stringify(text)).length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(BROWSER_HOST_BATCH_BYTES);
  }
  expect((await core.answer('work', ids[0]!)).result.result.value).toBe(half);
  expect((await core.answer('work', ids[2]!)).error.message).toContain('more than the');
  relay.stop();
});
