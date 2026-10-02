import { afterEach, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync, mount, unmount } from 'svelte';
import type { Account, ProviderSummary } from '@boite/contracts';
import AccountsPage from './AccountsPage.svelte';
import { nextAccountLabel, setupStep } from '../lib/provider-setup';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

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
  expect(document.querySelector('button:disabled')).toBeNull();
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
