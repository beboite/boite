<script lang="ts">
  import { untrack } from 'svelte';
  import type { Account, ProviderSummary } from '@boite/contracts';
  import InstallControl from './InstallControl.svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from '../lib/menu';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  let adding = $state(false);
  let providerId = $state(untrack(() => store.providers[0]?.id ?? ''));
  let label = $state('');
  let useDefaultLocation = $state(false);
  /** One pending code per account, so two logins never share a field. */
  let codes = $state<Record<string, string>>({});

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!providerId || label.trim().length === 0) return;
    await store.addAccount({ providerId, label: label.trim(), useDefaultLocation });
    label = '';
    adding = false;
  }

  /** The providers whose files Boite downloads itself, install block and all. */
  let managed = $derived(store.providers.filter((p: ProviderSummary) => store.installOf(p.id) !== null));

  /** The provider column of the add form, drawn as a menu: the family has no native select. */
  let providerItems = $derived(
    store.providers.map(
      (provider: ProviderSummary): MenuItem => ({
        id: provider.id,
        label: provider.name,
        active: provider.id === providerId
      })
    )
  );
  let providerName = $derived(store.providerOf(providerId)?.name ?? strings.common.none);

  /**
   * The provider's own login is the user's to run; Boite only drives isolated
   * accounts. A provider whose files are not on the machine yet has nothing to
   * log in with either: that row offers the install instead.
   */
  function canLogIn(account: Account, provider: ProviderSummary | null): boolean {
    if (provider !== null && !provider.available) return false;
    return account.isolationDir !== null && account.status === 'unauthenticated' && !store.logins[account.id];
  }

  async function sendCode(event: SubmitEvent, accountId: string) {
    event.preventDefault();
    const text = codes[accountId] ?? '';
    if (text.trim().length === 0) return;
    codes = { ...codes, [accountId]: '' };
    await store.sendLoginInput(accountId, text);
  }
</script>

<div class="page" data-testid="accounts-page">
  <header>
    <h1>{strings.accounts.heading}</h1>
    <button class="quiet" onclick={() => (adding = !adding)}>{strings.accounts.add}</button>
  </header>

  {#if adding}
    <form class="card" onsubmit={submit}>
      <div class="field">
        <span>{strings.accounts.provider}</span>
        <Menu
          items={providerItems}
          onpick={(id) => (providerId = id)}
          placement="bottom"
          label={strings.accounts.provider}
          testid="account-provider"
        >
          {providerName}
        </Menu>
      </div>
      <label>
        <span>{strings.accounts.label}</span>
        <input bind:value={label} placeholder={strings.accounts.labelPlaceholder} />
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={useDefaultLocation} />
        {strings.accounts.useDefaultLocation}
      </label>
      <div class="actions">
        <button type="submit" class="primary" disabled={label.trim().length === 0}>
          {strings.accounts.create}
        </button>
        <button type="button" class="quiet" onclick={() => (adding = false)}>
          {strings.accounts.cancel}
        </button>
      </div>
    </form>
  {/if}

  {#if managed.length > 0}
    <section class="managed" data-testid="managed-providers">
      <h2>{strings.install.heading}</h2>
      {#each managed as provider (provider.id)}
        <div class="managed-row" data-testid="managed-provider" data-provider={provider.id}>
          <span class="name">{provider.name}</span>
          <InstallControl {store} {provider} removable />
        </div>
      {/each}
    </section>
  {/if}

  {#if store.accounts.length === 0}
    <p class="empty">{strings.accounts.empty}</p>
  {:else}
    <table class="card">
      <thead>
        <tr>
          <th>{strings.accounts.label}</th>
          <th>{strings.accounts.provider}</th>
          <th>{strings.accounts.identity}</th>
          <th>{strings.accounts.isolation}</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each store.accounts as account (account.id)}
          {@const login = store.logins[account.id]}
          {@const provider = store.providerOf(account.providerId)}
          <tr data-testid="account-row" data-account-id={account.id}>
            <td>{account.label}</td>
            <td class="mono">{store.providerOf(account.providerId)?.shortName ?? account.providerId}</td>
            <td class="mono">{account.identity ?? strings.common.none}</td>
            <td class="mono path" title={account.isolationDir ?? strings.accounts.defaultLocation}>
              {account.isolationDir ?? strings.accounts.defaultLocation}
            </td>
            <td>
              <span
                class="status"
                class:ok={account.status === 'ok'}
                class:bad={account.status === 'unauthenticated' || account.status === 'error'}
              >
                {strings.accounts.status[account.status]}
              </span>
            </td>
            <td class="row-actions">
              {#if provider && !provider.available && store.installOf(provider.id)}
                <InstallControl {store} {provider} />
              {/if}
              {#if canLogIn(account, provider)}
                <button
                  class="quiet"
                  data-testid="account-login"
                  data-account-id={account.id}
                  onclick={() => void store.loginAccount(account.id)}
                >
                  {strings.accounts.login}
                </button>
              {/if}
              <button class="quiet" onclick={() => void store.checkAccount(account.id)}>
                {strings.accounts.check}
              </button>
            </td>
          </tr>
          {#if login}
            <tr class="login" data-testid="account-login-row" data-account-id={account.id}>
              <td colspan="6">
                <div class="login-box">
                {#if login.url}
                  <a
                    class="link"
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="account-login-url"
                    title={strings.accounts.loginOpen}
                  >
                    {login.url}
                  </a>
                {/if}
                <p class="output" class:bad={login.state === 'failed'} data-testid="account-login-output">
                  {login.output.length > 0 ? login.output : strings.accounts.loginStarting}
                </p>
                {#if login.state === 'running'}
                  <form class="code" onsubmit={(event) => void sendCode(event, account.id)}>
                    <input
                      data-testid="account-login-input"
                      placeholder={strings.accounts.loginInputPlaceholder}
                      value={codes[account.id] ?? ''}
                      oninput={(event) =>
                        (codes = { ...codes, [account.id]: event.currentTarget.value })}
                    />
                    <button type="submit" class="quiet" data-testid="account-login-send">
                      {strings.accounts.loginSend}
                    </button>
                  </form>
                {/if}
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  /* The form appears on a press, so it rises rather than popping into place. */
  form {
    display: grid;
    gap: 6px;
    padding: 8px;
    margin-bottom: 10px;
    max-width: 420px;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  form input:not([type]) {
    width: 100%;
  }

  /* A label with a button inside is not a label, so the row is a div and the
     menu is stretched to the width the fields around it take. */
  .field {
    display: grid;
    gap: 2px;
  }

  .field :global(.menu) {
    display: flex;
  }

  .field :global(.menu > .trigger) {
    width: 100%;
    justify-content: flex-start;
  }

  .field :global(.menu > .popover) {
    min-width: 100%;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  table {
    background: var(--color-surface);
  }

  .managed {
    display: grid;
    gap: 6px;
    margin-bottom: 12px;
    padding: 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    max-width: 560px;
  }

  .managed h2 {
    margin: 0 0 2px;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-muted-foreground);
  }

  .managed-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 26px;
  }

  .managed-row .name {
    flex: none;
    font-weight: 500;
  }

  .path {
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-muted-foreground);
  }

  .status.ok {
    color: var(--color-success);
  }

  .status.bad {
    color: var(--color-danger);
  }

  .row-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  /* A row under the pointer fills, the way every other list here answers. */
  tbody tr:not(.login):hover td {
    background: var(--color-surface-2);
  }

  /* The cell stays a table cell so the colspan holds; the grid lives inside it. */
  tr.login td {
    background: var(--color-surface-2);
    border-left: 2px solid var(--color-live);
  }

  tr.login .login-box {
    display: grid;
    gap: 6px;
  }

  tr.login .link {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  tr.login .output {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    overflow-wrap: anywhere;
  }

  tr.login .output.bad {
    color: var(--color-danger);
  }

  tr.login .code {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  tr.login .code input {
    flex: 1;
    max-width: 360px;
  }
</style>
