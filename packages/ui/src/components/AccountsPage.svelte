<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ChevronRight, Plus, RefreshCw, Terminal } from '@lucide/svelte';
  import { providerEnabled, type Account, type ProviderSummary } from '@boite/contracts';
  import ProviderVersion from './ProviderVersion.svelte';
  import ProviderIcon from './ProviderLogo.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import EffortSlider from './EffortSlider.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { bytes, percent } from '../lib/format';
  import { providerGroups, type ProviderRow } from '../lib/provider-family';
  import { connected, nextAccountLabel, setupStep, signInTarget, type SetupStep } from '../lib/provider-setup';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * One row per provider, one next step per row: install what is missing, sign
   * in when nothing is signed in, otherwise its installed version.
   * Connected providers come first; the rest wait below as the ways to
   * add one, and the ones turned off close the page, dimmed, with only their
   * switch to act on. Accounts, the default model and the uninstall sit behind
   * the row's chevron. A family (Antigravity and its CLI) is one row, each way
   * in its own block inside it with its own switch.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  /** One pending code per account, so two logins never share a field. */
  let codes = $state<Record<string, string>>({});
  let open = $state<Record<string, boolean>>({});
  /** Providers whose install was asked for from a row: sign-in follows the download. */
  let chained = $state<Record<string, boolean>>({});
  let busy = $state<string | null>(null);
  let verified = $state<Record<string, Account['status']>>({});
  let editing = $state<string | null>(null);
  let label = $state('');
  let saving = $state(false);
  let revealed = $state<Record<string, boolean>>({});
  let checking = $state<string | null>(null);
  let detecting = $state(false);
  /** The provider whose switch is waiting for the core's answer. */
  let switching = $state<string | null>(null);
  let lastDetect = 0;

  let groups = $derived(providerGroups(store.providers, store.shownAccounts()));
  /** With nothing connected yet, the ways in are the page's main actions. */
  let firstRun = $derived(groups.connected.length === 0);

  /** Agents Boite cannot download: their own installer is one click away. */
  const setupUrls: Record<string, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    codex: 'https://developers.openai.com/codex/cli',
    opencode: 'https://opencode.ai/docs/',
    'opencode-v2': 'https://opencode.ai/v2/docs/',
    grok: 'https://grok.com/build',
    muse: 'https://developer.meta.com/ai/products/muse-code/',
    pi: 'https://github.com/earendil-works/pi'
  };

  /** The fold's duration, nothing when the system or the app asks for less motion. */
  const fold = (): number =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced' ? 0 : 180;

  const loggingIn = (accountId: string): boolean =>
    store.logins[accountId]?.state === 'running' || store.loginTerminals.includes(accountId);

  /** xterm and its shell, loaded the first time a sign-in needs a terminal. */
  const terminalView = () => import('./TerminalView.svelte');

  /** A CLI that signs in through its own menu gets a real terminal with the command typed in. */
  const inTerminal = (provider: ProviderSummary): boolean => provider.login !== false && provider.login.kind === 'terminal';

  /** The row's sign-in, or an account's own button. */
  async function startLogin(provider: ProviderSummary, account: Account) {
    if (inTerminal(provider)) store.showLoginTerminal(account.id);
    else await store.loginAccount(account.id);
  }

  function stepOf(provider: ProviderSummary): SetupStep {
    return setupStep(provider, store.installOf(provider.id), store.accountsOf(provider.id), loggingIn);
  }

  /** The member a row speaks for: one signed in, else one turned on with a step Boite can take, else the first turned on, else the head. */
  function leadOf(row: ProviderRow): ProviderSummary {
    const on = row.members.filter((member) => providerEnabled(member));
    return row.members.find((member) => connected(member, store.accountsOf(member.id)))
      ?? on.find((member) => stepOf(member) !== 'manual')
      ?? on[0]
      ?? row.members[0]!;
  }

  /**
   * The switch saves when it flips, as every other switch in Settings does. A
   * refusal puts it back where the core still has it.
   */
  async function setEnabled(provider: ProviderSummary, input: HTMLInputElement) {
    if (switching !== null) { input.checked = providerEnabled(provider); return; }
    switching = provider.id;
    try {
      if (!providerEnabled(provider) === input.checked) await store.setProviderEnabled(provider.id, input.checked);
    } finally {
      switching = null;
      input.checked = store.providerOn(provider.id);
    }
  }

  /** Whether the chevron has anything to open: a row with nothing behind it draws none. */
  function hasDetails(row: ProviderRow): boolean {
    if (row.members.length > 1) return true;
    const provider = row.members[0]!;
    return store.accountsOf(provider.id).length > 0
      || store.installOf(provider.id)?.state === 'installed'
      || provider.executable !== null
      || (provider.available && (provider.login !== false || !provider.alwaysIsolated));
  }

  /** What the row says under the name: state, never advice. */
  function stateText(provider: ProviderSummary, step: SetupStep): string {
    if (!providerEnabled(provider)) return strings.providerSettings.off;
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
      const gateway = store.gatewayOf(provider.id);
      if (gateway) return `${strings.providerSettings.step.ready} · ${fill(strings.subscriptionProxy.via, { name: gateway.name })}`;
      const signedIn = store.accountsOf(provider.id).filter((account) => account.status === 'ok');
      return signedIn.length > 1
        ? `${strings.providerSettings.step.ready} · ${strings.providerSettings.accountsCount.replace('{count}', String(signedIn.length))}`
        : strings.providerSettings.step.ready;
    }
    return strings.providerSettings.step[step];
  }

  function ratioOf(provider: ProviderSummary): number {
    const install = store.installOf(provider.id);
    if (install?.state !== 'downloading' || install.totalBytes <= 0) return 0;
    return Math.min(100, (install.receivedBytes / install.totalBytes) * 100);
  }

  /** The login a row shows: the running one first, else the last that failed. */
  function shownLogin(provider: ProviderSummary): Account | null {
    const accounts = store.accountsOf(provider.id);
    return accounts.find((account) => loggingIn(account.id)) ?? accounts.find((account) => store.logins[account.id]) ?? null;
  }

  /** The account a provider's default model is kept under: the first signed in. */
  function modelAccount(provider: ProviderSummary): Account | null {
    if (provider.id === 'echo') return null;
    const accounts = store.accountsOf(provider.id);
    if (!connected(provider, accounts)) return null;
    return accounts.find((account) => account.status === 'ok') ?? null;
  }

  async function signIn(provider: ProviderSummary, another = false) {
    if (busy !== null) return;
    busy = provider.id;
    try {
      const accounts = store.accountsOf(provider.id);
      // In a terminal the user's own CLI signs in, the way they would have typed it.
      const own = inTerminal(provider) ? accounts.find((account) => account.isolationDir === null && account.status !== 'ok') : undefined;
      const account = (another ? null : own ?? signInTarget(accounts))
        ?? await store.addAccount({ providerId: provider.id, label: nextAccountLabel(provider, accounts), useDefaultLocation: false });
      if (account) await startLogin(provider, account);
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

  async function verify(account: Account) {
    if (!store.client || checking !== null) return;
    checking = account.id;
    delete verified[account.id];
    try {
      const checked = await store.checkAccount(account.id, true);
      if (checked) verified = { ...verified, [account.id]: checked.status };
    } finally { checking = null; }
  }

  async function rename(event: SubmitEvent, accountId: string) {
    event.preventDefault();
    if (saving || !label.trim()) return;
    saving = true;
    try { if (await store.renameAccount(accountId, label)) editing = null; }
    finally { saving = false; }
  }

  async function remove(account: Account) {
    // Asked before the dialog: archived conversations count too and are not in this client's lists.
    const count = await store.accountThreads(account.id);
    if (count === null) return;
    const body = account.isolationDir === null ? strings.accounts.removeDefaultBody : strings.accounts.removeBody;
    const warning = count === 0 ? '' : (count === 1 ? strings.accounts.removeThread : strings.accounts.removeThreads).replace('{count}', String(count));
    const accepted = await confirm.ask({
      title: strings.accounts.removeTitle.replace('{account}', account.label),
      body: warning ? `${warning} ${body}` : body,
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
      // A provider turned off is never looked for: nothing of it is started.
      const steps = store.offeredProviders.map((provider) => stepOf(provider));
      if (steps.includes('manual')) void detect();
      else if (steps.includes('external')) {
        lastDetect = Date.now();
        for (const provider of store.offeredProviders) {
          if (stepOf(provider) !== 'external') continue;
          for (const account of store.accountsOf(provider.id)) void store.checkAccount(account.id);
        }
      }
    };
    window.addEventListener('focus', onFocus);
    return () => { offProviders?.(); offInstall?.(); window.removeEventListener('focus', onFocus); chained = {}; };
  });
</script>

<!-- On or off. Owner only in the core, and only the owner reaches this page. -->
{#snippet enabledSwitch(provider: ProviderSummary)}
  <input
    type="checkbox"
    role="switch"
    class="enabled-switch"
    aria-label={fill(strings.providerSettings.enable, { provider: provider.name })}
    title={fill(strings.providerSettings.enable, { provider: provider.name })}
    data-testid="provider-enabled"
    data-provider-id={provider.id}
    checked={providerEnabled(provider)}
    disabled={!store.owner || switching !== null}
    onchange={(event) => void setEnabled(provider, event.currentTarget)}
  />
{/snippet}

{#snippet experimentalBadge(provider: ProviderSummary)}
  {#if provider.experimental}
    <span class="badge ui-label-box" data-testid="provider-experimental"><span class="ui-label">{strings.providerSettings.experimental}</span></span>
  {/if}
{/snippet}

<!-- The one next step: install, repair, cancel, the installer's guide or the sign-in. -->
{#snippet stepAction(provider: ProviderSummary, step: SetupStep, main: boolean)}
  {@const install = store.installOf(provider.id)}
  {#if step === 'install'}
    <button class="small" class:primary={main} data-testid="install-start" disabled={busy !== null} onclick={() => void startInstall(provider, true)}>
      <span class="ui-label">{install?.state === 'failed' ? strings.install.retry : strings.install.action}</span>
    </button>
  {:else if step === 'repair'}
    <button class="small" class:primary={main} data-testid="install-repair" onclick={() => void repair(provider)}><span class="ui-label">{strings.install.repair}</span></button>
  {:else if step === 'installing'}
    <button class="quiet small" data-testid="install-cancel" onclick={() => void cancelInstall(provider)}><span class="ui-label">{strings.install.cancel}</span></button>
    {#if chained[provider.id]}<InfoTip topic={strings.providerSettings.step.installing} text={strings.providerSettings.thenSignIn} />{/if}
  {:else if step === 'manual'}
    {#if setupUrls[provider.id]}
      <a class="button" href={setupUrls[provider.id]} target="_blank" rel="noreferrer" data-testid="provider-setup"><span class="ui-label">{strings.providerSettings.setup}</span></a>
    {/if}
  {:else if step === 'sign-in'}
    <button class="small" class:primary={main} data-testid="provider-sign-in" disabled={busy !== null} onclick={() => void signIn(provider)}><span class="ui-label">{strings.accounts.login}</span></button>
  {/if}
  {#if step === 'manual' || step === 'external'}
    <button class="quiet small" data-testid="providers-refresh" disabled={detecting} onclick={() => void detect()}><span class="ui-label">{strings.providerSettings.refresh}</span></button>
    <InfoTip
      topic={provider.name}
      text={(step === 'manual' ? strings.providerSettings.manualHint : strings.providerSettings.externalHint).replace('{provider}', provider.name)}
    />
  {/if}
{/snippet}

{#snippet progress(provider: ProviderSummary, step: SetupStep)}
  {#if step === 'installing'}
    {@const install = store.installOf(provider.id)}
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
  {/if}
{/snippet}

<!-- A sign-in in progress stays on the row whether its details are open or not. -->
{#snippet logins(provider: ProviderSummary)}
  {@const accounts = store.accountsOf(provider.id)}
  {@const loginAccount = shownLogin(provider)}
  {@const login = loginAccount ? store.logins[loginAccount.id] : undefined}
  {#each accounts.filter((account) => store.loginTerminals.includes(account.id)) as account (account.id)}
    <div class="login" data-testid="account-login-terminal" data-account-id={account.id}>
      <div class="screen">
        {#await terminalView() then { default: TerminalView }}
          <TerminalView
            {store}
            id="login:{account.id}"
            start={(cols, rows) => store.loginTerminal(account.id, cols, rows)}
            onexit={() => store.hideLoginTerminal(account.id)}
            autofocus
          />
        {/await}
      </div>
      <div class="code">
        <button type="button" class="quiet small" data-testid="account-login-terminal-close" onclick={() => void store.closeTerminal(`login:${account.id}`)}>
          <span class="ui-label">{strings.accounts.terminalDone}</span>
        </button>
        <InfoTip topic={strings.accounts.terminalDone} text={strings.accounts.terminalHint} />
      </div>
    </div>
  {/each}

  {#if loginAccount && login}
    <div class="login" data-testid="account-login-row" data-account-id={loginAccount.id}>
      {#if login.state === 'running'}
        {#if login.url}
          <div class="code">
            <a class="button primary" href={login.url} target="_blank" rel="noreferrer" data-testid="account-login-url">
              <span class="ui-label">{strings.accounts.loginOpen}</span>
            </a>
            <InfoTip topic={strings.accounts.loginOpen} text={strings.accounts.loginHint} />
          </div>
        {/if}
        <p class="output" data-testid="account-login-output">
          {login.output.length > 0 ? login.output : strings.accounts.loginStarting}
        </p>
        <form class="code" onsubmit={(event) => void sendCode(event, loginAccount.id)}>
          {#if provider.login && provider.login.kind !== 'device'}
          <input
            data-testid="account-login-input"
            placeholder={provider.login && provider.login.kind === 'acp'
              ? strings.accounts.loginRedirectPlaceholder
              : strings.accounts.loginInputPlaceholder}
            value={codes[loginAccount.id] ?? ''}
            oninput={(event) => (codes = { ...codes, [loginAccount.id]: event.currentTarget.value })}
          />
          <button type="submit" class="quiet small" data-testid="account-login-send"><span class="ui-label">{strings.accounts.loginSend}</span></button>
          {/if}
          {#if provider.login && provider.login.kind === 'device'}<span class="hint"><span class="ui-label">{strings.providerSettings.deviceHint}</span></span>{/if}
          <button type="button" class="quiet small" data-testid="account-login-cancel" data-account-id={loginAccount.id} onclick={() => void store.cancelLogin(loginAccount.id)}>
            <span class="ui-label">{strings.accounts.loginCancel}</span>
          </button>
        </form>
      {:else}
        <p class="output bad" data-testid="account-login-output">{login.output}</p>
        <button type="button" class="quiet small" data-testid="account-login-dismiss" onclick={() => store.dismissLogin(loginAccount.id)}><span class="ui-label">{strings.common.close}</span></button>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- Everything behind the chevron for one descriptor: its accounts, the model
     new threads start on, and where the agent runs from. Limits live on the
     Limits page, not here. -->
{#snippet memberBody(provider: ProviderSummary)}
  {@const accounts = store.accountsOf(provider.id)}
  {@const gateway = store.gatewayOf(provider.id)}
  {@const install = store.installOf(provider.id)}
  {@const account = modelAccount(provider)}
  {@const on = providerEnabled(provider)}
  {#if accounts.length > 0 || gateway}
    <div class="section-head">
      <span class="section-label"><span class="ui-label">{strings.providerSettings.accounts}</span></span>
    </div>
  {/if}
  {#if gateway}
    <!-- The gateway's sign-ins live on its own machine: nothing here to rename, check or remove. -->
    <div class="account" data-testid="account-gateway" data-provider={provider.id}>
      <div class="account-line">
        <div class="who">
          <h3>{gateway.name}</h3>
          <p class="state"><span class="ui-label">{fill(strings.subscriptionProxy.account, { name: gateway.name, origin: gateway.origin })}</span></p>
        </div>
      </div>
    </div>
  {/if}
  {#each gateway ? [] : accounts as entry (entry.id)}
    <div class="account" data-testid="account-row" data-account-id={entry.id}>
      <div class="account-line">
        <div class="who">
          {#if editing === entry.id}
            <form class="code rename" onsubmit={event => void rename(event, entry.id)}>
              <input aria-label={strings.providerSettings.accountName} data-testid="account-name" maxlength="100" bind:value={label} />
              <button class="small" type="submit" disabled={saving || !label.trim()}><span class="ui-label">{strings.providerSettings.save}</span></button>
              <button class="quiet small" type="button" disabled={saving} onclick={() => editing = null}><span class="ui-label">{strings.install.removeCancel}</span></button>
            </form>
          {:else}<h3>{entry.label}</h3>{/if}
          {#if entry.identity}<p class="identity"><button type="button" class="private-email" class:revealed={revealed[entry.id]} aria-label={strings.providerSettings.revealEmail} aria-pressed={revealed[entry.id] === true} data-testid="account-email" onclick={() => revealed[entry.id] = !revealed[entry.id]}><span class="ui-label">{entry.identity}</span></button></p>{/if}
          <p class="state">
            <span class="kind ui-label">{entry.isolationDir === null ? strings.providerSettings.default : strings.providerSettings.isolated}</span>
            {#if entry.status !== 'ok'}
              <span class="ui-label" class:bad={entry.status !== 'unknown'}>· {strings.accounts.status[entry.status]}</span>
            {/if}
          </p>
        </div>
        <div class="act">
          {#if on && provider.available && provider.login && (entry.isolationDir !== null || inTerminal(provider)) && !loggingIn(entry.id)}
            <button class="quiet small" data-testid="account-login" data-account-id={entry.id} onclick={() => void startLogin(provider, entry)}>
              <span class="ui-label">{entry.status === 'ok' ? strings.providerSettings.reconnect : strings.accounts.login}</span>
            </button>
          {/if}
          <button class="quiet small" data-testid="account-rename" onclick={() => { editing = entry.id; label = entry.label; }}><span class="ui-label">{strings.providerSettings.rename}</span></button>
          <button class="quiet small" disabled={!on || checking !== null || loggingIn(entry.id)} data-testid="account-verify" onclick={() => void verify(entry)}><span class="ui-label">{checking === entry.id ? strings.providerSettings.checking : strings.providerSettings.check}</span></button>
          <button class="quiet small" data-testid="account-remove" data-account-id={entry.id} onclick={() => void remove(entry)}><span class="ui-label">{strings.accounts.remove}</span></button>
        </div>
      </div>
      {#if verified[entry.id] !== undefined}<p class="hint" role="status">{entry.status === 'ok' ? strings.providerSettings.connectionOk : strings.accounts.status[entry.status]}</p>{/if}
    </div>
  {/each}

  {#if on && !gateway && provider.available && (provider.login || (!provider.alwaysIsolated && !accounts.some((entry) => entry.isolationDir === null)))}
    <div class="more">
      {#if provider.login}
        <button class="quiet small" data-testid="account-add" disabled={busy !== null} onclick={() => void signIn(provider, true)}><Plus size={14} /><span class="ui-label">{strings.providerSettings.addAccount}</span></button>
      {/if}
      {#if !provider.alwaysIsolated && !accounts.some((entry) => entry.isolationDir === null)}
        <button class="quiet small" data-testid="account-use-cli" onclick={() => void store.addAccount({ providerId: provider.id, label: nextAccountLabel(provider, accounts), useDefaultLocation: true })}>
          <Terminal size={14} /><span class="ui-label">{strings.providerSettings.useCli}</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if account}
    {@const model = store.defaultModelOf(provider, account.id)}
    {@const info = store.modelsOf(provider.id, account.id).find((entry) => entry.id === model)}
    {@const effort = store.defaultEffortOf(provider.id, account.id, model)}
    <div class="section-head">
      <span class="section-label"><span class="ui-label">{strings.providerSettings.defaultModel}</span><InfoTip topic={strings.providerSettings.defaultModel} text={strings.settings.modelDefaultsHint} /></span>
    </div>
    <div class="default-model" data-testid="model-default" data-default-provider={provider.id}>
      <ModelPicker
        {store}
        choice={{ providerId: provider.id, accountId: account.id, model, effort, permissionMode: 'default' }}
        locked
        single
        onpick={(patch) => {
          // A model belongs to its provider: a default is only ever one of this row's own.
          if (!patch.model || (patch.providerId !== undefined && patch.providerId !== provider.id)) return;
          store.setModelDefault(provider.id, account.id, patch.model, store.defaultEffortOf(provider.id, account.id, patch.model));
        }}
      />
      {#if info?.effort?.levels.length}
        <EffortSlider levels={info.effort.levels} active={effort} onpick={(level) => model && store.setModelDefault(provider.id, account.id, model, level)} />
      {:else if effort}
        <span class="pending-effort ui-label-box"><span class="ui-label">{effort}</span></span>
      {/if}
    </div>
  {/if}

  {#if install?.state === 'installed' || provider.executable}
    <div class="section-head"><span class="section-label"><span class="ui-label">{strings.providerSettings.installation}</span></span></div>
    <dl class="facts">
      {#if install?.state === 'installed'}
        <div class="fact">
          <dt>{strings.providerSettings.version}</dt>
          <dd class="managed">
            <span class="ui-label" data-testid="install-status">{strings.install.upToDate.replace('{version}', install.version)}</span>
            <button class="quiet small" data-testid="install-remove" onclick={() => void uninstall(provider)}><span class="ui-label">{strings.install.remove}</span></button>
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
{/snippet}

{#snippet providerRow(row: ProviderRow, secondary: boolean)}
  {@const lead = leadOf(row)}
  {@const step = stepOf(lead)}
  {@const install = store.installOf(lead.id)}
  {@const main = !secondary || firstRun}
  {@const foldable = hasDetails(row)}
  {@const off = !providerEnabled(lead)}
  {@const alone = row.members.length === 1}
  <section
    class="provider"
    class:secondary
    class:off
    data-enabled={off ? 'false' : 'true'}
    id="settings-provider-{row.id}"
    data-testid="provider-settings"
    data-provider-id={row.id}
    data-step={step}
    data-install={install?.state ?? 'none'}
  >
    <div class="line">
      {#if foldable}
        <!-- The whole name side folds the row, the chevron only says which way. -->
        <button
          class="summary"
          class:open={open[row.id]}
          aria-expanded={open[row.id] === true}
          aria-label="{strings.providerSettings.details}: {row.name}"
          data-testid="provider-details-toggle"
          onclick={() => (open = { ...open, [row.id]: !open[row.id] })}
        >
          <span class="chevron"><ChevronRight size={16} strokeWidth={2.25} /></span>
          <ProviderIcon providerId={row.id} size={secondary ? 18 : 22} />
          <span class="who">
            <span class="name">{row.name}{#if alone}{@render experimentalBadge(lead)}{/if}</span>
            <span class="state" class:bad={!off && install?.state === 'failed' && step === 'install'} data-testid="provider-state">
              <span class="dot" class:ok={!off && step === 'ready'} class:live={!off && (step === 'installing' || step === 'signing-in')}></span>
              <span class="ui-label">{stateText(lead, step)}</span>
            </span>
          </span>
        </button>
      {:else}
        <div class="summary still">
          <span class="chevron blank"></span>
          <ProviderIcon providerId={row.id} size={secondary ? 18 : 22} />
          <span class="who">
            <span class="name">{row.name}{#if alone}{@render experimentalBadge(lead)}{/if}</span>
            <span class="state" class:bad={!off && install?.state === 'failed' && step === 'install'} data-testid="provider-state">
              <span class="dot" class:ok={!off && step === 'ready'} class:live={!off && (step === 'installing' || step === 'signing-in')}></span>
              <span class="ui-label">{stateText(lead, step)}</span>
            </span>
          </span>
        </div>
      {/if}
      <div class="act">
        <!-- A provider still to add shows its one way in; its version waits until it is connected. -->
        <!-- Off, nothing of it is offered: no version, no install, no sign-in, only the way back on. -->
        {#if !off}
          {#if !secondary}<ProviderVersion {store} provider={lead} main={main && step === 'ready'} installing={step === 'installing'} oninstall={() => void startInstall(lead, false)} />{/if}
          {@render stepAction(lead, step, main)}
        {/if}
        <!-- A family's switches are its members', inside the opened row. -->
        {#if alone}{@render enabledSwitch(lead)}{/if}
      </div>
    </div>
    {#if !off}{@render progress(lead, step)}{/if}
    {#each row.members as member (member.id)}{@render logins(member)}{/each}

    {#if open[row.id] && foldable}
      <div class="details" data-testid="provider-details" transition:slide={{ duration: fold() }}>
        {#if row.members.length > 1}
          <!-- The way in that works first, then the others. -->
          {#each [lead, ...row.members.filter((entry) => entry.id !== lead.id)] as member (member.id)}
            {@const memberStep = stepOf(member)}
            {@const memberOff = !providerEnabled(member)}
            <div class="member" class:off={memberOff} data-testid="provider-member" data-provider-id={member.id} data-step={memberStep} data-enabled={memberOff ? 'false' : 'true'}>
              <div class="member-line">
                <ProviderIcon providerId={member.id} size={16} />
                <span class="who">
                  <span class="member-name">{member.name}{@render experimentalBadge(member)}</span>
                  <span class="state" data-testid="provider-state">
                    <span class="dot" class:ok={!memberOff && memberStep === 'ready'} class:live={!memberOff && (memberStep === 'installing' || memberStep === 'signing-in')}></span>
                    <span class="ui-label">{stateText(member, memberStep)}</span>
                  </span>
                </span>
                <div class="act">
                  {#if member.id !== lead.id && !memberOff}
                    <ProviderVersion {store} provider={member} installing={memberStep === 'installing'} oninstall={() => void startInstall(member, false)} />
                    {@render stepAction(member, memberStep, false)}
                  {/if}
                  {@render enabledSwitch(member)}
                </div>
              </div>
              {#if member.id !== lead.id && !memberOff}
                {@render progress(member, memberStep)}
              {/if}
              {@render memberBody(member)}
            </div>
          {/each}
        {:else}
          {@render memberBody(lead)}
        {/if}
      </div>
    {/if}
  </section>
{/snippet}

<div class="page" data-testid="accounts-page">
  <header>
    <div>
      <h1 class="ui-label-box"><span class="ui-label">{strings.providerSettings.heading}</span><InfoTip topic={strings.providerSettings.heading} text={strings.providerSettings.intro} /></h1>
    </div>
  </header>

  {#if groups.connected.length > 0}
    <div class="card flush list" data-testid="providers-connected">
      {#each groups.connected as row (row.id)}{@render providerRow(row, false)}{/each}
    </div>
  {/if}

  {#if groups.rest.length > 0}
    {#if groups.connected.length > 0}
      <div class="group-heading"><h2>{strings.providerSettings.addHeading}</h2></div>
    {/if}
    <div class="card flush list" class:secondary-list={groups.connected.length > 0} data-testid="providers-add">
      {#each groups.rest as row (row.id)}{@render providerRow(row, groups.connected.length > 0)}{/each}
    </div>
  {/if}

  {#if groups.off.length > 0}
    <div class="group-heading">
      <h2 class="ui-label-box"><span class="ui-label">{strings.providerSettings.offHeading}</span><InfoTip topic={strings.providerSettings.offHeading} text={strings.providerSettings.enableHint} /></h2>
    </div>
    <div class="card flush list secondary-list" data-testid="providers-off">
      {#each groups.off as row (row.id)}{@render providerRow(row, true)}{/each}
    </div>
  {/if}
  {#if store.owner}<SubscriptionProxySettings {store} />{/if}
</div>

<style>
  .private-email { display: inline-block; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; filter: blur(5px); cursor: pointer; transition: filter var(--dur-2); overflow-wrap: anywhere; }
  .private-email:hover, .private-email:focus-visible, .private-email.revealed { filter: none; }
  .identity { margin: 4px 0; color: var(--color-muted-foreground); }
  .rename { flex-wrap: wrap; }


  /* One card, one row per provider: the page reads top to bottom as a checklist. */
  .provider { padding: 12px 16px; display: grid; gap: 10px; }
  .provider + .provider { border-top: 1px solid var(--color-border); }

  /* Providers still to add: lower, smaller, quieter, so the connected list leads. */
  .provider.secondary { padding: 8px 16px; gap: 8px; }
  .secondary .name { font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); }
  .secondary .summary:hover .name { color: var(--color-foreground); }
  .secondary-list { background: transparent; }

  /* Turned off: still listed, read as set aside. The switch keeps its full weight, it is the way back. */
  .provider.off .summary, .member.off .member-line > :not(.act), .member.off .account { opacity: 0.55; }
  .name, .member-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .badge { padding: 1px 7px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; white-space: nowrap; }

  .line, .account-line, .member-line { display: flex; align-items: center; gap: 12px; min-width: 0; }
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
  button.summary:hover { background: var(--color-hover); }
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
  /* A row with nothing to open keeps the column, not the control. */
  .chevron.blank { background: transparent; }
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
  /* The terminal's own height: a menu of a dozen lines fits without a scroll. */
  .screen { height: 280px; min-width: 0; border-radius: var(--radius-sm); overflow: hidden; }
  .output { margin: 0; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .code { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .code input { flex: 1; min-width: 0; max-width: 360px; }

  /* Under the name, not under the chevron: the fold reads as belonging to the row. */
  .details { display: grid; gap: 10px; margin-left: 32px; padding: 4px 0 6px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; min-height: var(--control-sm); margin-top: 6px; }
  .section-label { display: inline-flex; align-items: center; gap: 2px; }
  .account { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .kind { color: var(--color-muted-foreground); }
  .more { display: flex; gap: 6px; flex-wrap: wrap; }
  .facts { display: grid; gap: 6px; margin: 0; }
  .fact { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: baseline; font-size: var(--text-sm); }
  dt { color: var(--color-subtle); }
  dd { margin: 0; min-width: 0; color: var(--color-muted-foreground); }
  dd code { font-size: var(--text-xs); overflow-wrap: anywhere; }
  .managed { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

  /* One block per way in to a family: its name and state, then what it holds. */
  .member { display: grid; gap: 10px; padding-bottom: 12px; }
  .member + .member { padding-top: 14px; border-top: 1px solid var(--color-border); }
  .member-line { gap: 10px; }
  .member-name { font-size: var(--text-sm); font-weight: 600; color: var(--color-foreground); }

  /* The composer's own picker and effort chip, locked to the provider of this row. */
  .default-model { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pending-effort { color: var(--color-muted-foreground); font-size: var(--text-sm); text-transform: capitalize; padding: 2px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); }

  header { flex-wrap: wrap; }

  /* Phones never reach this page. Beside the settings nav a small window leaves
     the row about 480 px, where the action drops under the name. */
  @media (max-width: 900px) {
    .line, .account-line, .member-line { flex-wrap: wrap; }
    /* A version alone stays beside the name; a version and its button take the next line, at the right. */
    .line .summary { flex: 1 1 260px; }
    .line .act { margin-left: auto; }
    .account-line .act, .member-line .act { order: 3; flex-basis: 100%; justify-content: flex-start; }
    .details { margin-left: 0; }
    .fact { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
