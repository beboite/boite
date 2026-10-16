<script lang="ts">
  import { errorText } from '../lib/errors';
  import { untrack } from 'svelte';
  import { checkSettingsPatch, type SubscriptionProxy, type SubscriptionProxyMode } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { clockTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  let { store }: { store: Store } = $props();
  let config = $state<SubscriptionProxy>({ enabled: false, kind: 'douane', baseUrl: 'http://127.0.0.1:8787', dashboardUrl: 'http://127.0.0.1:8787/admin/#quotas' });
  let key = $state('');
  let clearKey = $state(false);
  let busy = $state(false);
  let acting = $state(false);
  let result = $state('');
  let failed = $state(false);
  /** What the form leaves when it switches to local mode, so switching back finds the address typed. */
  let remote = $state<Pick<SubscriptionProxy, 'kind' | 'baseUrl' | 'dashboardUrl'> | null>(null);
  $effect(() => {
    const saved = store.settings?.subscriptionProxy;
    untrack(() => { if (saved) config = { ...saved }; });
  });
  const local = $derived(config.mode === 'local');
  /** Douane's state is shown once local mode is saved: before that, nothing runs. */
  const savedLocal = $derived(store.settings?.subscriptionProxy?.mode === 'local');
  const douane = $derived(savedLocal ? store.douane : null);
  const percent = $derived(douane?.progress && douane.progress.totalBytes > 0
    ? Math.min(100, Math.round((douane.progress.receivedBytes / douane.progress.totalBytes) * 100)) : null);
  const runs = $derived(douane !== null && ['running', 'starting', 'installing', 'updating'].includes(douane.state));

  function choose(kind: SubscriptionProxy['kind']) {
    const oldDefault = config.kind === 'douane' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8317';
    const baseUrl = config.baseUrl === oldDefault ? (kind === 'douane' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8317') : config.baseUrl;
    config = { ...config, kind, baseUrl, dashboardUrl: `${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}${kind === 'douane' ? '/admin/#quotas' : '/management.html#/quota'}` };
    result = '';
  }

  /** Local mode runs Douane: the core writes the URLs, the ones here only pass the check. */
  function chooseMode(mode: SubscriptionProxyMode) {
    if (mode === (config.mode ?? 'remote')) return;
    result = '';
    if (mode === 'local') {
      remote = { kind: config.kind, baseUrl: config.baseUrl, dashboardUrl: config.dashboardUrl };
      config = { ...config, mode, kind: 'douane' };
    } else {
      const back = remote ?? { kind: 'douane' as const, baseUrl: 'http://127.0.0.1:8787', dashboardUrl: 'http://127.0.0.1:8787/admin/#quotas' };
      config = { ...config, ...back, mode };
    }
  }

  async function save() {
    const client = store.client;
    if (!client || !store.owner || busy) return;
    busy = true; result = ''; failed = false;
    try {
      const checked = checkSettingsPatch({ subscriptionProxy: { ...config } });
      if (!checked.ok) throw new Error(checked.message);
      store.settings = await client.call('subscriptionProxy.configure', {
        subscriptionProxy: checked.patch.subscriptionProxy!,
        ...(!local && (key || clearKey) ? { key: clearKey ? null : key } : {}),
      });
      key = ''; clearKey = false;
      result = strings.subscriptionProxy.saved;
    } catch (error) { failed = true; result = errorText(error); }
    finally { busy = false; }
  }

  async function act(action: 'start' | 'stop' | 'update') {
    if (acting || !store.owner) return;
    acting = true;
    try { await store.douaneAction(action); }
    finally { acting = false; }
  }
</script>

<section class="card proxy-settings" data-testid="subscription-proxy-settings">
  <h2 class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.heading}</span><InfoTip topic={strings.subscriptionProxy.heading} text={strings.subscriptionProxy.hint} /></h2>
  <label class="switch-row"><span class="text ui-label">{strings.subscriptionProxy.enable}</span><input type="checkbox" role="switch" bind:checked={config.enabled} data-testid="subscription-proxy-enabled" /></label>
  <p class="hint" data-testid="subscription-proxy-enabled-hint">{strings.subscriptionProxy.enabledHint}</p>
  <div class="mode">
    <span class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.where}</span><InfoTip topic={strings.subscriptionProxy.local} text={strings.subscriptionProxy.localHint} /></span>
    <div class="segmented" role="group" aria-label={strings.subscriptionProxy.where}>
      <button type="button" aria-pressed={!local} onclick={() => chooseMode('remote')} data-testid="subscription-proxy-remote"><span class="ui-label">{strings.subscriptionProxy.remote}</span></button>
      <button type="button" aria-pressed={local} onclick={() => chooseMode('local')} data-testid="subscription-proxy-local"><span class="ui-label">{strings.subscriptionProxy.local}</span></button>
    </div>
  </div>
  {#if local}
    {#if douane}
      <div class="local" data-testid="douane-local" data-state={douane.state}>
        <div class="status">
          <span class="dot" class:ok={douane.state === 'running'} class:live={['installing', 'starting', 'updating'].includes(douane.state)} class:bad={douane.state === 'failed'}></span>
          <span class="state" data-testid="douane-local-state">{strings.subscriptionProxy.localState[douane.state]}</span>
          {#if douane.version}
            <span class="version" data-testid="douane-local-version">{douane.available ? fill(strings.subscriptionProxy.localAvailable, { version: douane.version, available: douane.available }) : fill(strings.subscriptionProxy.localVersion, { version: douane.version })}</span>
          {/if}
          {#if douane.state === 'running'}<span class="port">{fill(strings.subscriptionProxy.localPort, { port: String(douane.port) })}</span>{/if}
          {#if douane.development}<span class="port">{strings.subscriptionProxy.localDevelopment}</span>{/if}
        </div>
        {#if douane.progress}
          <div class="progress">
            <span class="figure">{fill(strings.subscriptionProxy.localDownloaded, { percent: String(percent ?? 0) })}</span>
            <span class="track"><span class="bar" style:width={`${percent ?? 0}%`}></span></span>
          </div>
        {/if}
        {#if douane.message}<p class="hint" class:error={douane.state === 'failed'} data-testid="douane-local-message">{douane.message}</p>{/if}
        {#if douane.restartAt}<p class="hint">{fill(strings.subscriptionProxy.localRestartAt, { time: clockTime(douane.restartAt) })}</p>{/if}
        {#if store.owner}
          <div class="actions">
            {#if runs}
              <button type="button" class="quiet small" disabled={acting} onclick={() => act('stop')} data-testid="douane-local-stop"><span class="ui-label">{strings.subscriptionProxy.stop}</span></button>
            {:else}
              <button type="button" class="quiet small" disabled={acting || douane.state === 'unavailable'} onclick={() => act('start')} data-testid="douane-local-start"><span class="ui-label">{strings.subscriptionProxy.start}</span></button>
            {/if}
            {#if douane.available && douane.state !== 'updating'}
              <button type="button" class="quiet small" disabled={acting} onclick={() => act('update')} data-testid="douane-local-update"><span class="ui-label">{strings.subscriptionProxy.update}</span></button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <div class="actions"><button type="submit" class="primary small" disabled={busy || !store.owner} data-testid="subscription-proxy-save"><span class="ui-label">{strings.subscriptionProxy.save}</span></button></div>
      {#if result}<p class="hint" class:error={failed} role="status" data-testid="subscription-proxy-result">{result}</p>{/if}
    </form>
  {:else}
    <div class="actions" role="group" aria-label={strings.subscriptionProxy.heading}>
      <button type="button" class="quiet small" aria-pressed={config.kind === 'douane'} onclick={() => choose('douane')} data-testid="subscription-proxy-douane"><span class="ui-label">Douane</span></button>
      <button type="button" class="quiet small" aria-pressed={config.kind === 'cliproxyapi'} onclick={() => choose('cliproxyapi')} data-testid="subscription-proxy-cliproxyapi"><span class="ui-label">CLIProxyAPI</span></button>
    </div>
    <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
      <label><span class="ui-label">{strings.subscriptionProxy.baseUrl}</span><input type="url" bind:value={config.baseUrl} required data-testid="subscription-proxy-url" /></label>
      <label><span class="ui-label">{strings.subscriptionProxy.dashboardUrl}</span><input type="url" bind:value={config.dashboardUrl} required data-testid="subscription-proxy-dashboard" /></label>
      <label><span class="ui-label-box"><span class="ui-label">{strings.subscriptionProxy.key}</span><InfoTip topic={strings.subscriptionProxy.key} text={strings.subscriptionProxy.keyHint} /></span><input type="password" bind:value={key} autocomplete="new-password" disabled={clearKey} data-testid="subscription-proxy-key" /></label>
      <label class="clear-key"><input type="checkbox" bind:checked={clearKey} /><span class="ui-label">{strings.subscriptionProxy.clearKey}</span></label>
      <div class="actions"><button type="submit" class="primary small" disabled={busy} data-testid="subscription-proxy-save"><span class="ui-label">{strings.subscriptionProxy.save}</span></button></div>
      {#if result}<p class="hint" class:error={failed} role="status" data-testid="subscription-proxy-result">{result}</p>{/if}
    </form>
  {/if}
</section>

<style>
  .proxy-settings { max-width: var(--settings-width); padding: var(--settings-padding); }
  h2 { display: flex; align-items: center; }
  form { display: grid; gap: 12px; margin-top: 16px; }
  form > label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: var(--text-sm); }
  form input:not([type='checkbox']) { width: 100%; min-width: 0; }
  .clear-key { min-height: var(--row); }
  .proxy-settings > .hint { margin: 2px 0 10px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { color: var(--color-danger); }
  [aria-pressed='true'] { background: var(--color-active); }

  .mode { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; font-size: var(--text-sm); }
  .segmented { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius-md); background: var(--color-surface-2); }
  .segmented button {
    min-height: var(--control-sm); padding: 2px 12px; border: 0; border-radius: var(--radius-sm); background: transparent;
    color: var(--color-muted-foreground); font-size: var(--text-sm);
    transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint);
  }
  .segmented button:hover { color: var(--color-foreground); }
  .segmented button[aria-pressed='true'] { background: var(--color-active); color: var(--color-foreground); }

  .local { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); animation: rise var(--dur-3) var(--ease-out-quint); }
  .status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; font-size: var(--text-sm); }
  .state { font-weight: 500; }
  .version, .port { color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .port { font-family: var(--font-mono); }
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.live { background: var(--color-live); }
  .dot.bad { background: var(--color-danger); }
  .local .hint { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .local .hint.error { color: var(--color-danger); }
  .progress { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 10px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .figure { font-variant-numeric: tabular-nums; }
  .track { height: 2px; border-radius: 999px; background: var(--color-surface-3); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--color-foreground); transition: width var(--dur-2) var(--ease-out-quint); }
  .local .actions { margin: 0; }
</style>
