<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ChevronRight } from '@lucide/svelte';
  import type { Account, AccountQuota, ProviderSummary } from '@boite/contracts';
  import QuotaList from './QuotaList.svelte';
  import ProviderIcon from './ProviderLogo.svelte';
  import InstallControl from './InstallControl.svelte';
  import Menu from './Menu.svelte';
  import { confirm } from '../lib/confirm.svelte';
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
  let quotas = $state<AccountQuota[]>([]);
  let quotaBusy = $state(false);
  let connectAfterCreate = $state(false);
  let submitting = $state(false);
  let verified = $state<Record<string, number>>({});
  let checking = $state<string | null>(null);
  async function readQuotas(refresh = false) {
    if (!store.client || quotaBusy) return;
    quotaBusy = true;
    try { quotas = await store.client.call('quotas.list', { refresh }); }
    catch (error) { store.error = String(error); }
    finally { quotaBusy = false; }
  }
  async function monitor(accountId: string, enabled: boolean) {
    if (!store.client) return;
    try { quotas = await store.client.call('quotas.configure', { accountId, enabled }); if (enabled) await readQuotas(); }
    catch (error) { store.error = String(error); }
  }
  async function verify(account: Account) {
    if (!store.client) return;
    checking = account.id;
    try {
      await store.checkAccount(account.id);
      const { models } = await store.client.call('providers.probe', { providerId: account.providerId, accountId: account.id });
      verified = { ...verified, [account.id]: models.length };
    } catch (error) { store.error = String(error); }
    finally { checking = null; }
  }
  function connect(provider: ProviderSummary) {
    providerId = provider.id; label = provider.name; useDefaultLocation = false;
    connectAfterCreate = true; adding = true;
  }
  onMount(() => {
    void readQuotas();
    const off = store.client?.on('quotas.updated', (rows) => { quotas = rows; });
    return () => off?.();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!providerId || label.trim().length === 0) return;
    if (submitting) return;
    submitting = true;
    const account = await store.addAccount({ providerId, label: label.trim(), useDefaultLocation: !alwaysIsolated && useDefaultLocation });
    submitting = false;
    if (!account) return;
    label = '';
    adding = false;
    if (connectAfterCreate && account.isolationDir !== null) await store.loginAccount(account.id);
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
  let alwaysIsolated = $derived(store.providerOf(providerId)?.alwaysIsolated ?? false);

  /**
   * The provider's own login is the user's to run; Boite only drives isolated
   * accounts. A provider whose files are not on the machine yet has nothing to
   * log in with either: that row offers the install instead.
   */
  function canLogIn(account: Account, provider: ProviderSummary | null): boolean {
    if (!provider?.available || !provider.login) return false;
    return account.isolationDir !== null && store.logins[account.id]?.state !== 'running';
  }

  async function remove(account: Account) {
    const accepted = await confirm.ask({
      title: strings.accounts.removeTitle.replace('{account}', account.label),
      body: account.isolationDir === null ? strings.accounts.removeDefaultBody : strings.accounts.removeBody,
      confirmLabel: strings.accounts.remove,
      cancelLabel: strings.accounts.cancel,
      danger: true
    });
    if (accepted) await store.removeAccount(account.id);
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
  <header class="head">
    <h1>{strings.providerSettings.heading}</h1>
    <button class="quiet" onclick={() => { connectAfterCreate = false; adding = !adding; }}>{strings.accounts.add}</button>
  </header>
  <p class="intro lead">{strings.providerSettings.intro}</p>

  <!-- Under the intro, where both of its buttons are: the heading's and a card's. -->
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
      {#if !alwaysIsolated}
        <label class="check">
          <input type="checkbox" bind:checked={useDefaultLocation} data-testid="account-default-location" />
          {strings.accounts.useDefaultLocation}
        </label>
      {/if}
      <div class="actions">
        <button type="submit" class="primary" disabled={submitting || label.trim().length === 0}>
          {strings.accounts.create}
        </button>
        <button type="button" class="quiet" onclick={() => (adding = false)}>
          {strings.accounts.cancel}
        </button>
      </div>
    </form>
  {/if}

  <div class="providers">
    {#each store.providers as provider (provider.id)}
      <section class="card provider" data-testid="provider-settings" data-provider-id={provider.id}>
        <div class="provider-title"><ProviderIcon providerId={provider.id} size={22} /><h2>{provider.name}</h2></div>
        <p class="intro state"><span class="dot" class:ok={provider.available}></span>{provider.available ? strings.providerSettings.available : strings.providerSettings.missing}</p>
        {#if provider.executable}
          <details>
            <summary><span class="caret"><ChevronRight size={12} strokeWidth={2} /></span>{strings.providerSettings.executable}</summary>
            <code>{provider.executable}</code>
          </details>
        {/if}
        <!-- A provider whose login Boite cannot drive has no button to grey out. -->
        {#if provider.login}
          <button
            class="small connect"
            disabled={!provider.available}
            title={provider.available ? undefined : strings.providerSettings.missing}
            onclick={() => connect(provider)}
          >
            {strings.providerSettings.connect}
          </button>
        {/if}
      </section>
    {/each}
  </div>

  {#if managed.length > 0}
    <section class="card managed" data-testid="managed-providers">
      <h2>{strings.install.heading}</h2>
      {#each managed as provider (provider.id)}
        <InstallControl {store} {provider} />
      {/each}
    </section>
  {/if}

  {#if store.accounts.length === 0}
    <p class="empty">{strings.accounts.empty}</p>
  {:else}
    <div class="account-list">
        {#each store.accounts as account (account.id)}
          {@const login = store.logins[account.id]}
          {@const provider = store.providerOf(account.providerId)}
          {@const quota = quotas.find((row) => row.accountId === account.id)}
          <section class="card account" data-testid="account-row" data-account-id={account.id}>
            <header><div class="provider-title"><ProviderIcon providerId={account.providerId} size={20} /><h2>{account.label}</h2></div>
              <span
                class="status"
                class:ok={account.status === 'ok'}
                class:bad={account.status === 'unauthenticated' || account.status === 'error'}
              >
                {strings.accounts.status[account.status]}
              </span>
            </header>
            <p class="intro">{provider?.name ?? account.providerId} · {account.isolationDir === null ? strings.providerSettings.default : strings.providerSettings.isolated}{account.identity ? ` · ${account.identity}` : ''}</p>
            <p class="intro">{account.isolationDir === null ? strings.providerSettings.defaultHint : strings.providerSettings.isolatedHint}</p>
            <div class="row-actions">
              {#if canLogIn(account, provider)}
                <button
                  class="quiet"
                  data-testid="account-login"
                  data-account-id={account.id}
                  onclick={() => void store.loginAccount(account.id)}
                >
                  {account.status === 'ok' ? strings.providerSettings.reconnect : strings.accounts.login}
                </button>
              {/if}
              <button class="quiet" onclick={() => void store.checkAccount(account.id)}>
                {strings.accounts.check}
              </button>
              <button class="quiet" disabled={!provider?.available || checking !== null} data-testid="account-verify" onclick={() => void verify(account)}>{strings.providerSettings.modelCheck}</button>
              <button class="quiet" data-testid="account-remove" data-account-id={account.id} onclick={() => void remove(account)}>
                {strings.accounts.remove}
              </button>
            </div>
            {#if verified[account.id] !== undefined}<p class="intro" role="status">{strings.providerSettings.models.replace('{count}', String(verified[account.id]))}</p>{/if}
            {#if quota && quota.status !== 'unsupported'}
              <label class="monitor"><span>{strings.quotas.monitor}</span><input type="checkbox" role="switch" data-testid="quota-monitor" checked={quota.enabled} onchange={(event) => void monitor(account.id, event.currentTarget.checked)} /></label>
              <QuotaList rows={[quota]} />
            {/if}
          {#if login}
            <div class="login" data-testid="account-login-row" data-account-id={account.id}>
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
                  <button type="button" class="quiet" data-testid="account-login-cancel" data-account-id={account.id} onclick={() => void store.cancelLogin(account.id)}>
                    {strings.accounts.loginCancel}
                  </button>
                  <form class="code" onsubmit={(event) => void sendCode(event, account.id)}>
                    <input
                      data-testid="account-login-input"
                      placeholder={provider?.login && provider.login.kind === 'acp'
                        ? strings.accounts.loginRedirectPlaceholder
                        : strings.accounts.loginInputPlaceholder}
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
            </div>
          {/if}
          </section>
        {/each}
    </div>
  {/if}
  <button class="quiet" disabled={quotaBusy} onclick={() => void readQuotas(true)}>{strings.quotas.refresh}</button>
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

  .intro { color: var(--color-muted-foreground); font-size: var(--text-sm); }

  /* Every block of the page stops on the cards' 720 px, the heading's action included. */
  .head { max-width: 720px; margin-bottom: 4px; }
  .head button { margin-left: auto; }
  .lead { max-width: 720px; margin-bottom: 16px; }

  .providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 10px; max-width: 720px; margin-bottom: 20px; }
  .provider { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .provider .connect { margin-top: auto; align-self: flex-start; }
  .provider-title { display: flex; gap: 10px; align-items: center; }
  .provider .provider-title h2, .account .provider-title h2 { margin: 0; font-size: var(--text-base); font-weight: 600; letter-spacing: normal; text-transform: none; color: var(--color-foreground); }
  .provider p { margin: 0; }

  /* Hue is for status: the dot says whether the executable is on this machine. */
  .state { display: flex; align-items: center; gap: 6px; }
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }

  details { font-size: var(--text-sm); }
  summary { display: inline-flex; align-items: center; gap: 4px; list-style: none; cursor: pointer; color: var(--color-muted-foreground); transition: color var(--dur-2) var(--ease-out-quint); }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--color-foreground); }
  .caret { display: inline-flex; color: var(--color-subtle); transition: transform var(--dur-2) var(--ease-out-quint); }
  details[open] .caret { transform: rotate(90deg); }
  details code { display: block; overflow-wrap: anywhere; margin-top: 6px; }
  .account-list { display: grid; gap: 12px; max-width: 720px; margin: 16px 0; }
  .account { margin: 0; }
  .account header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .monitor { display: flex; align-items: center; justify-content: space-between; margin: 14px 0; gap: 12px; }

  /* General's switch, so the one toggle of this page is not a bare checkbox. */
  .monitor input {
    flex: none;
    width: 28px;
    height: 16px;
    margin: 0;
    appearance: none;
    border-radius: 999px;
    background: var(--color-edge);
    position: relative;
    cursor: pointer;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .monitor input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-background);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .monitor input:checked {
    background: var(--color-foreground);
  }

  .monitor input:checked::after {
    transform: translateX(12px);
  }

  .monitor input:focus-visible {
    outline-offset: 3px;
  }

  /* One row per provider Boite downloads itself. */
  .managed {
    display: grid;
    gap: 2px;
  }


  .status {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
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
    flex-wrap: wrap;
  }

  .login {
    background: var(--color-surface-2);
    border-left: 2px solid var(--color-live);
    padding: 12px;
    margin-top: 12px;
  }

  .login .login-box {
    display: grid;
    gap: 6px;
  }

  .login .link {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .login .output {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    overflow-wrap: anywhere;
  }

  .login .output.bad {
    color: var(--color-danger);
  }

  .login .code {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .login .code input {
    flex: 1;
    max-width: 360px;
  }
</style>
