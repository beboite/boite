import { afterEach, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync, mount, unmount } from 'svelte';
import type { Account, ProviderSummary } from '@boite/contracts';
import AccountsPage from './AccountsPage.svelte';
import { confirm } from '../lib/confirm.svelte';
import { nextAccountLabel, setupStep } from '../lib/provider-setup';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { confirm.answer(false); if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

const row = (id: string) => document.querySelector(`[data-testid="provider-settings"][data-provider-id="${id}"]`);

test('every missing provider has exactly one next step in its row', async ({ createStore }) => {
  const { store, client } = createStore({});
  await client.connect();
  const { loaded } = await client.call('providers.list', {});
  store.providers = loaded.map(provider => ({ ...provider, available: false, executable: null }));
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  // Boite downloads this one: Install, and nothing else to choose from.
  expect(row('antigravity')?.getAttribute('data-step')).toBe('install');
  expect(row('antigravity')?.querySelector('[data-testid="install-start"]')).not.toBeNull();
  expect(row('antigravity')?.querySelector('[data-testid="provider-sign-in"]')).toBeNull();
  // This one has its own installer: the guide, and a way to look again.
  expect(row('claude')?.getAttribute('data-step')).toBe('manual');
  expect(row('claude')?.querySelector('a')?.getAttribute('href')).toContain('code.claude.com');
  expect(row('claude')?.querySelector('[data-testid="providers-refresh"]')).not.toBeNull();
  expect(document.querySelector('[data-testid=provider-settings] button:disabled')).toBeNull();
});

const provider = (patch: Partial<ProviderSummary>): ProviderSummary => ({
  id: 'claude', name: 'Claude', shortName: 'Claude', protocol: 'claude-sdk', source: 'shipped', available: true,
  executable: 'claude.exe', models: [], login: { kind: 'command' }, alwaysIsolated: false, install: null,
  capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: true, resume: true },
  ...patch
});
const account = (patch: Partial<Account>): Account => ({
  id: 'a1', providerId: 'claude', label: 'Default', isolationDir: null, status: 'ok', identity: null, createdAt: 0, ...patch
});
const idle = () => false;

test('setupStep names one step, install first, then sign-in, then ready', () => {
  const absent = { state: 'absent', version: '1', archiveBytes: 10 } as const;
  const installed = { state: 'installed', version: '1', available: '1', installedAt: 0 } as const;
  expect(setupStep(provider({ available: false, install: absent }), absent, [], idle)).toBe('install');
  expect(setupStep(provider({ available: false }), null, [], idle)).toBe('manual');
  expect(setupStep(provider({ available: false, install: installed }), installed, [], idle)).toBe('repair');
  // An agent the user installed on their own is there whatever Boite's release says.
  expect(setupStep(provider({ install: absent }), absent, [account({})], idle)).toBe('ready');
  expect(setupStep(provider({}), null, [account({ status: 'unauthenticated' })], idle)).toBe('sign-in');
  expect(setupStep(provider({ login: false }), null, [account({ status: 'unauthenticated' })], idle)).toBe('external');
  expect(setupStep(provider({}), null, [account({ status: 'unauthenticated' })], () => true)).toBe('signing-in');
});

test('an added account is named after its provider, numbered from the second', () => {
  expect(nextAccountLabel(provider({}), [account({})])).toBe('Claude');
  expect(nextAccountLabel(provider({}), [account({ label: 'Claude' })])).toBe('Claude 2');
});


test('checking a signed-out account reports its connection without probing models', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  const signedOut = await store.addAccount({ providerId: 'codex', label: 'Signed out' });
  const calls = vi.spyOn(client, 'call');
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  (row('codex')?.querySelector('[data-testid="provider-details-toggle"]') as HTMLButtonElement).click();
  flushSync();
  const target = document.querySelector(`[data-testid="account-row"][data-account-id="${signedOut!.id}"]`)!;
  (target.querySelector('[data-testid="account-verify"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toContain('not signed in'));
  expect(calls.mock.calls.some(([method]) => method === 'providers.probe')).toBe(false);
  expect(calls.mock.calls.some(([method, params]) => method === 'accounts.check' && 'refresh' in params && params.refresh === true)).toBe(true);

});

test('accounts keep their chosen name and reveal the email on demand', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  store.providers = [provider({})];
  store.accounts = [account({ identity: 'work@example.com' })];
  const rename = vi.spyOn(store, 'renameAccount').mockResolvedValue(true);
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  (row('claude')?.querySelector('[data-testid="provider-details-toggle"]') as HTMLButtonElement).click();
  flushSync();
  expect(document.querySelector('h3')?.textContent).toBe('Default');
  const email = document.querySelector('[data-testid="account-email"]') as HTMLButtonElement;
  expect(email.getAttribute('aria-pressed')).toBe('false');
  email.click(); flushSync();
  expect(email.classList.contains('revealed')).toBe(true);
  (document.querySelector('[data-testid="account-rename"]') as HTMLButtonElement).click(); flushSync();
  const input = document.querySelector('[data-testid="account-name"]') as HTMLInputElement;
  input.value = 'Work'; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(rename).toHaveBeenCalledWith('a1', 'Work'));

});

test('a proxied provider shows only the gateway account, without actions, and its local accounts come back', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  await store.reload();
  const douane = { enabled: true, kind: 'douane' as const, baseUrl: 'http://gateway.test:8787', dashboardUrl: 'http://gateway.test:8787/admin/#quotas' };
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: douane });
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  expect(row('claude')?.textContent).toContain('Ready · via Douane');
  // Grok is served by Douane alone: behind CLIProxyAPI it keeps its own accounts.
  expect(row('grok')?.textContent).toContain('Ready · via Douane');
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, kind: 'cliproxyapi' } });
  flushSync();
  expect(row('claude')?.textContent).toContain('Ready · via CLIProxyAPI');
  expect(row('grok')?.textContent).not.toContain('via CLIProxyAPI');
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: douane });
  flushSync();
  (row('claude')?.querySelector('[data-testid="provider-details-toggle"]') as HTMLButtonElement).click();
  flushSync();
  const gateway = row('claude')!.querySelector('[data-testid="account-gateway"]')!;
  expect(gateway.querySelector('h3')!.textContent).toBe('Douane');
  expect(gateway.textContent).toContain('http://gateway.test:8787');
  expect(gateway.querySelector('button')).toBeNull();
  for (const testId of ['account-row', 'account-rename', 'account-verify', 'account-remove', 'account-add', 'account-use-cli'])
    expect(row('claude')!.querySelector(`[data-testid="${testId}"]`), testId).toBeNull();

  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, enabled: false } });
  flushSync();
  expect(row('claude')!.querySelector('[data-testid="account-gateway"]')).toBeNull();
  expect([...row('claude')!.querySelectorAll('[data-testid="account-row"]')].map(entry => entry.getAttribute('data-account-id'))).toEqual(['a-claude-main', 'a-claude-side']);
  expect(row('claude')!.querySelector('[data-testid="account-add"]')).not.toBeNull();
});
const toggle = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid="provider-enabled"][data-provider-id="${id}"]`)!;

test('Muse recognizes the native Meta pool and restores Sign in when Douane is disabled', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0 });
  await store.reload();
  const muse = store.accounts.find(account => account.providerId === 'muse')!;
  store.accounts = store.accounts.map(account => account.id === muse.id ? { ...account, status: 'unauthenticated' } : account);
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  expect(row('muse')?.textContent).toContain('Not signed in');
  const douane = { enabled: true, kind: 'douane' as const, baseUrl: 'https://gateway.test/v1', dashboardUrl: 'https://gateway.test/admin/' };
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: douane });
  flushSync();
  expect(row('muse')?.textContent).toContain('Ready · via Douane');
  expect(store.accountsOf('muse')).toEqual([expect.objectContaining({ id: muse.id, label: 'Douane', status: 'ok' })]);
  expect(store.accounts.find(account => account.id === muse.id)?.status).toBe('unauthenticated');
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, enabled: false } });
  flushSync();
  expect(row('muse')?.textContent).toContain('Not signed in');
  store.settings = await client.call('subscriptionProxy.configure', { subscriptionProxy: { ...douane, kind: 'cliproxyapi' } });
  flushSync();
  expect(store.gatewayOf('muse')).toBeNull();
  expect(row('muse')?.textContent).toContain('Not signed in');
});
const group = (id: string) => row(id)?.parentElement?.getAttribute('data-testid');

test('the switch turns a provider off through providers.setEnabled and its row moves to Turned off', async ({ ready }) => {
  const { store, client } = await ready();
  const call = vi.spyOn(client, 'call');
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  expect(group('claude')).toBe('providers-connected');
  expect(toggle('claude').checked).toBe(true);
  expect(toggle('claude').getAttribute('role')).toBe('switch');

  toggle('claude').click();
  await vi.waitFor(() => expect(group('claude')).toBe('providers-off'));
  expect(call).toHaveBeenCalledWith('providers.setEnabled', { providerId: 'claude', enabled: false });
  expect(row('claude')?.getAttribute('data-enabled')).toBe('false');
  expect(row('claude')?.querySelector('[data-testid="provider-state"]')?.textContent).toContain('Turned off');
  // Off, the row offers no way in: only the switch that brings it back.
  expect(row('claude')?.querySelector('[data-testid="provider-sign-in"], [data-testid="install-start"], [data-testid="provider-setup"]')).toBeNull();

  toggle('claude').click();
  await vi.waitFor(() => expect(group('claude')).toBe('providers-connected'));
  expect(call).toHaveBeenLastCalledWith('providers.setEnabled', { providerId: 'claude', enabled: true });
});

test('an experimental provider is off until turned on and says so in both places', async ({ ready }) => {
  const { store } = await ready();
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  expect(group('opencode-v2')).toBe('providers-off');
  expect(row('opencode-v2')?.querySelector('[data-testid="provider-experimental"]')?.textContent).toBe('Experimental');
  expect(row('claude')?.querySelector('[data-testid="provider-experimental"]')).toBeNull();
  // A row of its own with OpenCode's guide, never a member of OpenCode's row.
  expect(row('opencode')?.querySelector('[data-testid="provider-member"]')).toBeNull();

  toggle('opencode-v2').click();
  await vi.waitFor(() => expect(group('opencode-v2')).not.toBe('providers-off'));
  expect(row('opencode-v2')?.querySelector('[data-testid="provider-experimental"]')).not.toBeNull();
});


test('a local ACP command is added from its form, a refused field is marked, and the provider leaves from its details', async ({ ready }) => {
  const { store, client } = await ready();
  const call = vi.spyOn(client, 'call');
  mounted = mount(AccountsPage, { target: document.body, props: { store } });
  flushSync();
  const field = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`)!;
  const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };

  field('local-acp-open').click();
  flushSync();
  expect(field<HTMLButtonElement>('local-acp-save').disabled).toBe(true);
  type(field('local-acp-name'), 'Echo');
  type(field('local-acp-command'), 'my-agent');
  field('local-acp-add-arg').click();
  flushSync();
  type(field('local-acp-arg'), '--profile');
  field('local-acp-add-arg').click();
  flushSync();
  type(document.querySelectorAll<HTMLInputElement>('[data-testid="local-acp-arg"]')[1]!, 'two words');
  field('local-acp-add-env').click();
  flushSync();
  type(field('local-acp-env-key'), 'AGENT_MODE');
  type(field('local-acp-env-value'), 'acp');

  // A name another provider uses: the core names the field and the form keeps what was typed.
  field('local-acp-save').click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="local-acp-error"]')).not.toBeNull());
  expect(field('local-acp-name').getAttribute('aria-invalid')).toBe('true');
  expect(field('local-acp-command').getAttribute('aria-invalid')).toBe('false');
  expect(field<HTMLInputElement>('local-acp-command').value).toBe('my-agent');

  type(field('local-acp-name'), 'My Agent');
  field('local-acp-save').click();
  await vi.waitFor(() => expect(row('my-agent')).not.toBeNull());
  expect(call).toHaveBeenCalledWith('providers.addLocal', {
    name: 'My Agent', command: 'my-agent', args: ['--profile', 'two words'], env: { AGENT_MODE: 'acp' }
  });
  await vi.waitFor(() => expect(field('local-acp-added').textContent).toBe('My Agent added'));
  expect(document.querySelector('[data-testid="local-acp-name"]')).toBeNull();

  row('my-agent')!.querySelector<HTMLButtonElement>('[data-testid="provider-details-toggle"]')!.click();
  flushSync();
  row('my-agent')!.querySelector<HTMLButtonElement>('[data-testid="local-acp-remove"]')!.click();
  await vi.waitFor(() => expect(confirm.current?.title).toBe('Remove My Agent?'));
  confirm.answer(true);
  await vi.waitFor(() => expect(row('my-agent')).toBeNull());
  expect(call).toHaveBeenCalledWith('providers.removeLocal', { providerId: 'my-agent' });
  // A provider that ships with Boite has nothing to remove.
  expect(row('claude')?.querySelector('[data-testid="local-acp-remove"]')).toBeNull();
});
