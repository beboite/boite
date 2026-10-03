import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure, WsClient, type SocketLike } from '../lib/client';
import type { Endpoint } from '../lib/endpoint';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { strings } from '../lib/strings';
import MobileConnect from './MobileConnect.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const stores: Store[] = [];
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  workspace.error = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
  localStorage.clear();
});

class TestSocket implements SocketLike {
  sent: { id: number }[] = [];
  onopen: (() => void) | null = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
  refuse(message = 'the token is wrong') {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ id: this.sent[0]!.id, error: { code: RpcErrorCode.Unauthorized, message } }) });
  }
}

function stubSockets() {
  const sockets: TestSocket[] = [];
  vi.stubGlobal('WebSocket', class extends TestSocket {
    constructor() { super(); sockets.push(this); }
  });
  return sockets;
}

async function refused(error: Error) {
  vi.spyOn(WsClient.prototype, 'connect').mockRejectedValue(error);
  const store = new Store();
  stores.push(store);
  await store.connectEndpoint({ url: 'https://computer.example', token: '' });
  workspace.machines = [{ id: store.endpointUrl!, label: 'My computer', store }];
  workspace.active = store;
  return store;
}

test('an installed app without a browser key offers pairing; a bad link keeps recovery open', async () => {
  const store = await refused(new RpcFailure({ code: RpcErrorCode.Unauthorized, message: 'Missing credential' }));
  expect(store.pairingRequired).toBe(true);
  expect(store.error).toBe(strings.errors.unpaired);
  const onpaired = vi.fn();
  mounted = mount(MobileConnect, { target: document.body, props: { store, onpaired } });
  flushSync();
  expect(document.body.textContent).toContain(strings.mobile.pairInstalled);
  expect(document.querySelector('[data-testid=machine-scan]')).not.toBeNull();
  expect(document.querySelector('[data-testid=mobile-reconnect]')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-testid=machine-add-open]')!.click();
  flushSync();
  const input = document.querySelector<HTMLInputElement>('[data-testid=machine-link]')!;
  input.value = 'not a pairing link';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  document.querySelector<HTMLButtonElement>('[data-testid=machine-add]')!.click();
  await vi.waitFor(() => expect(document.querySelector('[role=alert]')?.textContent).toBe(strings.errors.pairingLink));
  expect(input.value).toBe('not a pairing link');
  expect(onpaired).not.toHaveBeenCalled();

  // A known pairing problem must not hide a later transport failure.
  vi.mocked(WsClient.prototype.connect).mockRejectedValueOnce(new RpcFailure({ code: RpcErrorCode.Internal, message: 'Network unavailable' }));
  await store.connect();
  expect(store.pairingRequired).toBe(true);
  expect(store.error).toBe('Network unavailable');

  // Repairing this machine must not unmount the form while hello is pending.
  let reject!: (error: Error) => void;
  vi.mocked(WsClient.prototype.connect).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const repairing = store.connectEndpoint({ url: 'https://computer.example', token: '', grant: 'expired-test-grant' });
  flushSync();
  expect(store.pairingRequired).toBe(true);
  expect(document.querySelector('[data-testid=machine-link]')).toBe(input);
  reject(new RpcFailure({ code: RpcErrorCode.Unauthorized, message: 'Pairing code expired' }));
  await repairing;
  expect(store.pairingRequired).toBe(true);
  expect(store.error).toContain('Pairing code expired');

  // The next successful connection removes the recovery state.
  store.client?.close();
  store.detach();
  store.attach(new FakeClient({ delayMs: 0, principal: 'session' }));
  await store.connect();
  expect(store.pairingRequired).toBe(false);
  expect(store.error).toBeNull();
});

test('a network failure offers reconnection without asking for another pairing', async () => {
  const store = await refused(new RpcFailure({ code: RpcErrorCode.Internal, message: 'Network unavailable' }));
  expect(store.pairingRequired).toBe(false);
  mounted = mount(MobileConnect, { target: document.body, props: { store, onpaired: vi.fn() } });
  flushSync();
  expect(document.body.textContent).toContain(strings.mobile.offlineBody);
  expect(document.querySelector('[data-testid=machine-scan]')).toBeNull();
  const retry = vi.spyOn(store, 'connect').mockResolvedValue();
  document.querySelector<HTMLButtonElement>('[data-testid=mobile-reconnect]')!.click();
  expect(retry).toHaveBeenCalledOnce();
});

test.each(['retry', 'resume'] as const)('a keyless %s refused after a network failure replaces offline recovery with pairing', async (attempt) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sockets = stubSockets();
  const store = new Store();
  const other = new Store();
  stores.push(store, other);
  const opening = store.connectEndpoint({ url: 'https://computer.example', token: '' });
  sockets[0]!.onerror?.();
  sockets[0]!.close();
  await opening;
  expect(store.pairingRequired).toBe(false);
  mounted = mount(MobileConnect, { target: document.body, props: { store, onpaired: vi.fn() } });
  flushSync();
  expect(document.querySelector('[data-testid=mobile-reconnect]')).not.toBeNull();

  const resumed = attempt === 'resume' ? (store.client as WsClient).resume().catch(() => undefined) : null;
  if (attempt === 'retry') await vi.advanceTimersByTimeAsync(1_200);
  expect(sockets).toHaveLength(2);
  sockets[1]!.refuse();
  await resumed;
  await vi.advanceTimersByTimeAsync(0);
  flushSync();
  expect(store.connection).toBe('closed');
  expect(store.pairingRequired).toBe(true);
  expect(store.error).toBe(strings.errors.unpaired);
  expect(document.querySelector('[data-testid=machine-scan]')).not.toBeNull();
  expect(document.querySelector('[data-testid=mobile-reconnect]')).toBeNull();
  expect(other.pairingRequired).toBe(false);
  expect(other.error).toBeNull();
});

test.each([
  { name: 'a revoked saved session', endpoint: { token: 'revoked-test-session', paired: true }, message: 'the token is wrong', expected: strings.errors.revoked, pairing: true },
  { name: 'an expired grant', endpoint: { token: '', grant: 'expired-test-grant' }, message: 'Pairing code expired', expected: 'Pairing code expired', pairing: true },
  { name: 'the local core token', endpoint: { token: 'old-local-test-token', local: true }, message: 'the token is wrong', expected: 'the token is wrong', pairing: false }
])('$name keeps its own error after the initial hello rejects', async ({ endpoint, message, expected, pairing }) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sockets = stubSockets();
  const store = new Store();
  stores.push(store);
  const opening = store.connectEndpoint({ ...endpoint, url: 'https://computer.example' } as Endpoint);
  sockets[0]!.refuse(message);
  await opening;
  expect(store.pairingRequired).toBe(pairing);
  expect(store.error).toBe(expected);
});

test('a revoked response queued by the old client cannot mark its replacement as unpaired', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const sockets = stubSockets();
  const store = new Store();
  stores.push(store);
  const first = store.connectEndpoint({ url: 'https://first.example', token: 'revoked-test-session', paired: true });
  sockets[0]!.refuse();
  store.client!.close();
  store.detach();
  const second = store.connectEndpoint({ url: 'https://second.example', token: 'valid-test-session', paired: true });
  await first;
  expect(store.endpointUrl).toBe('https://second.example');
  expect(store.connection).toBe('connecting');
  expect(store.pairingRequired).toBe(false);
  expect(store.error).toBeNull();
  sockets[1]!.onerror?.();
  sockets[1]!.close();
  await second;
  expect(store.pairingRequired).toBe(false);
  expect(store.error).toBe('socket error');
});

test('the installed app pairs from a typed code, and says to scan from here rather than the camera', async () => {
  const store = await refused(new RpcFailure({ code: RpcErrorCode.Unauthorized, message: 'Missing credential' }));
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  try {
    const onpaired = vi.fn();
    const pair = vi.spyOn(workspace, 'pair').mockResolvedValue(true);
    mounted = mount(MobileConnect, { target: document.body, props: { store, onpaired } });
    flushSync();
    expect(document.querySelector('[data-testid=mobile-pair-hint]')?.textContent).toBe(strings.mobile.scanInApp);
    // Scan stays the first thing offered; the code is the second way in.
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.pair-machine button')].map((button) => button.dataset['testid']);
    expect(buttons.indexOf('machine-scan')).toBeLessThan(buttons.indexOf('machine-code-open'));
    document.querySelector<HTMLButtonElement>('[data-testid=machine-code-open]')!.click();
    flushSync();
    const input = document.querySelector<HTMLInputElement>('[data-testid=machine-code]')!;
    expect(input.getAttribute('autocapitalize')).toBe('characters');
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      document.querySelector<HTMLButtonElement>('[data-testid=machine-code-submit]')!.click();
      flushSync();
    };
    type('K7QM-22');
    expect(document.querySelector('[data-testid=machine-code-form] [role=alert]')?.textContent).toBe(strings.machines.codeInvalid);
    expect(pair).not.toHaveBeenCalled();
    type(' k7qm-2222 ');
    await vi.waitFor(() => expect(onpaired).toHaveBeenCalledOnce());
    expect(pair).toHaveBeenCalledWith(`${location.origin}/?grant=K7QM2222`, '');
    expect(document.querySelector('[data-testid=machine-code-form]')).toBeNull();
  } finally {
    delete (navigator as { standalone?: boolean }).standalone;
  }
});