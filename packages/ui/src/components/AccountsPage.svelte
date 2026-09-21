<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ChevronRight, Plus, RefreshCw, Terminal } from '@lucide/svelte';
  import type { Account, AccountQuota, ProviderSummary } from '@boite/contracts';
  import QuotaList from './QuotaList.svelte';
  import ProviderIcon from './ProviderLogo.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { bytes, percent } from '../lib/format';
  import { nextAccountLabel, setupStep, signInTarget, type SetupStep } from '../lib/provider-setup';
  import { strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';

  /**
   * One row per provider, one next step per row: install what is missing, sign
   * in when nothing is signed in, otherwise ready. Everything a second account,
   * a quota or an uninstall needs sits behind the row's chevron.
   */
  let { store }: { store: Store } = $props();

  /** One pending code per account, so two logins never share a field. */
  let codes = $state<Record<string, string>>({});
  let quotas = $state<AccountQuota[]>([]);
  let quotaBusy = $state(false);
  let open = $state<Record<string, boolean>>({});
  /** Providers whose install was asked for from a row: sign-in follows the download. */
  let chained = $state<Record<string, boolean>>({});
  let busy = $state<string | null>(null);
  let verified = $state<Record<string, number>>({});
  let checking = $state<string | null>(null);
  let detecting = $state(false);
  let lastDetect = 0;

  /** Agents Boite cannot download: their own installer is one click away. */
  const setupUrls: Record<string, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    codex: 'https://developers.openai.com/codex/cli',
    opencode: 'https://opencode.ai/docs/',
    grok: 'https://grok.com/build',
    muse: 'https://developer.meta.com/ai/products/muse-code/',
    pi: 'https://github.com/earendil-works/pi'
  };

  /** The fold's duration, nothing when the system or the app asks for less motion. */
  const fold = (): number =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced' ? 0 : 180;

  const loggingIn = (accountId: string): boolean => store.logins[accountId]?.state === 'running';

  function stepOf(provider: ProviderSummary): SetupStep {
    return setupStep(provider, store.installOf(provider.id), store.accountsOf(provider.id), loggingIn);
  }

  /** What the row says under the name. */
  function stateText(provider: ProviderSummary, step: SetupStep): string {
    const install = store.installOf(provider.id);
    if (step === 'installing' && install) {
      if (install.state === 'downloading') {
        const ratio = install.totalBytes > 0 ? Math.min(100, (install.receivedBytes / install.totalBytes) * 100) : 0;
        return strings.install.downloading.replace('{percent}', percent(ratio));
      }
      return install.state === 'verifying' ? strings.install.verifying : strings.install.extracting;
    }
    if (step === 'install' && install) {
      if (install.state === 'failed') return install.message;
      if (install.state === 'absent') return strings.install.absent.replace('{size}', bytes(install.archiveBytes));
    }
    if (step === 'ready') {
      const signedIn = store.accountsOf(provider.id).filter((account) => account.status === 'ok');
      const identity = signedIn.find((account) => account.identity)?.identity ?? null;
      if (signedIn.length > 1) {
        return `${strings.providerSettings.step.ready} · ${
          identity
            ? strings.providerSettings.readyMore.replace('{identity}', identity).replace('{count}', String(signedIn.length - 1))
            : strings.providerSettings.accountsCount.replace('{count}', String(signedIn.length))
        }`;
      }
      return identity ? `${strings.providerSettings.step.ready} · ${identity}` : strings.providerSettings.step.ready;
    }
    return strings.providerSettings.step[step];
  }

  function ratioOf(provider: ProviderSummary): number {
    const install = store.installOf(provider.id);
    if (install?.state !== 'downloading' || install.totalBytes <= 0) return 0;
    return Math.min(100, (install.receivedBytes / install.totalBytes) * 100);
  }

  function updatable(provider: ProviderSummary): boolean {
    const install = store.installOf(provider.id);
    return install?.state === 'installed' && install.available !== install.version;
  }

  /** The login a row shows: the running one first, else the last that failed. */
  function shownLogin(provider: ProviderSummary): Account | null {
    const accounts = store.accountsOf(provider.id);
    return accounts.find((account) => loggingIn(account.id)) ?? accounts.find((account) => store.logins[account.id]) ?? null;
  }

  async function signIn(provider: ProviderSummary, another = false) {
    if (busy !== null) return;
    busy = provider.id;
    try {
      const accounts = store.accountsOf(provider.id);
      const account = (another ? null : signInTarget(accounts))
        ?? await store.addAccount({ providerId: provider.id, label: nextAccountLabel(provider, accounts), useDefaultLocation: false });
      if (account) await store.loginAccount(account.id);
    } finally { busy = null; }
  }

  async function startInstall(provider: ProviderSummary, thenSignIn: boolean) {
    if (thenSignIn) chained = { ...chained, [provider.id]: true };
    if (!await store.installProvider(provider.id)) unchain(provider.id);
  }

  /** Recorded as installed, nothing resolves: the files go, then come back. */
  async function repair(provider: ProviderSummary) {
    await store.uninstallProvider(provider.id);
    if (store.installOf(provider.id)?.state === 'absent') await startInstall(provider, true);
  }

  function unchain(providerId: string) {
    const { [providerId]: _gone, ...rest } = chained;
    chained = rest;
  }

  async function cancelInstall(provider: ProviderSummary) {
    unchain(provider.id);
    await store.cancelInstall(provider.id);
  }

  async function uninstall(provider: ProviderSummary) {
    const ok = await confirm.ask({
      title: strings.install.removeTitle.replace('{provider}', provider.name),
      body: strings.install.removeBody,
      confirmLabel: strings.install.removeConfirm,
      cancelLabel: strings.install.removeCancel,
      danger: true
    });
    if (ok) await store.uninstallProvider(provider.id);
  }

  /** Something the user installed or signed into outside Boite: look again. */
  async function detect() {
    if (!store.client || detecting) return;
    detecting = true;
    lastDetect = Date.now();
    try { await store.reloadProviders(); }
    finally { detecting = false; }
  }

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

  /** The session file, then the agent itself: how many models it answers with. */
  async function verify(account: Account) {
    if (!store.client) return;
    checking = account.id;
    try {
      await store.checkAccount(account.id);
      if (store.providerOf(account.providerId)?.available) {
        const { models } = await store.client.call('providers.probe', { providerId: account.providerId, accountId: account.id });
        verified = { ...verified, [account.id]: models.length };
      }
    } catch (error) { store.error = String(error); }
    finally { checking = null; }
  }

  async function remove(account: Account) {
    const accepted = await confirm.ask({
      title: strings.accounts.removeTitle.replace('{account}', account.label),
      body: account.isolationDir === null ? strings.accounts.removeDefaultBody : strings.accounts.removeBody,
      confirmLabel: strings.accounts.remove,
      cancelLabel: strings.install.removeCancel,
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

  onMount(() => {
    void readQuotas();
    const offQuotas = store.client?.on('quotas.updated', (rows) => { quotas = rows; });
    // The download the row asked for is on disk. The core made the default
    // account before it said so, which means an existing command-line login already
    // reads as ready here and only a provider nobody is signed into goes on.
    const offProviders = store.client?.on('providers.updated', ({ loaded }) => {
      for (const provider of loaded) {
        if (!chained[provider.id] || !provider.available) continue;
        unchain(provider.id);
        if (stepOf(provider) === 'sign-in') void signIn(provider);
      }
    });
    const offInstall = store.client?.on('providers.installProgress', (event) => {
      if (event.state === 'failed' || event.state === 'absent') unchain(event.providerId);
    });
    // Coming back from an installer or a terminal is the moment to look again,
    // so nobody has to find a button for it.
    const onFocus = () => {
      if (Date.now() - lastDetect < 5000) return;
      const steps = store.providers.map((provider) => stepOf(provider));
      if (steps.includes('manual')) void detect();
      else if (steps.includes('external')) {
        lastDetect = Date.now();
        for (const provider of store.providers) {
          if (stepOf(provider) !== 'external') continue;
          for (const account of store.accountsOf(provider.id)) void store.checkAccount(account.id);
        }
      }
    };
    window.addEventListener('focus', onFocus);
    return () => { offQuotas?.(); offProviders?.(); offInstall?.(); window.removeEventListener('focus', onFocus); chained = {}; };
  });
</script>

<div class="page" data-testid="accounts-page">
  <header>
    <div>
      <h1>{strings.providerSettings.heading}</h1>
      <p>{strings.providerSettings.intro}</p>
    </div>
  </header>

  <div class="card flush list">
    {#each store.providers as provider (provider.id)}
      {@const step = stepOf(provider)}
      {@const install = store.installOf(provider.id)}
      {@const accounts = store.accountsOf(provider.id)}
      {@const loginAccount = shownLogin(provider)}
      {@const login = loginAccount ? store.logins[loginAccount.id] : undefined}
      <section
        class="provider"
        id="settings-provider-{provider.id}"
        data-testid="provider-settings"
        data-provider-id={provider.id}
        data-step={step}
        data-install={install?.state ?? 'none'}
      >
        <div class="line">
          <!-- The whole name side folds the row, the chevron only says which way. -->
          <button
            class="summary"
            class:open={open[provider.id]}
            aria-expanded={open[provider.id] === true}
            aria-label="{strings.providerSettings.details}: {provider.name}"
            data-testid="provider-details-toggle"
            onclick={() => (open = { ...open, [provider.id]: !open[provider.id] })}
          >
            <span class="chevron"><ChevronRight size={16} strokeWidth={2.25} /></span>
            <ProviderIcon providerId={provider.id} size={22} />
            <span class="who">
              <span class="name">{provider.name}</span>
              <span class="state" class:bad={install?.state === 'failed' && step === 'install'} data-testid="provider-state">
                <span class="dot" class:ok={step === 'ready'} class:live={step === 'installing' || step === 'signing-in'}></span>
                {stateText(provider, step)}
              </span>
            </span>
          </button>
          <div class="act">
            {#if step === 'install'}
              <button class="primary small" data-testid="install-start" disabled={busy !== null} onclick={() => void startInstall(provider, true)}>
                {install?.state === 'failed' ? strings.install.retry : strings.install.action}
              </button>
            {:else if step === 'repair'}
              <button class="primary small" data-testid="install-repair" onclick={() => void repair(provider)}>{strings.install.repair}</button>
            {:else if step === 'installing'}
              <button class="quiet small" data-testid="install-cancel" onclick={() => void cancelInstall(provider)}>{strings.install.cancel}</button>
            {:else if step === 'manual'}
              {#if setupUrls[provider.id]}
                <a class="button" href={setupUrls[provider.id]} target="_blank" rel="noreferrer" data-testid="provider-setup">{strings.providerSettings.setup}</a>
              {/if}
            {:else if step === 'sign-in'}
              <button class="primary small" data-testid="provider-sign-in" disabled={busy !== null} onclick={() => void signIn(provider)}>{strings.accounts.login}</button>
            {:else if step === 'ready' && updatable(provider)}
              <button class="quiet small" data-testid="install-update" onclick={() => void startInstall(provider, false)}>{strings.install.update}</button>
            {/if}
            {#if step === 'manual' || step === 'external'}
              <button class="quiet small" data-testid="providers-refresh" disabled={detecting} onclick={() => void detect()}>{strings.providerSettings.refresh}</button>
            {/if}
          </div>
        </div>

        {#if step === 'installing'}
          <div
            class="track"
            data-testid="install-progress"
            role="progressbar"
            aria-label={strings.install.progress}
            aria-valuenow={Math.round(ratioOf(provider))}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span class="bar" class:indeterminate={install?.state !== 'downloading'} style="width: {ratioOf(provider)}%"></span>
          </div>
          {#if chained[provider.id]}<p class="hint" role="status">{strings.providerSettings.thenSignIn}</p>{/if}
        {:else if step === 'manual'}
          <p class="hint">{strings.providerSettings.manualHint.replace('{provider}', provider.name)}</p>
        {:else if step === 'external'}
          <p class="hint">{strings.providerSettings.externalHint.replace('{provider}', provider.name)}</p>
        {/if}

        {#if loginAccount && login}
          <div class="login" data-testid="account-login-row" data-account-id={loginAccount.id}>
            {#if login.state === 'running'}
              {#if login.url}
                <a class="button primary" href={login.url} target="_blank" rel="noreferrer" data-testid="account-login-url">
                  {strings.accounts.loginOpen}
                </a>
                <p class="hint">{strings.accounts.loginHint}</p>
              {/if}
              <p class="output" data-testid="account-login-output">
                {login.output.length > 0 ? login.output : strings.accounts.loginStarting}
              </p>
              <form class="code" onsubmit={(event) => void sendCode(event, loginAccount.id)}>
                <input
                  data-testid="account-login-input"
                  placeholder={provider.login && provider.login.kind === 'acp'
                    ? strings.accounts.loginRedirectPlaceholder
                    : strings.accounts.loginInputPlaceholder}
                  value={codes[loginAccount.id] ?? ''}
                  oninput={(event) => (codes = { ...codes, [loginAccount.id]: event.currentTarget.value })}
                />
                <button type="submit" class="quiet small" data-testid="account-login-send">{strings.accounts.loginSend}</button>
                <button type="button" class="quiet small" data-testid="account-login-cancel" data-account-id={loginAccount.id} onclick={() => void store.cancelLogin(loginAccount.id)}>
                  {strings.accounts.loginCancel}
                </button>
              </form>
            {:else}
              <p class="output bad" data-testid="account-login-output">{login.output}</p>
            {/if}
          </div>
        {/if}

        {#if open[provider.id]}
          {@const quotaRows = quotas.filter((row) => row.providerId === provider.id && row.status !== 'unsupported')}
          <div class="details" data-testid="provider-details" transition:slide={{ duration: fold() }}>
            <div class="section-head">
              <span class="section-label">{strings.providerSettings.accounts}</span>
              {#if quotaRows.length > 0}
                <button class="quiet small" disabled={quotaBusy} onclick={() => void readQuotas(true)}><RefreshCw size={13} />{strings.quotas.refresh}</button>
              {/if}
            </div>
            {#if accounts.length === 0}<p class="hint">{strings.providerSettings.noAccounts}</p>{/if}
            {#each accounts as account (account.id)}
              {@const quota = quotaRows.find((row) => row.accountId === account.id)}
              <div class="account" data-testid="account-row" data-account-id={account.id}>
                <div class="account-line">
                  <div class="who">
                    <h3>{account.identity ?? account.label}</h3>
                    <p class="state">
                      <span class="kind">{account.isolationDir === null ? strings.providerSettings.default : strings.providerSettings.isolated}</span>
                      {#if account.identity && account.identity !== account.label}<span>· {account.label}</span>{/if}
                      {#if account.status !== 'ok'}
                        <span class:bad={account.status !== 'unknown'}>· {strings.accounts.status[account.status]}</span>
                      {/if}
                    </p>
                  </div>
                  <div class="act">
                    {#if provider.available && provider.login && account.isolationDir !== null && !loggingIn(account.id)}
                      <button class="quiet small" data-testid="account-login" data-account-id={account.id} onclick={() => void store.loginAccount(account.id)}>
                        {account.status === 'ok' ? strings.providerSettings.reconnect : strings.accounts.login}
                      </button>
                    {/if}
                    <button class="quiet small" disabled={checking !== null} data-testid="account-verify" onclick={() => void verify(account)}>{strings.providerSettings.check}</button>
                    <button class="quiet small" data-testid="account-remove" data-account-id={account.id} onclick={() => void remove(account)}>{strings.accounts.remove}</button>
                  </div>
                </div>
                {#if verified[account.id] !== undefined}<p class="hint" role="status">{strings.providerSettings.models.replace('{count}', String(verified[account.id]))}</p>{/if}
                {#if quota}
                  <div class="quota">
                    <label class="monitor"><span>{strings.quotas.monitor}</span><input type="checkbox" role="switch" data-testid="quota-monitor" checked={quota.enabled} onchange={(event) => void monitor(account.id, event.currentTarget.checked)} /></label>
                    <QuotaList rows={[quota]} bare />
                  </div>
                {/if}
              </div>
            {/each}

            {#if provider.available && (provider.login || (!provider.alwaysIsolated && !accounts.some((account) => account.isolationDir === null)))}
              <div class="more">
                {#if provider.login}
                  <button class="quiet small" data-testid="account-add" disabled={busy !== null} onclick={() => void signIn(provider, true)}><Plus size={14} />{strings.providerSettings.addAccount}</button>
                {/if}
                {#if !provider.alwaysIsolated && !accounts.some((account) => account.isolationDir === null)}
                  <button class="quiet small" data-testid="account-use-cli" onclick={() => void store.addAccount({ providerId: provider.id, label: nextAccountLabel(provider, accounts), useDefaultLocation: true })}>
                    <Terminal size={14} />{strings.providerSettings.useCli}
                  </button>
                {/if}
              </div>
            {/if}

            {#if install?.state === 'installed' || provider.executable}
              <div class="section-head"><span class="section-label">{strings.providerSettings.installation}</span></div>
              <dl class="facts">
                {#if install?.state === 'installed'}
                  <div class="fact">
                    <dt>{strings.providerSettings.version}</dt>
                    <dd class="managed">
                      <span data-testid="install-status">{updatable(provider)
                        ? strings.install.updateAvailable.replace('{installed}', install.version).replace('{available}', install.available)
                        : strings.install.upToDate.replace('{version}', install.version)}</span>
                      <button class="quiet small" data-testid="install-remove" onclick={() => void uninstall(provider)}>{strings.install.remove}</button>
                    </dd>
                  </div>
                {/if}
                {#if provider.executable}
                  <div class="fact">
                    <dt>{strings.providerSettings.executable}</dt>
                    <dd><code>{provider.executable}</code></dd>
                  </div>
                {/if}
              </dl>
            {/if}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>

  /* One card, one row per provider: the page reads top to bottom as a checklist. */
  .provider { padding: 12px 16px; display: grid; gap: 10px; }
  .provider + .provider { border-top: 1px solid var(--color-border); }

  .line, .account-line { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .who { flex: 1; min-width: 0; display: grid; gap: 2px; text-align: left; }
  .name { font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); }
  h3 { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--color-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* The name side is the fold's button: a large target, the chevron in front of it. */
  .summary {
    flex: 1;
    min-width: 0;
    height: auto;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    margin: -6px 0 -6px -8px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    box-shadow: none;
    font-weight: normal;
  }
  .summary:hover { background: var(--color-hover); }
  .summary:active:not(:disabled) { transform: none; }
  .chevron {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
    background: var(--color-surface-3);
  }
  .chevron :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); }
  .summary:hover .chevron, .summary.open .chevron { color: var(--color-foreground); }
  .summary.open .chevron :global(svg) { transform: rotate(90deg); }

  .state { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .bad { color: var(--color-danger); }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }

  /* Hue is for status only: green once an account is signed in, amber while Boite works. */
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.live { background: var(--color-live); }

  .act { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }

  /* A link that does a button's job: leaving for a sign-in page or an installer. */
  a.button {
    display: inline-flex;
    align-items: center;
    min-height: var(--control-sm);
    padding: 2px 10px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-foreground);
    text-decoration: none;
    transition: background var(--dur-2) var(--ease-out-quint);
  }
  a.button:hover { background: var(--color-hover); }
  a.button.primary { background: var(--color-foreground); border-color: transparent; color: var(--color-on-foreground); justify-self: start; }
  a.button.primary:hover { opacity: 0.9; }


  .track { height: 2px; border-radius: 999px; background: var(--color-surface-3); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--color-foreground); transition: width var(--dur-2) var(--ease-out-quint); }
  /* Checking and unpacking give no byte count, so the bar sits full and pale. */
  .bar.indeterminate { width: 100% !important; opacity: 0.4; }

  .login { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius-md); background: var(--color-surface-2); animation: rise var(--dur-3) var(--ease-out-quint); }
  .output { margin: 0; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .code { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .code input { flex: 1; min-width: 0; max-width: 360px; }

  /* Under the name, not under the chevron: the fold reads as belonging to the row. */
  .details { display: grid; gap: 10px; margin-left: 32px; padding: 4px 0 6px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; min-height: var(--control-sm); margin-top: 6px; }
  .account { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .kind { color: var(--color-muted-foreground); }
  .quota { display: grid; gap: 10px; padding-top: 10px; border-top: 1px solid var(--color-border); }
  .more { display: flex; gap: 6px; flex-wrap: wrap; }
  .facts { display: grid; gap: 6px; margin: 0; }
  .fact { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: baseline; font-size: var(--text-sm); }
  dt { color: var(--color-subtle); }
  dd { margin: 0; min-width: 0; color: var(--color-muted-foreground); }
  dd code { font-size: var(--text-xs); overflow-wrap: anywhere; }
  .managed { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

  .monitor { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: var(--text-sm); }

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

  .monitor input:checked { background: var(--color-foreground); }
  .monitor input:checked::after { transform: translateX(12px); }
  .monitor input:focus-visible { outline-offset: 3px; }

  /* Phones never reach this page. Beside the settings nav a small window leaves
     the row about 480 px, where the action drops under the name. */
  @media (max-width: 900px) {
    .line, .account-line { flex-wrap: wrap; }
    .line .act, .account-line .act { order: 3; flex-basis: 100%; justify-content: flex-start; padding-left: 64px; }
    .account-line .act { padding-left: 0; }
    .details { margin-left: 0; }
    .fact { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
