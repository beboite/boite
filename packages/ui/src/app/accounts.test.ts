import { expect, vi } from 'vitest';
import { confirm } from '../lib/confirm.svelte';
import { store } from '../lib/store.svelte';
import { mountOnFake, openProviderDetails, query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('an isolated account that is not logged in logs in from the Accounts page', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-accounts]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-accounts]').click();
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  // Claude is ready on the default login, so its row asks for nothing.
  expect(query('[data-provider-id=claude]').getAttribute('data-step')).toBe('ready');
  expect(document.querySelector('[data-provider-id=claude] [data-testid=provider-sign-in]')).toBeNull();
  await openProviderDetails('claude');

  // Only the isolated seat is unauthenticated; the default login has no button.
  expect(document.querySelectorAll('[data-testid=account-login]').length).toBe(1);
  expect(query('[data-testid=account-login]').getAttribute('data-account-id')).toBe('a-claude-side');

  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-url]') !== null);
  const link = query<HTMLAnchorElement>('[data-testid=account-login-url]');
  expect(link.getAttribute('href')).toBe('https://example.invalid/login?code=fake');
  expect(link.getAttribute('target')).toBe('_blank');

  const code = query<HTMLInputElement>('[data-testid=account-login-input]');
  code.value = 'pasted-code';
  code.dispatchEvent(new Event('input', { bubbles: true }));
  query<HTMLButtonElement>('[data-testid=account-login-send]').click();

  await waitFor(() => store.accountOf('a-claude-side')?.status === 'ok');
  await waitFor(() => document.querySelector('[data-testid=account-login-row]') === null);
  expect(document.querySelector('[data-testid=account-login]')?.textContent).toContain('Sign in again');

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('Add another account names the account itself and goes straight to the sign-in', async () => {
  store.draft = null;
  await mountOnFake();
  store.showSettings('accounts');
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  // Nothing to fill in: no form, no label, no provider to choose.
  expect(document.querySelector('[data-testid=accounts-page] select')).toBeNull();
  await openProviderDetails('claude');
  const before = store.accountsOf('claude').length;
  query<HTMLButtonElement>('[data-provider-id=claude] [data-testid=account-add]').click();
  await waitFor(() => store.accountsOf('claude').length === before + 1);
  const added = store.accountsOf('claude').at(-1)!;
  expect(added.label).toBe('Claude');
  expect(added.isolationDir).not.toBeNull();
  await waitFor(() => document.querySelector(`[data-testid=account-login-row][data-account-id=${added.id}]`) !== null);
});

test('account lifecycle removal asks first and cancellation keeps the account', async ({ app: _app }) => {
  store.showSettings('accounts');
  await waitFor(() => document.querySelector('[data-testid=accounts-page]') !== null);
  await openProviderDetails('claude');
  const selector = '[data-testid=account-remove][data-account-id=a-claude-side]';
  expect(document.querySelector(selector)).not.toBeNull();
  query<HTMLButtonElement>(selector).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  expect(query('[data-testid=confirm-dialog]').textContent).toContain('deletes its files');
  query<HTMLButtonElement>('[data-testid=confirm-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') === null);
  expect(store.accounts.some((a) => a.id === 'a-claude-side')).toBe(true);
  query<HTMLButtonElement>(selector).click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => !store.accounts.some((a) => a.id === 'a-claude-side'));
});

test('account lifecycle cancel button stops login and restores retry', async ({ app: _app }) => {
  store.showSettings('accounts');
  await openProviderDetails('claude');
  query<HTMLButtonElement>('[data-testid=account-login]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-cancel]') !== null);
  query<HTMLButtonElement>('[data-testid=account-login-cancel]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-row]') === null);
  // The core ends a cancelled login as failed, not done: the store drops the row all the same.
  expect(store.logins).toEqual({});
  expect(document.querySelector('[data-testid=account-login]')).not.toBeNull();
});

test('a failed account login can be dismissed and removed without restarting', async ({ app: _app }) => {
  store.showSettings('accounts');
  await openProviderDetails('claude');
  store.logins['a-claude-side'] = { state: 'failed', output: 'Sign-in failed', url: null, exitCode: 1 };
  await waitFor(() => document.querySelector('[data-testid=account-login-output]')?.textContent === 'Sign-in failed');
  query<HTMLButtonElement>('[data-testid=account-login-dismiss]').click();
  await waitFor(() => document.querySelector('[data-testid=account-login-row]') === null);
  query<HTMLButtonElement>('[data-testid=account-remove][data-account-id=a-claude-side]').click();
  await waitFor(() => document.querySelector('[data-testid=confirm-dialog]') !== null);
  query<HTMLButtonElement>('[data-testid=confirm-ok]').click();
  await waitFor(() => !store.accounts.some(account => account.id === 'a-claude-side'));
});

test('a thread on a signed-out account offers the sign-in only once no other account of its agent can run it', async ({ app: _app }) => {
  const client = store.client!;
  const account = await client.call('accounts.add', { providerId: 'claude', label: 'Work', useDefaultLocation: false });
  expect(account.status).toBe('unauthenticated');
  const [project] = await client.call('projects.list', {});
  const thread = await client.call('threads.create', { projectId: project!.id, providerId: 'claude', accountId: account.id, title: 'Signed out' });
  await waitFor(() => store.threads.some((entry) => entry.id === thread.id));
  await store.open(thread.id);
  // The signed-in main account takes the next send over, so nothing asks to sign in.
  await waitFor(() => document.querySelector('[data-testid=composer-attach]') !== null);
  expect(document.querySelector('[data-testid=composer-reconnect]')).toBeNull();
  for (const entry of store.accounts) if (entry.providerId === 'claude') entry.status = 'unauthenticated';
  await waitFor(() => document.querySelector('[data-testid=composer-reconnect]') !== null);
});

test('account lifecycle provider metadata gates login and the command-line login', async ({ app: _app }) => {
  store.showSettings('accounts');
  await openProviderDetails('claude');
  const side = store.accounts.find((a) => a.id === 'a-claude-side')!;
  const provider = store.providers.find((p) => p.id === 'claude')!;
  side.status = 'unknown';
  await waitFor(() => document.querySelector('[data-testid=account-login]') !== null);
  store.logins[side.id] = { state: 'failed', output: 'refused', url: null, exitCode: 1 };
  await waitFor(() => document.querySelector('[data-testid=account-login-output]')?.textContent?.trim() === 'refused');
  expect(document.querySelector('[data-testid=account-login]')).not.toBeNull();
  provider.login = false;
  await waitFor(() => document.querySelector('[data-testid=account-login]') === null);
  // The command-line login is offered only while no account uses it, and never
  // on a provider whose accounts are all isolated.
  expect(document.querySelector('[data-provider-id=claude] [data-testid=account-use-cli]')).toBeNull();
  store.accounts = store.accounts.filter((a) => !(a.providerId === 'claude' && a.isolationDir === null));
  await waitFor(() => document.querySelector('[data-provider-id=claude] [data-testid=account-use-cli]') !== null);
  provider.alwaysIsolated = true;
  await waitFor(() => document.querySelector('[data-provider-id=claude] [data-testid=account-use-cli]') === null);
});

test('an ACP login accepts the phone redirect URL through the login input', async ({ app: _app }) => {
  store.showSettings('accounts');
  await store.installProvider('antigravity');
  await waitFor(() => store.providerOf('antigravity')?.available === true);
  // Installed and nobody signed in: its block in the Antigravity row offers the sign-in.
  await openProviderDetails('antigravity');
  const loginButton = '[data-provider-id=antigravity] [data-testid=provider-sign-in]';
  await waitFor(() => document.querySelector(loginButton) !== null);
  query<HTMLButtonElement>(loginButton).click();
  const row = '[data-testid=account-login-row][data-account-id=a-antigravity]';
  await waitFor(() => document.querySelector(row) !== null);
  const field = document.querySelector<HTMLInputElement>(`${row} [data-testid=account-login-input]`);
  expect(field).not.toBeNull();
  expect(field!.placeholder).toMatch(/localhost address/i);
  const send = vi.spyOn(store, 'sendLoginInput');
  try {
    const redirect = 'http://127.0.0.1:54321/oauth/callback?code=demo';
    await type(field!, redirect);
    query<HTMLButtonElement>(`${row} [data-testid=account-login-send]`).click();
    await waitFor(() => store.accountOf('a-antigravity')?.status === 'ok');
    expect(send).toHaveBeenCalledWith('a-antigravity', redirect);
  } finally {
    send.mockRestore();
  }
});
