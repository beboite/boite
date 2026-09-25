<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowLeft, Check, ChevronRight, X } from '@lucide/svelte';
  import type { Account, ProviderSummary } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { bytes, percent } from '../lib/format';
  import { nextAccountLabel, setupStep, signInTarget, type SetupStep } from '../lib/provider-setup';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * From "no AI connected" to a composer on a signed-in agent without leaving
   * the conversation: pick a service, Boite downloads it when it can, opens its
   * sign-in, and hands the composer over once the account answers. The same
   * store calls as the Providers page, one step at a time, so what is set here
   * is what Settings shows afterwards. The text in the composer is untouched.
   */
  let { store }: { store: Store } = $props();

  /** What a person who is not a developer is most likely to already pay for. */
  const FEATURED = ['claude', 'codex'];
  /** Agents Boite cannot download: their own installer is one click away. */
  const SETUP_URLS: Record<string, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    codex: 'https://developers.openai.com/codex/cli',
    opencode: 'https://opencode.ai/docs/',
    grok: 'https://grok.com/build',
    muse: 'https://developer.meta.com/ai/products/muse-code/',
    pi: 'https://github.com/earendil-works/pi'
  };

  const overlay = new Closing();
  let dialog = $state<HTMLDivElement | undefined>(undefined);
  let providerId = $state<string | null>(null);
  let accountId = $state<string | null>(null);
  let code = $state('');
  let busy = $state(false);
  let detecting = $state(false);
  /** An install asked for here: the sign-in follows the download on its own. */
  let chained = $state(false);

  $effect(() => {
    const current = store.connectDialog;
    if (!current) {
      overlay.hide();
      return;
    }
    providerId = current.providerId;
    accountId = current.accountId;
    code = '';
    chained = false;
    overlay.show();
    void focusFirst();
  });

  $effect(() => { if (overlay.open) return mobileOverlay(() => store.closeConnect()); });

  async function focusFirst(unlessInside = false) {
    await tick();
    if (unlessInside && dialog?.contains(document.activeElement)) return;
    dialog?.querySelector<HTMLElement>('.body button:not(:disabled), .body a, .body input')?.focus({ preventScroll: true });
  }

  // A step that replaces the pressed button hands the keyboard to its own first control, not to the page behind.
  $effect(() => { void [step, login?.url]; if (overlay.open) void focusFirst(true); });

  let featured = $derived(store.providers.filter((p) => FEATURED.includes(p.id)).sort((a, b) => FEATURED.indexOf(a.id) - FEATURED.indexOf(b.id)));
  let others = $derived(store.providers.filter((p) => !FEATURED.includes(p.id)));
  let provider = $derived(providerId ? store.providerOf(providerId) : null);
  let accounts = $derived(provider ? store.accountsOf(provider.id) : []);
  const loggingIn = (id: string): boolean => store.logins[id]?.state === 'running' || store.loginTerminals.includes(id);
  /** A CLI that signs in through its own menu: the dialog shows a terminal with the command typed in. */
  const inTerminal = (entry: ProviderSummary): boolean => entry.login !== false && entry.login.kind === 'terminal';
  /** xterm and its shell, loaded the first time a sign-in needs a terminal. */
  const terminalView = () => import('./TerminalView.svelte');
  let step = $derived<SetupStep | null>(provider ? stepFor(provider) : null);
  /** The account whose login this dialog shows: the one it was opened for, else the running or failed one. */
  let loginAccount = $derived.by((): Account | null => {
    const named = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;
    if (named && (store.logins[named.id] || store.loginTerminals.includes(named.id))) return named;
    return accounts.find((a) => loggingIn(a.id)) ?? accounts.find((a) => store.logins[a.id]) ?? null;
  });
  let login = $derived(loginAccount ? store.logins[loginAccount.id] : undefined);
  let install = $derived(provider ? store.installOf(provider.id) : null);

  function stepFor(entry: ProviderSummary): SetupStep {
    // A sign-in asked for one account: that account's state decides, not the provider's best.
    const named = accountId ? store.accountsOf(entry.id).find((a) => a.id === accountId) : undefined;
    if (named && entry.available && named.status !== 'ok' && !loggingIn(named.id)) return entry.login && (named.isolationDir !== null || inTerminal(entry)) ? 'sign-in' : 'external';
    return setupStep(entry, store.installOf(entry.id), store.accountsOf(entry.id), loggingIn);
  }

  function planOf(entry: ProviderSummary): string {
    const plans = strings.connect.plan as Record<string, string>;
    return plans[entry.id] ?? fill(strings.connect.otherPlan, { provider: entry.name });
  }

  function ready(entry: ProviderSummary): boolean {
    return stepFor(entry) === 'ready';
  }

  function choose(entry: ProviderSummary) {
    providerId = entry.id;
    accountId = null;
    code = '';
    void focusFirst();
  }

  function back() {
    providerId = null;
    accountId = null;
    void focusFirst();
  }

  async function signIn() {
    if (!provider || busy) return;
    busy = true;
    try {
      const terminal = inTerminal(provider);
      const named = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;
      // In a terminal the user's own CLI signs in, the way they would have typed it.
      const own = terminal ? accounts.find((a) => a.isolationDir === null && a.status !== 'ok') : undefined;
      const account = (named && (named.isolationDir !== null || terminal) ? named : own ?? signInTarget(accounts))
        ?? await store.addAccount({ providerId: provider.id, label: nextAccountLabel(provider, accounts), useDefaultLocation: false });
      if (account) {
        accountId = account.id;
        if (terminal) store.showLoginTerminal(account.id);
        else await store.loginAccount(account.id);
      }
    } finally { busy = false; }
  }

  async function startInstall() {
    if (!provider) return;
    chained = true;
    if (!await store.installProvider(provider.id)) chained = false;
  }

  // The download landed: go straight on to the sign-in, as the Providers page does.
  $effect(() => {
    if (chained && provider?.available && step === 'sign-in') {
      chained = false;
      void signIn();
    }
  });

  async function checkAgain() {
    if (!provider || detecting) return;
    detecting = true;
    try {
      if (!provider.available) await store.reloadProviders();
      else for (const account of accounts) await store.checkAccount(account.id);
    } finally { detecting = false; }
  }

  async function sendCode(event: SubmitEvent) {
    event.preventDefault();
    if (!loginAccount || code.trim().length === 0) return;
    const text = code;
    code = '';
    await store.sendLoginInput(loginAccount.id, text);
  }

  function use() {
    if (!provider) return;
    store.useProvider(provider.id, accountId);
    store.closeConnect();
  }

  function onkeydown(event: KeyboardEvent) {
    if (!store.connectDialog || event.key !== 'Escape') return;
    // A sign-in menu in the terminal steps back on Escape: that key is the CLI's.
    if (event.target instanceof Element && event.target.closest('[data-testid=connect-login-terminal]')) return;
    event.preventDefault();
    event.stopPropagation();
    store.closeConnect();
  }

  function ratio(): number {
    return install?.state === 'downloading' && install.totalBytes > 0 ? Math.min(100, (install.receivedBytes / install.totalBytes) * 100) : 0;
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown}
  <div
    class="scrim"
    class:closing={overlay.closing}
    role="presentation"
    use:overlay.attach
    onanimationend={overlay.end}
    onclick={(event) => { if (event.target === event.currentTarget) store.closeConnect(); }}
  >
    <div class="dialog" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-labelledby="connect-title" tabindex="-1" data-testid="connect-dialog" bind:this={dialog}>
      <div class="head">
        {#if provider}
          <button type="button" class="icon ghost small" data-testid="connect-back" aria-label={strings.connect.back} title={strings.connect.back} onclick={back}><ArrowLeft size={16} /></button>
        {/if}
        <h2 id="connect-title">{provider ? provider.name : strings.connect.title}</h2>
        <button type="button" class="icon ghost small close" data-testid="connect-close" aria-label={strings.connect.close} title={strings.connect.close} onclick={() => store.closeConnect()}><X size={16} /></button>
      </div>

      <div class="body">
        {#if !store.owner}
          <p class="muted" data-testid="connect-device">{strings.connect.device}</p>
        {:else if !provider}
          <p class="muted intro">{strings.connect.intro}</p>
          <div class="list">
            {#each featured as entry (entry.id)}
              <button type="button" class="service" data-testid="connect-service" data-provider={entry.id} onclick={() => choose(entry)}>
                <ProviderLogo providerId={entry.id} size={24} />
                <span class="who"><span class="name">{entry.name}</span><span class="plan">{planOf(entry)}</span></span>
                {#if ready(entry)}<Check size={16} class="ok" />{:else}<ChevronRight size={16} />{/if}
              </button>
            {/each}
          </div>
          {#if others.length > 0}
            <span class="section-label">{strings.connect.more}</span>
            <div class="list compact">
              {#each others as entry (entry.id)}
                <button type="button" class="service" data-testid="connect-service" data-provider={entry.id} onclick={() => choose(entry)}>
                  <ProviderLogo providerId={entry.id} size={18} />
                  <span class="who"><span class="name">{entry.name}</span></span>
                  {#if ready(entry)}<Check size={14} class="ok" />{:else}<ChevronRight size={14} />{/if}
                </button>
              {/each}
            </div>
          {/if}
        {:else}
          <div class="step" data-testid="connect-step" data-step={step}>
            <p class="plan-line"><ProviderLogo providerId={provider.id} size={20} /><span>{planOf(provider)}</span></p>
            {#if step === 'install'}
              {#if install?.state === 'failed'}<p class="bad" role="alert">{install.message}</p>{/if}
              <button type="button" class="primary" data-testid="connect-install" onclick={() => void startInstall()}>{fill(strings.connect.install, { provider: provider.name })}</button>
              {#if install?.state === 'absent'}<p class="muted">{fill(strings.connect.installNote, { size: bytes(install.archiveBytes) })}</p>{/if}
            {:else if step === 'installing'}
              <div class="track" role="progressbar" aria-label={strings.install.progress} aria-valuenow={Math.round(ratio())} aria-valuemin={0} aria-valuemax={100}>
                <span class="bar" class:indeterminate={install?.state !== 'downloading'} style="width: {ratio()}%"></span>
              </div>
              <p class="muted" role="status">{install?.state === 'downloading' ? fill(strings.install.downloading, { percent: percent(ratio()) }) : install?.state === 'verifying' ? strings.install.verifying : strings.install.extracting}</p>
              <button type="button" class="quiet small" onclick={() => void store.cancelInstall(provider.id)}>{strings.install.cancel}</button>
            {:else if step === 'repair'}
              <button type="button" class="primary" onclick={async () => { await store.uninstallProvider(provider.id); await startInstall(); }}>{strings.install.repair}</button>
            {:else if step === 'manual'}
              <p>{fill(strings.connect.manual, { provider: provider.name })}</p>
              <div class="row-actions">
                {#if SETUP_URLS[provider.id]}<a class="button primary" href={SETUP_URLS[provider.id]} target="_blank" rel="noreferrer" data-testid="connect-installer">{strings.connect.manualOpen}</a>{/if}
                <button type="button" class="quiet" disabled={detecting} data-testid="connect-check" onclick={() => void checkAgain()}>{strings.connect.checkAgain}</button>
              </div>
            {:else if step === 'sign-in'}
              {#if login?.state === 'failed'}<p class="bad" role="alert" data-testid="connect-login-failed">{login.output}</p>{/if}
              <button type="button" class="primary" data-testid="connect-sign-in" disabled={busy} onclick={() => void signIn()}>{fill(strings.connect.signIn, { provider: provider.name })}</button>
              <p class="muted">{strings.connect.signInNote}</p>
            {:else if step === 'signing-in' && loginAccount && store.loginTerminals.includes(loginAccount.id)}
              {@const terminalAccount = loginAccount}
              <p class="muted">{strings.accounts.terminalHint}</p>
              <div class="screen" data-testid="connect-login-terminal">
                {#await terminalView() then { default: TerminalView }}
                  <TerminalView
                    {store}
                    id="login:{terminalAccount.id}"
                    start={(cols, rows) => store.loginTerminal(terminalAccount.id, cols, rows)}
                    onexit={() => store.hideLoginTerminal(terminalAccount.id)}
                    autofocus
                  />
                {/await}
              </div>
              <button type="button" class="quiet small" data-testid="connect-login-terminal-close" onclick={() => void store.closeTerminal(`login:${terminalAccount.id}`)}>{strings.accounts.terminalDone}</button>
            {:else if step === 'signing-in' && loginAccount}
              {#if login?.url}
                <a class="button primary" href={login.url} target="_blank" rel="noreferrer" data-testid="connect-login-url">{strings.accounts.loginOpen}</a>
                <p class="muted">{strings.connect.signInNote}</p>
                <form class="code" onsubmit={(event) => void sendCode(event)}>
                  <input data-testid="connect-login-input" placeholder={provider.login && provider.login.kind === 'acp' ? strings.accounts.loginRedirectPlaceholder : strings.accounts.loginInputPlaceholder} bind:value={code} />
                  <button type="submit" class="quiet small">{strings.accounts.loginSend}</button>
                </form>
              {:else}
                <p class="muted" role="status">{strings.accounts.loginStarting}</p>
              {/if}
              <button type="button" class="quiet small" data-testid="connect-login-cancel" onclick={() => void store.cancelLogin(loginAccount.id)}>{strings.accounts.loginCancel}</button>
            {:else if step === 'external'}
              <p>{fill(strings.connect.external, { provider: provider.name })}</p>
              <button type="button" class="quiet" disabled={detecting} data-testid="connect-check" onclick={() => void checkAgain()}>{strings.connect.checkAgain}</button>
            {:else if step === 'ready'}
              <p class="done" role="status"><Check size={16} />{fill(strings.connect.ready, { provider: provider.name })}</p>
              <button type="button" class="primary" data-testid="connect-use" onclick={use}>{fill(strings.connect.use, { provider: provider.name })}</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: min(14vh, 120px);
    background: var(--color-scrim);
    backdrop-filter: blur(4px);
    animation: fade var(--dur-2) var(--ease-out-quint);
  }

  .scrim.closing { animation-name: fade-out; pointer-events: none; }

  .dialog {
    width: min(460px, calc(100vw - 32px));
    max-height: min(80dvh, 600px);
    display: flex;
    flex-direction: column;
    background: var(--color-surface);
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-e3);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .dialog.closing { animation-name: pop-out; }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 12px 10px 18px;
    border-bottom: 1px solid var(--color-border);
  }

  .head:has(button:first-child:not(.close)) { padding-left: 10px; }
  h2 { flex: 1; font-size: var(--text-md); }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 18px 18px;
    overflow-y: auto;
  }

  .intro { font-size: var(--text-sm); line-height: 1.5; }

  .list { display: flex; flex-direction: column; gap: 6px; }
  .list.compact { gap: 2px; }

  .service {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    height: auto;
    min-height: 56px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--color-foreground);
    text-align: left;
  }

  .compact .service { min-height: var(--row); padding: 4px 10px; border-color: transparent; }
  .service:hover, .service:focus-visible { background: var(--color-hover); outline: none; }
  .service:active { transform: none; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { font-weight: 500; }
  .plan { font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .service :global(.ok), .done :global(svg) { color: var(--color-success); }

  .step { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
  .step p { font-size: var(--text-sm); line-height: 1.5; }
  .plan-line { display: flex; align-items: center; gap: 8px; color: var(--color-muted-foreground); }
  .done { display: flex; align-items: center; gap: 8px; }
  .bad { color: var(--color-danger); white-space: pre-wrap; word-break: break-word; }
  .row-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  a.button {
    display: inline-flex;
    align-items: center;
    height: var(--control);
    padding: 0 14px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-foreground);
    text-decoration: none;
  }
  a.button.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-accent-ink); }
  a.button.primary:hover { background: color-mix(in oklch, var(--color-accent) 88%, var(--color-foreground)); }
  /* The terminal's own height: a menu of a dozen lines fits without a scroll. */
  .screen { width: 100%; height: 280px; min-width: 0; border-radius: var(--radius-sm); overflow: hidden; }
  .code { display: flex; gap: 6px; width: 100%; }
  .code input { flex: 1; min-width: 0; height: var(--input); }

  .track { width: 100%; height: 4px; border-radius: 999px; background: var(--color-hover); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--color-accent); transition: width var(--dur-2) var(--ease-out-quint); }
  .bar.indeterminate { width: 30% !important; animation: slide 1.2s var(--ease-out-quint) infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(330%); } }

  @media (max-width: 720px) {
    .scrim { align-items: flex-end; padding: 0; }
    .dialog { width: 100%; max-height: calc(90dvh - env(safe-area-inset-top, 0px)); border-radius: var(--radius-xl) var(--radius-xl) 0 0; }
    .body { padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
    .service { min-height: var(--touch-target); }
  }
</style>
