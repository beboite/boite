<script lang="ts">
  import { errorText } from '../lib/errors';
  import InfoTip from './InfoTip.svelte';
  import { Download, ExternalLink, Play, Puzzle, RefreshCw, RotateCw, ShieldAlert, Square, TriangleAlert } from '@lucide/svelte';
  import type { PluginAppState, PluginGatewayState, PluginPool, PluginPreview, PluginRejected, PluginState, PluginUpdates, RpcParams } from '@boite/contracts';
  import { gatewayDashboardReachable } from '@boite/contracts';
  import { besideCore } from '../lib/gateway-dashboard';
  import { openExternal } from '../lib/links';
  import GatewayMoveDialog from './GatewayMoveDialog.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { relativeTime } from '../lib/format';
  import { confirm } from '../lib/confirm.svelte';
  import QuotaList from './QuotaList.svelte';

  /**
   * One machine's plugins. The page mounts a fresh one per machine, so an
   * answer still on its way from the previous core lands in a discarded page.
   */
  let { store }: { store: Store } = $props();
  const t = strings.plugins;

  let plugins = $state<PluginState[]>([]);
  let pools = $state<Record<string, PluginPool[]>>({});
  let busy = $state<Record<string, boolean>>({});
  let checking = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let error = $state('');
  /** The gateway plugin whose connections dialog is open. */
  let moving = $state(false);

  let url = $state('');
  let ref = $state('');
  let inspecting = $state(false);
  let adding = $state(false);
  let preview = $state<PluginPreview | null>(null);
  let inspectError = $state('');

  /** Anything with files on disk, and every plugin added from a URL whatever its state. */
  let installed = $derived(plugins.filter((plugin) => plugin.origin === 'url' || plugin.version !== null));
  let recommended = $derived(plugins.filter((plugin) => plugin.origin === 'recommended' && plugin.version === null));

  const messageOf = (cause: unknown) => (errorText(cause));
  const short = (commit: string) => commit.slice(0, 7);
  const bare = (address: string) => address.replace(/^https:\/\//, '');
  const providerName = (id: string) => store.providers.find((provider) => provider.id === id)?.name ?? id;

  /** The core's order: recommended plugins as shipped, then URL ones by id. */
  function order(a: PluginState, b: PluginState): number {
    if (a.origin !== b.origin) return a.origin === 'recommended' ? -1 : 1;
    return a.origin === 'url' ? a.id.localeCompare(b.id) : 0;
  }

  /**
   * A URL plugin that comes back not installed is gone: its uninstall or its first install's cancel.
   * A known plugin keeps its place, so a row does not jump under the pointer after Stop or a switch.
   */
  function put(next: PluginState) {
    const rest = plugins.filter((plugin) => plugin.id !== next.id);
    if (next.version === null) delete pools[next.id];
    if (next.origin === 'url' && next.status === 'not-installed') plugins = rest;
    else if (rest.length < plugins.length) plugins = plugins.map((plugin) => plugin.id === next.id ? next : plugin);
    else plugins = [...rest, next].sort(order);
  }

  async function loadPools(id: string, refresh = false) {
    const client = store.client;
    if (!client || busy[id]) return;
    busy[id] = true;
    try {
      pools[id] = await client.call('plugins.accounts', { id, refresh });
      delete errors[id];
    } catch (cause) {
      errors[id] = messageOf(cause);
    } finally {
      busy[id] = false;
    }
  }

  async function change(plugin: PluginState, method: 'plugins.install' | 'plugins.cancel' | 'plugins.uninstall') {
    const client = store.client;
    if (!client) return;
    if (method === 'plugins.uninstall' && !await confirm.ask({
      title: fill(t.removeTitle, { name: plugin.name }), body: plugin.gateway ? fill(t.removeGatewayBody, { dir: plugin.gateway.dataDir }) : t.removeBody,
      confirmLabel: t.remove, cancelLabel: strings.common.cancel, danger: true
    })) return;
    busy[plugin.id] = true;
    try {
      put(await client.call(method, { id: plugin.id }));
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      busy[plugin.id] = false;
    }
  }

  async function accountAction(plugin: PluginState, provider: string, action: RpcParams<'plugins.accountAction'>['action'], email?: string) {
    const client = store.client;
    if (!client) return;
    if (action !== 'add' && !await confirm.ask({
      title: action === 'switch' ? t.switchTitle : t.forgetTitle,
      body: action === 'switch' ? t.switchBody : t.forgetBody,
      confirmLabel: action === 'switch' ? t.switch : t.forget,
      cancelLabel: strings.common.cancel, danger: action === 'remove'
    })) return;
    busy[plugin.id] = true;
    try {
      pools[plugin.id] = await client.call('plugins.accountAction', { id: plugin.id, provider, action, ...(email ? { email } : {}) });
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      busy[plugin.id] = false;
    }
  }

  async function inspect(event: SubmitEvent) {
    event.preventDefault();
    const client = store.client;
    if (!client || url.trim() === '' || inspecting) return;
    inspecting = true;
    inspectError = '';
    preview = null;
    try {
      preview = await client.call('plugins.inspect', { url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) });
    } catch (cause) {
      inspectError = messageOf(cause);
    } finally {
      inspecting = false;
    }
  }

  async function add() {
    const client = store.client;
    const previewId = preview?.previewId;
    if (!client || !previewId || adding) return;
    adding = true;
    try {
      put(await client.call('plugins.add', { previewId }));
      preview = null;
      url = '';
      ref = '';
    } catch (cause) {
      inspectError = messageOf(cause);
      preview = null;
    } finally {
      adding = false;
    }
  }

  /** Start, stop or restart a desktop app; the core answers with the plugin's new state. */
  async function appAction(plugin: PluginState, action: RpcParams<'plugins.app'>['action']) {
    const client = store.client;
    if (!client) return;
    busy[plugin.id] = true;
    try {
      put(await client.call('plugins.app', { id: plugin.id, action }));
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      busy[plugin.id] = false;
    }
  }

  /** Start, stop or restart a gateway; the core answers once it answers `/health`, or failed to. */
  async function gatewayAction(plugin: PluginState, action: RpcParams<'plugins.gateway'>['action']) {
    const client = store.client;
    if (!client) return;
    busy[plugin.id] = true;
    try {
      put(await client.call('plugins.gateway', { id: plugin.id, action }));
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      busy[plugin.id] = false;
    }
  }

  /** Whether the plugin's desktop app and gateway start with Boite; nothing running changes. */
  async function setAutostart(plugin: PluginState, autostart: boolean) {
    const client = store.client;
    if (!client) return;
    busy[plugin.id] = true;
    try {
      put(await client.call('plugins.autostart', { id: plugin.id, autostart }));
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      busy[plugin.id] = false;
    }
  }

  function gatewayLine(gateway: PluginGatewayState): string {
    switch (gateway.status) {
      case 'running': return fill(t.gatewayRunning, { version: gateway.version ?? '', port: String(gateway.port) }).trim();
      case 'starting': return t.gatewayStarting;
      case 'updating': return t.gatewayUpdating;
      case 'crashed': return t.gatewayCrashed;
      default: return gateway.enabled || gateway.autostart ? t.appStopped : t.appOff;
    }
  }

  /** Its dashboard, where this client can reach a loopback address: beside the core only. */
  function gatewayDashboard(gateway: PluginGatewayState): string | null {
    const url = `http://127.0.0.1:${gateway.port}/admin/`;
    return gateway.status === 'running' && gatewayDashboardReachable(url, besideCore(store)) ? url : null;
  }

  function appLine(app: PluginAppState): string {
    switch (app.status) {
      case 'running': return t.appRunning;
      case 'starting': return t.appStarting;
      case 'crashed': return app.exitCode === null ? t.appCrashedSignal : fill(t.appCrashed, { code: String(app.exitCode) });
      case 'unavailable': return t.appUnavailable;
      default: return app.enabled || app.autostart ? t.appStopped : t.appOff;
    }
  }

  function stateLine(plugin: PluginState): string {
    switch (plugin.status) {
      case 'installed':
        return plugin.availableVersion && plugin.availableVersion !== plugin.version
          ? `${t.stateInstalled} · ${fill(t.updateAvailable, { version: `v${plugin.availableVersion}` })}` : t.stateInstalled;
      case 'installing': return `${t.stateInstalling} · ${plugin.progress}%`;
      case 'error': return t.stateError;
      case 'rejected': return t.stateRejected;
      // Not installed needs no word: the Install button says it.
      default: return '';
    }
  }

  /** What the last look at the plugin's update source found, quietly: a source that failed or was ignored is no alarm. */
  function updatesLine(updates: PluginUpdates): string {
    if (updates.checking) return t.checkingUpdates;
    if (updates.error) return fill(t.updateFailed, { error: updates.error });
    if (updates.available) {
      return fill(t.updateFound, { source: bare(updates.source.url), ref: updates.source.ref, commit: short(updates.available.commit), time: relativeTime(updates.available.checkedAt) });
    }
    if (updates.ignored) return fill(t.updateIgnored, { reason: updates.ignored });
    return updates.checkedAt === null ? '' : fill(t.upToDate, { time: relativeTime(updates.checkedAt) });
  }

  /** Reads the plugin's update source now; the core answers with the state it leaves. */
  async function checkUpdates(plugin: PluginState) {
    const client = store.client;
    if (!client || checking[plugin.id]) return;
    checking[plugin.id] = true;
    try {
      for (const next of await client.call('plugins.checkUpdates', { id: plugin.id })) put(next);
      delete errors[plugin.id];
    } catch (cause) {
      errors[plugin.id] = messageOf(cause);
    } finally {
      checking[plugin.id] = false;
    }
  }

  $effect(() => {
    const client = store.client;
    if (!client) return;
    let disposed = false;
    const off = client.on('plugins.updated', (value) => {
      const before = plugins.find((plugin) => plugin.id === value.id);
      put(value);
      if (value.status === 'installed' && value.pools.length > 0 && before?.status !== 'installed') void loadPools(value.id);
    });
    void client.call('plugins.list', {}).then(async (rows) => {
      if (disposed) return;
      plugins = rows;
      for (const plugin of rows) {
        if (plugin.origin === 'recommended' && plugin.version === null && plugin.updates != null) void checkUpdates(plugin);
      }
      await Promise.all(rows.filter((plugin) => plugin.status === 'installed' && plugin.pools.length > 0).map((plugin) => loadPools(plugin.id)));
    }).catch((cause) => {
      if (!disposed) error = messageOf(cause);
    });
    return () => { disposed = true; off(); };
  });
</script>

{#snippet refusal(rejected: PluginRejected)}
  <div class="refusal" role="alert" data-testid="plugin-rejected" data-field={rejected.field}>
    <p class="refusal-title"><ShieldAlert size={15} strokeWidth={1.75} /><span class="ui-label">{t.refusedTitle}</span></p>
    <dl class="facts">
      <dt>{t.refusedFile}</dt><dd class="mono">{rejected.file}</dd>
      <dt>{t.refusedField}</dt><dd class="mono">{rejected.field}</dd>
      <dt>{t.refusedExpected}</dt><dd>{rejected.expected}</dd>
    </dl>
  </div>
{/snippet}

{#snippet autostartSwitch(plugin: PluginState, on: boolean | undefined)}
  <!-- A core older than plugins.autostart sends no `autostart`: nothing to switch there. -->
  {#if on !== undefined}
    <label class="autostart">
      <input type="checkbox" role="switch" checked={on} disabled={busy[plugin.id] === true} data-testid="plugin-autostart" data-plugin={plugin.id}
        onchange={(event) => { event.currentTarget.checked = on; void setAutostart(plugin, !on); }} />
      <span class="ui-label">{t.startWithBoite}</span>
    </label>
  {/if}
{/snippet}

{#snippet row(plugin: PluginState)}
  {@const working = busy[plugin.id] === true}
  {@const state = stateLine(plugin)}
  <div class="plugin" data-testid="plugin-row" data-plugin={plugin.id} data-status={plugin.status}>
    <div class="line">
      <span class="glyph" aria-hidden="true"><Puzzle size={16} strokeWidth={1.75} /></span>
      <div class="who">
        <h3>
          <span class="name">{plugin.name}</span>
          {#if plugin.version ?? plugin.availableVersion}<span class="version">v{plugin.version ?? plugin.availableVersion}</span>{/if}
          {#if plugin.homepage && !plugin.source}
            <a class="home" href={plugin.homepage} target="_blank" rel="noreferrer" title={t.source} aria-label={t.source} data-testid="plugin-home"><ExternalLink size={13} /></a>
          {/if}
        </h3>
        {#if state}
          <p class="state">
            <span class="dot" class:ok={plugin.status === 'installed'} class:live={plugin.status === 'installing'}
              class:bad={plugin.status === 'error' || plugin.status === 'rejected'}></span><span class="ui-label">{state}</span>
          </p>
        {/if}
        {#if plugin.description}<p class="description">{plugin.description}</p>{/if}
      </div>
      <div class="act">
        {#if plugin.status === 'installing'}
          <button class="quiet small" data-testid="plugin-cancel" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.cancel')}><span class="ui-label">{strings.common.cancel}</span></button>
        {:else if plugin.status === 'not-installed'}
          <button class="primary small" data-testid="plugin-install" data-plugin={plugin.id} disabled={working || plugin.artifact === null} onclick={() => void change(plugin, 'plugins.install')}><Download size={14} /><span class="ui-label">{t.install}</span></button>
        {:else}
          {#if plugin.status === 'installed' && plugin.availableVersion && plugin.availableVersion !== plugin.version}
            <button class="primary small" data-testid="plugin-update" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.install')}><span class="ui-label">{fill(t.update, { version: `v${plugin.availableVersion}` })}</span></button>
          {/if}
          {#if plugin.status === 'error' || (plugin.status === 'rejected' && plugin.origin === 'recommended')}
            <button class="small" data-testid="plugin-retry" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.install')}><RefreshCw size={14} /><span class="ui-label">{plugin.status === 'error' ? strings.common.retry : t.reinstall}</span></button>
          {/if}
        {/if}
        {#if plugin.updates && plugin.status !== 'installing'}
          {@const looking = plugin.updates.checking || checking[plugin.id] === true}
          <button class="ghost small icon" class:spinning={looking} data-testid="plugin-check-updates" data-plugin={plugin.id} title={t.checkUpdates} aria-label={t.checkUpdates}
            disabled={working || looking} onclick={() => void checkUpdates(plugin)}><RefreshCw size={14} /></button>
        {/if}
        {#if plugin.status !== 'installing' && plugin.status !== 'not-installed'}
          <button class="ghost small" data-testid="plugin-uninstall" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.uninstall')}><span class="ui-label">{t.remove}</span></button>
        {/if}
      </div>
    </div>
    {#if plugin.status === 'installing'}
      <div class="track" role="progressbar" aria-label={t.stateInstalling} aria-valuemin={0} aria-valuemax={100} aria-valuenow={plugin.progress} data-testid="plugin-progress" data-plugin={plugin.id}>
        <span class="bar" style:width="{plugin.progress}%"></span>
      </div>
    {/if}
    {#if plugin.source}
      <p class="meta">
        <a href={plugin.homepage ?? plugin.source.url} target="_blank" rel="noreferrer">{bare(plugin.source.url)}</a>
        <span class="mono">{fill(t.atCommit, { ref: plugin.source.ref, commit: short(plugin.source.commit) })}</span>
      </p>
    {/if}
    {#if plugin.updates}
      {@const line = updatesLine(plugin.updates)}
      {#if line}
        <p class="hint" data-testid="plugin-updates" data-plugin={plugin.id} data-available={plugin.updates.available?.version ?? ''}><span data-testid="plugin-updates-line">{line}</span></p>
      {/if}
    {/if}
    {#if plugin.error}<p class="bad" role="alert">{plugin.error}</p>{/if}
    {#if errors[plugin.id]}<p class="bad" role="alert">{errors[plugin.id]}</p>{/if}
    {#if plugin.rejected}{@render refusal(plugin.rejected)}{/if}
    {#if plugin.status === 'installed' && plugin.app}
      {@const app = plugin.app}
      {@const live = app.status === 'running' || app.status === 'starting'}
      <div class="desktop-app" data-testid="plugin-app" data-plugin={plugin.id} data-app-status={app.status}>
        <div class="app-head">
          <p class="state" data-testid="plugin-app-state">
            <span class="dot" class:ok={app.status === 'running'} class:live={app.status === 'starting'}
              class:bad={app.status === 'crashed' || app.status === 'unavailable'}></span><span class="ui-label app-name">{t.app}</span><span aria-hidden="true">·</span><span class="ui-label">{appLine(app)}</span>
          </p>
          <div class="act">
            {#if live}
              <button class="quiet small" data-testid="plugin-app-restart" data-plugin={plugin.id} disabled={working} onclick={() => void appAction(plugin, 'restart')}><RotateCw size={14} /><span class="ui-label">{t.appRestart}</span></button>
              <button class="quiet small" data-testid="plugin-app-stop" data-plugin={plugin.id} disabled={working} onclick={() => void appAction(plugin, 'stop')}><Square size={14} /><span class="ui-label">{t.appStop}</span></button>
            {:else}
              <button class="small" data-testid="plugin-app-start" data-plugin={plugin.id} disabled={working || app.status === 'unavailable'} onclick={() => void appAction(plugin, 'start')}><Play size={14} /><span class="ui-label">{t.appStart}</span></button>
            {/if}
          </div>
        </div>
        {@render autostartSwitch(plugin, app.autostart)}
        {#if app.error}<p class={app.status === 'crashed' ? 'bad' : 'hint'} data-testid="plugin-app-error">{app.error}</p>{/if}
      </div>
    {/if}
    {#if plugin.status === 'installed' && plugin.gateway}
      {@const gateway = plugin.gateway}
      {@const live = gateway.status !== 'stopped' && gateway.status !== 'crashed'}
      {@const dashboard = gatewayDashboard(gateway)}
      <div class="desktop-app" data-testid="plugin-gateway" data-plugin={plugin.id} data-gateway-status={gateway.status}>
        <div class="app-head">
          <p class="state" data-testid="plugin-gateway-state">
            <span class="dot" class:ok={gateway.status === 'running'} class:live={gateway.status === 'starting' || gateway.status === 'updating'}
              class:bad={gateway.status === 'crashed'}></span><span class="ui-label app-name">{t.gateway}</span><span aria-hidden="true">·</span><span class="ui-label gateway-line">{gatewayLine(gateway)}</span>
            <InfoTip topic={t.gateway} text={fill(t.gatewayData, { dir: gateway.dataDir })} />
          </p>
          <div class="act">
            {#if live}
              <button class="quiet small" data-testid="plugin-gateway-restart" data-plugin={plugin.id} disabled={working} onclick={() => void gatewayAction(plugin, 'restart')}><RotateCw size={14} /><span class="ui-label">{t.appRestart}</span></button>
              <button class="quiet small" data-testid="plugin-gateway-stop" data-plugin={plugin.id} disabled={working} onclick={() => void gatewayAction(plugin, 'stop')}><Square size={14} /><span class="ui-label">{t.appStop}</span></button>
            {:else}
              <button class="small" data-testid="plugin-gateway-start" data-plugin={plugin.id} disabled={working} onclick={() => void gatewayAction(plugin, 'start')}><Play size={14} /><span class="ui-label">{t.appStart}</span></button>
            {/if}
          </div>
        </div>
        {#if !plugin.app}{@render autostartSwitch(plugin, gateway.autostart)}{/if}
        {#if gateway.error}<p class={gateway.status === 'crashed' ? 'bad' : 'hint'} data-testid="plugin-gateway-error">{gateway.error}</p>{/if}
        {#if gateway.status === 'running' && (dashboard || plugin.id === 'douane')}
          <div class="act gateway-act">
            {#if dashboard}<button class="ghost small" data-testid="plugin-gateway-open" data-plugin={plugin.id} onclick={() => void openExternal(dashboard)}><ExternalLink size={14} /><span class="ui-label">{fill(strings.subscriptionProxy.openGateway, { name: plugin.name })}</span></button>{/if}
            {#if plugin.id === 'douane' && store.core?.features?.gatewayMove === true}
              <button class="ghost small" data-testid="plugin-gateway-move" data-plugin={plugin.id} onclick={() => { moving = true; }}><span class="ui-label">{strings.subscriptionProxy.move.open}</span></button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if plugin.status === 'installed' && plugin.pools.length > 0}
      <div class="pools">
        <div class="pools-head">
          <h4 class="section-label"><span class="ui-label">{t.pools}</span><InfoTip topic={t.pools} text={t.cliScope} /></h4>
          <button class="quiet small" data-testid="plugin-refresh" data-plugin={plugin.id} disabled={working} onclick={() => void loadPools(plugin.id, true)}><RefreshCw size={14} /><span class="ui-label">{strings.common.refresh}</span></button>
        </div>
        {#each pools[plugin.id] ?? [] as pool (pool.provider)}
          <div class="pool" data-testid="plugin-pool" data-plugin={plugin.id} data-provider={pool.provider}>
            <div class="pool-head">
              <h5><span class="ui-label">{providerName(pool.provider)}</span></h5>
              <button class="quiet small" disabled={working} onclick={() => void accountAction(plugin, pool.provider, 'add')}><span class="ui-label">{t.add}</span></button>
            </div>
            {#if pool.accounts.length === 0}<p class="hint">{t.empty}</p>{/if}
            {#each pool.accounts as account (account.email)}
              <div class="saved-account" class:active={account.active} data-testid="plugin-account" data-email={account.email}>
                <div class="account-head">
                  <strong class="ui-label">{account.email}</strong>
                  {#if account.active}<span class="tag ui-label-box" data-testid="plugin-account-active"><span class="ui-label">{t.active}</span></span>{/if}
                  <span class="account-actions">
                    {#if !account.active}
                      <button class="quiet small" disabled={working} data-testid="plugin-switch" onclick={() => void accountAction(plugin, pool.provider, 'switch', account.email)}><span class="ui-label">{t.switch}</span></button>
                    {/if}
                    <button class="ghost small" disabled={working} onclick={() => void accountAction(plugin, pool.provider, 'remove', account.email)}><span class="ui-label">{t.forget}</span></button>
                  </span>
                </div>
                <QuotaList rows={[{ accountId: account.email, providerId: pool.provider, providerName: account.email, label: '', enabled: true,
                  status: account.checkedSecondsAgo === null ? 'unavailable' : 'ready', windows: account.windows,
                  checkedAt: account.checkedSecondsAgo === null ? null : Date.now() - account.checkedSecondsAgo * 1000, error: null }]} />
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="page" data-testid="plugins-page">
  <header>
    <div><h1 class="ui-label-box"><span class="ui-label">{t.heading}</span><InfoTip topic={t.heading} text={t.intro} /></h1></div>
  </header>
  {#if error}<p class="bad" role="alert">{error}</p>{/if}

  {#if installed.length > 0}
    <section aria-labelledby="plugins-installed" data-testid="plugins-installed">
      <h2 id="plugins-installed" class="section-label"><span class="ui-label">{t.installedHeading}</span></h2>
      <div class="card list">
        {#each installed as plugin (plugin.id)}{@render row(plugin)}{/each}
      </div>
    </section>
  {/if}

  {#if recommended.length > 0}
    <section aria-labelledby="plugins-recommended" data-testid="plugins-recommended">
      <h2 id="plugins-recommended" class="section-label"><span class="ui-label">{t.recommendedHeading}</span></h2>
      <div class="card list">
        {#each recommended as plugin (plugin.id)}{@render row(plugin)}{/each}
      </div>
    </section>
  {/if}

  <section aria-labelledby="plugins-add" data-testid="plugins-add">
    <h2 id="plugins-add" class="section-label"><span class="ui-label">{t.addHeading}</span><InfoTip topic={t.addHeading} text={t.addHint} /></h2>
    <div class="card add">
      <form onsubmit={inspect}>
        <input class="url" data-testid="plugin-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
          aria-label={t.urlLabel} placeholder={t.urlPlaceholder} bind:value={url} />
        <input class="ref" data-testid="plugin-ref" autocomplete="off" autocapitalize="off" spellcheck="false"
          aria-label={t.refLabel} title={t.refLabel} placeholder={t.refPlaceholder} bind:value={ref} />
        <button type="submit" data-testid="plugin-inspect" disabled={url.trim() === '' || inspecting}><span class="ui-label">{inspecting ? t.inspecting : t.inspect}</span></button>
      </form>
      {#if inspectError}<p class="bad" role="alert" data-testid="plugin-inspect-error">{inspectError}</p>{/if}
      {#if preview}
        <div class="preview" data-testid="plugin-preview" data-rejected={preview.rejected !== null}>
          {#if preview.manifest}
            <div class="line">
              <span class="glyph" aria-hidden="true"><Puzzle size={16} strokeWidth={1.75} /></span>
              <div class="who">
                <h3>{preview.manifest.name}<span class="version">v{preview.manifest.version}</span></h3>
                <p class="state"><span class="ui-label">{preview.manifest.description}</span></p>
              </div>
            </div>
          {/if}
          {#if preview.rejected}
            {@render refusal(preview.rejected)}
          {/if}
          <dl class="facts">
            <dt>{t.previewSource}</dt>
            <dd><span class="wrap">{bare(preview.source.url)}</span> <span class="mono subtle">{fill(t.atCommit, { ref: preview.source.ref, commit: short(preview.source.commit) })}</span></dd>
            {#if preview.replaces}<dt>{t.previewReplaces}</dt><dd>v{preview.replaces}</dd>{/if}
            {#if preview.rejected === null && preview.artifact}
              <dt>{t.previewDownloads}</dt><dd class="mono wrap" data-testid="plugin-artifact">{preview.artifact.url}</dd>
              <dt>{t.previewDigest}</dt><dd class="mono wrap">{preview.artifact.sha256}</dd>
              <dt>{t.previewRuns}</dt>
              <dd><ul class="commands mono">{#each preview.commands as command (command)}<li>{command}</li>{/each}</ul></dd>
              {#if preview.manifest?.provides.accountPools}
                <dt>{t.previewPools}</dt>
                <dd>{preview.manifest.provides.accountPools.providers.map(providerName).join(', ')}</dd>
              {/if}
              {#if preview.manifest?.provides.desktopApp}
                <dt>{t.previewApp}</dt>
                <dd data-testid="plugin-preview-app">{t.previewAppBody}</dd>
              {/if}
              {#if preview.manifest?.provides.gateway}
                <dt>{t.previewGateway}</dt>
                <dd data-testid="plugin-preview-gateway">{t.previewGatewayBody}</dd>
              {/if}
            {/if}
          </dl>
          {#if preview.rejected === null}
            <p class="trust"><TriangleAlert size={15} strokeWidth={1.75} />{t.trust}</p>
          {/if}
          <div class="act end">
            <button class="quiet small" data-testid="plugin-dismiss" onclick={() => { preview = null; }}><span class="ui-label">{preview.rejected ? strings.common.dismiss : strings.common.cancel}</span></button>
            {#if preview.previewId && preview.manifest}
              <button class="primary small" data-testid="plugin-add" disabled={adding} onclick={() => void add()}><Download size={14} /><span class="ui-label">{fill(t.confirmAdd, { name: preview.manifest.name })}</span></button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </section>
</div>

<GatewayMoveDialog {store} open={moving} target="plugin" onclose={() => { moving = false; }} />

<style>
  .page { container-type: inline-size; }
  section { max-width: var(--settings-width); margin-bottom: 24px; }
  section > h2 { margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; }
  .bad { margin: 0; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; }

  /* One card per section, one row per plugin, like the Providers checklist. */
  .page .list { padding: 0; overflow: hidden; }
  .plugin { display: grid; gap: 8px; padding: 14px 16px; animation: rise var(--dur-3) var(--ease-out-quint); }
  .plugin + .plugin { border-top: 1px solid var(--color-border); }
  /* Everything under the head lines up with the name, not the glyph. */
  .plugin > :not(.line) { margin-left: 44px; }

  .line { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
  .glyph { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .who { flex: 1; min-width: 0; display: grid; gap: 3px; padding-top: 1px; }
  h3 { margin: 0; display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--text-base); font-weight: 600; overflow-wrap: anywhere; }
  .version { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
  .home { display: inline-grid; place-items: center; color: var(--color-muted-foreground); border-radius: var(--radius-sm); transition: color var(--dur-1) var(--ease-out-quint); }
  .home:hover, .home:focus-visible { color: var(--color-foreground); }
  .state { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }

  /* Hue is for status only: green once installed, amber while downloading, red when refused. */
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.live { background: var(--color-live); }
  .dot.bad { background: var(--color-danger); }

  .act { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
  .spinning :global(svg) { animation: spin 0.9s linear infinite var(--loops); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .act.end { justify-content: flex-end; }
  .gateway-act { justify-content: flex-start; }
  .gateway-line { font-variant-numeric: tabular-nums; }
  .act button, .pools button, .account-actions button { gap: 6px; }

  .track { height: 2px; border-radius: 999px; background: var(--color-surface-3); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--color-foreground); transition: width var(--dur-2) var(--ease-out-quint); }

  .description { margin: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-muted-foreground); }
  .meta { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .meta a { color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .meta a:hover { color: var(--color-foreground); }
  .meta .mono { font-size: var(--text-xs); }

  .refusal { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--color-danger) 35%, var(--color-border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-danger) 6%, transparent); }
  .refusal-title { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); font-weight: 600; color: var(--color-danger); }

  .facts { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; font-size: var(--text-sm); }
  .facts dt { color: var(--color-muted-foreground); }
  .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .wrap { overflow-wrap: anywhere; word-break: break-all; }
  .commands { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  /* A command that wraps keeps its continuation indented, so it still reads as one line. */
  .commands li { padding-left: 2ch; text-indent: -2ch; }

  .pools { display: grid; gap: 10px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--color-border); }
  /* The desktop app's own strip: one line of what it is doing, and the buttons that change it. */
  .desktop-app { display: grid; gap: 6px; padding: 6px 6px 6px 12px; border-radius: var(--radius-md); background: var(--color-surface-2); }
  .app-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .autostart { --switch-width: 32px; --switch-height: 20px; display: flex; align-items: center; gap: 8px; width: fit-content; font-size: var(--text-sm); color: var(--color-muted-foreground); cursor: pointer; }
  .app-name { color: var(--color-foreground); font-weight: 500; }
  .pools-head .section-label { display: flex; align-items: center; gap: 6px; }
  .pools-head, .pool-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h4 { margin: 0; }
  h5 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .pool { display: grid; gap: 8px; }
  /* One box per saved login: its name, its buttons and its limits together. */
  .saved-account { display: grid; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .account-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .account-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; }
  .tag { flex: none; padding: 1px 6px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--color-success) 16%, transparent); color: var(--color-success); font-size: var(--text-xs); font-weight: 500; }
  .account-actions { display: flex; margin-left: auto; gap: 4px; flex: none; }

  /* The card sits inside a section, where the page's card padding does not reach. */
  .add { display: grid; gap: 12px; padding: 12px; }
  form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 160px) auto; align-items: center; gap: 8px; }
  form input { width: 100%; }
  /* The button lines up with the fields beside it. */
  form button { height: var(--input); }
  .preview { display: grid; gap: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); animation: rise var(--dur-3) var(--ease-out-quint); }
  .trust { margin: 0; display: flex; align-items: flex-start; gap: 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; }
  .trust :global(svg) { flex: none; margin-top: 2px; color: var(--color-live); }

  /* The settings column, not the window: the page is as narrow in a split shell as on a phone. */
  @container (max-width: 560px) {
    .line { flex-wrap: wrap; }
    .line .act { width: 100%; justify-content: flex-start; padding-left: 44px; }
    .plugin > :not(.line) { margin-left: 0; }
    form { grid-template-columns: minmax(0, 1fr); }
    form button { justify-self: start; }
    .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .facts dd + dt { margin-top: 8px; }
    .pools-head { align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { .plugin, .preview, .spinning :global(svg) { animation: none; } }
</style>
