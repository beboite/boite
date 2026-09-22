<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, Puzzle, RefreshCw, ShieldAlert, TriangleAlert } from '@lucide/svelte';
  import type { PluginPool, PluginPreview, PluginRejected, PluginState, RpcParams } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { confirm } from '../lib/confirm.svelte';
  import QuotaList from './QuotaList.svelte';

  let { store }: { store: Store } = $props();
  const t = strings.plugins;

  let plugins = $state<PluginState[]>([]);
  let loaded = $state(false);
  let pools = $state<Record<string, PluginPool[]>>({});
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let error = $state('');

  let url = $state('');
  let ref = $state('');
  let inspecting = $state(false);
  let adding = $state(false);
  let preview = $state<PluginPreview | null>(null);
  let inspectError = $state('');

  /** Anything with files on disk, and every plugin added from a URL whatever its state. */
  let installed = $derived(plugins.filter((plugin) => plugin.origin === 'url' || plugin.version !== null));
  let recommended = $derived(plugins.filter((plugin) => plugin.origin === 'recommended' && plugin.version === null));

  const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
  const short = (commit: string) => commit.slice(0, 7);
  const bare = (address: string) => address.replace(/^https:\/\//, '');
  const providerName = (id: string) => store.providers.find((provider) => provider.id === id)?.name ?? id;

  /** The core's order: recommended plugins as shipped, then URL ones by id. */
  function order(a: PluginState, b: PluginState): number {
    if (a.origin !== b.origin) return a.origin === 'recommended' ? -1 : 1;
    return a.origin === 'url' ? a.id.localeCompare(b.id) : 0;
  }

  /** A URL plugin that comes back not installed is gone: its uninstall or its first install's cancel. */
  function put(next: PluginState) {
    const rest = plugins.filter((plugin) => plugin.id !== next.id);
    if (next.version === null) delete pools[next.id];
    plugins = next.origin === 'url' && next.status === 'not-installed' ? rest : [...rest, next].sort(order);
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
      title: fill(t.removeTitle, { name: plugin.name }), body: t.removeBody,
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

  function stateLine(plugin: PluginState): string {
    switch (plugin.status) {
      case 'installed':
        return plugin.availableVersion && plugin.availableVersion !== plugin.version
          ? `${t.stateInstalled} · ${fill(t.updateAvailable, { version: `v${plugin.availableVersion}` })}` : t.stateInstalled;
      case 'installing': return `${t.stateInstalling} · ${plugin.progress}%`;
      case 'error': return t.stateError;
      case 'rejected': return t.stateRejected;
      default: return plugin.origin === 'recommended' ? t.recommendedBy : t.stateAvailable;
    }
  }

  onMount(() => {
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
      loaded = true;
      await Promise.all(rows.filter((plugin) => plugin.status === 'installed' && plugin.pools.length > 0).map((plugin) => loadPools(plugin.id)));
    }).catch((cause) => {
      error = messageOf(cause);
      loaded = true;
    });
    return () => { disposed = true; off(); };
  });
</script>

{#snippet refusal(rejected: PluginRejected)}
  <div class="refusal" role="alert" data-testid="plugin-rejected" data-field={rejected.field}>
    <p class="refusal-title"><ShieldAlert size={15} strokeWidth={1.75} />{t.refusedTitle}</p>
    <dl class="facts">
      <dt>{t.refusedFile}</dt><dd class="mono">{rejected.file}</dd>
      <dt>{t.refusedField}</dt><dd class="mono">{rejected.field}</dd>
      <dt>{t.refusedExpected}</dt><dd>{rejected.expected}</dd>
    </dl>
  </div>
{/snippet}

{#snippet row(plugin: PluginState)}
  {@const working = busy[plugin.id] === true}
  <div class="plugin" data-testid="plugin-row" data-plugin={plugin.id} data-status={plugin.status}>
    <div class="line">
      <span class="glyph" aria-hidden="true"><Puzzle size={16} strokeWidth={1.75} /></span>
      <div class="who">
        <h3>{plugin.name}{#if plugin.version ?? plugin.availableVersion}<span class="version">v{plugin.version ?? plugin.availableVersion}</span>{/if}</h3>
        <p class="state">
          <span class="dot" class:ok={plugin.status === 'installed'} class:live={plugin.status === 'installing'}
            class:bad={plugin.status === 'error' || plugin.status === 'rejected'}></span>{stateLine(plugin)}
        </p>
      </div>
      <div class="act">
        {#if plugin.status === 'installing'}
          <button class="quiet small" data-testid="plugin-cancel" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.cancel')}>{strings.common.cancel}</button>
        {:else if plugin.status === 'not-installed'}
          <button class="primary small" data-testid="plugin-install" data-plugin={plugin.id} disabled={working || plugin.artifact === null} onclick={() => void change(plugin, 'plugins.install')}><Download size={14} />{t.install}</button>
        {:else}
          {#if plugin.status === 'installed' && plugin.availableVersion && plugin.availableVersion !== plugin.version}
            <button class="small" data-testid="plugin-update" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.install')}>{fill(t.update, { version: `v${plugin.availableVersion}` })}</button>
          {/if}
          {#if plugin.status === 'error' || (plugin.status === 'rejected' && plugin.origin === 'recommended')}
            <button class="small" data-testid="plugin-retry" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.install')}><RefreshCw size={14} />{plugin.status === 'error' ? t.retry : t.reinstall}</button>
          {/if}
          <button class="ghost small" data-testid="plugin-uninstall" data-plugin={plugin.id} disabled={working} onclick={() => void change(plugin, 'plugins.uninstall')}>{t.remove}</button>
        {/if}
      </div>
    </div>
    {#if plugin.status === 'installing'}
      <div class="track" role="progressbar" aria-label={t.stateInstalling} aria-valuemin={0} aria-valuemax={100} aria-valuenow={plugin.progress} data-testid="plugin-progress" data-plugin={plugin.id}>
        <span class="bar" style:width="{plugin.progress}%"></span>
      </div>
    {/if}
    {#if plugin.description}<p class="description">{plugin.description}</p>{/if}
    {#if plugin.source}
      <p class="meta">
        <a href={plugin.homepage ?? plugin.source.url} target="_blank" rel="noreferrer">{bare(plugin.source.url)}</a>
        <span class="mono">{fill(t.atCommit, { ref: plugin.source.ref, commit: short(plugin.source.commit) })}</span>
      </p>
    {:else if plugin.origin === 'recommended' && plugin.homepage && plugin.version !== null}
      <p class="meta">{t.recommendedBy} · <a href={plugin.homepage} target="_blank" rel="noreferrer">{t.source}</a></p>
    {:else if plugin.homepage}
      <p class="meta"><a href={plugin.homepage} target="_blank" rel="noreferrer">{t.source}</a></p>
    {/if}
    {#if plugin.error}<p class="bad" role="alert">{plugin.error}</p>{/if}
    {#if errors[plugin.id]}<p class="bad" role="alert">{errors[plugin.id]}</p>{/if}
    {#if plugin.rejected}{@render refusal(plugin.rejected)}{/if}
    {#if plugin.status === 'installed' && plugin.pools.length > 0}
      <div class="pools">
        <div class="pools-head">
          <div class="who">
            <h4 class="section-label">{t.pools}</h4>
            <p class="hint">{t.cliScope}</p>
          </div>
          <button class="quiet small" data-testid="plugin-refresh" data-plugin={plugin.id} disabled={working} onclick={() => void loadPools(plugin.id, true)}><RefreshCw size={14} />{t.refresh}</button>
        </div>
        {#each pools[plugin.id] ?? [] as pool (pool.provider)}
          <div class="pool" data-testid="plugin-pool" data-plugin={plugin.id} data-provider={pool.provider}>
            <div class="pool-head">
              <h5>{providerName(pool.provider)}</h5>
              <button class="quiet small" disabled={working} onclick={() => void accountAction(plugin, pool.provider, 'add')}>{t.add}</button>
            </div>
            {#if pool.accounts.length === 0}<p class="hint">{t.empty}</p>{/if}
            {#each pool.accounts as account (account.email)}
              <div class="saved-account" data-testid="plugin-account" data-email={account.email}>
                <QuotaList compact rows={[{ accountId: account.email, providerId: pool.provider, providerName: account.email, label: account.active ? t.active : '', enabled: true,
                  status: account.checkedSecondsAgo === null ? 'unavailable' : 'ready', windows: account.windows,
                  checkedAt: account.checkedSecondsAgo === null ? null : Date.now() - account.checkedSecondsAgo * 1000, error: null }]} />
                <div class="account-actions">
                  <button class="quiet small" disabled={working || account.active} data-testid="plugin-switch" onclick={() => void accountAction(plugin, pool.provider, 'switch', account.email)}>{t.switch}</button>
                  <button class="ghost small" disabled={working} onclick={() => void accountAction(plugin, pool.provider, 'remove', account.email)}>{t.forget}</button>
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="page" data-testid="plugins-page">
  <header><div><h1>{t.heading}</h1><p>{t.intro}</p></div></header>
  {#if error}<p class="bad" role="alert">{error}</p>{/if}

  <section aria-labelledby="plugins-installed" data-testid="plugins-installed">
    <h2 id="plugins-installed" class="section-label">{t.installedHeading}</h2>
    {#if installed.length === 0}
      <p class="hint empty-note">{loaded ? t.installedEmpty : ''}</p>
    {:else}
      <div class="card list">
        {#each installed as plugin (plugin.id)}{@render row(plugin)}{/each}
      </div>
    {/if}
  </section>

  <section aria-labelledby="plugins-recommended" data-testid="plugins-recommended">
    <h2 id="plugins-recommended" class="section-label">{t.recommendedHeading}</h2>
    {#if recommended.length === 0}
      <p class="hint empty-note">{loaded ? t.recommendedAllInstalled : ''}</p>
    {:else}
      <div class="card list">
        {#each recommended as plugin (plugin.id)}{@render row(plugin)}{/each}
      </div>
    {/if}
  </section>

  <section aria-labelledby="plugins-add" data-testid="plugins-add">
    <h2 id="plugins-add" class="section-label">{t.addHeading}</h2>
    <div class="card add">
      <p class="hint">{t.addHint}</p>
      <form onsubmit={inspect}>
        <label class="url">
          <span>{t.urlLabel}</span>
          <input data-testid="plugin-url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder={t.urlPlaceholder} bind:value={url} />
        </label>
        <label class="ref">
          <span>{t.refLabel}</span>
          <input data-testid="plugin-ref" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder={t.refPlaceholder} bind:value={ref} />
        </label>
        <button type="submit" data-testid="plugin-inspect" disabled={url.trim() === '' || inspecting}>{inspecting ? t.inspecting : t.inspect}</button>
      </form>
      {#if inspectError}<p class="bad" role="alert" data-testid="plugin-inspect-error">{inspectError}</p>{/if}
      {#if preview}
        <div class="preview" data-testid="plugin-preview" data-rejected={preview.rejected !== null}>
          {#if preview.manifest}
            <div class="line">
              <span class="glyph" aria-hidden="true"><Puzzle size={16} strokeWidth={1.75} /></span>
              <div class="who">
                <h3>{preview.manifest.name}<span class="version">v{preview.manifest.version}</span></h3>
                <p class="state">{preview.manifest.description}</p>
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
              <dt>{t.previewPools}</dt>
              <dd>{(preview.manifest?.provides.accountPools?.providers ?? []).map(providerName).join(', ')}</dd>
            {/if}
          </dl>
          {#if preview.rejected === null}
            <p class="trust"><TriangleAlert size={15} strokeWidth={1.75} />{t.trust}</p>
          {/if}
          <div class="act end">
            <button class="quiet small" data-testid="plugin-dismiss" onclick={() => { preview = null; }}>{preview.rejected ? t.dismiss : strings.common.cancel}</button>
            {#if preview.previewId && preview.manifest}
              <button class="primary small" data-testid="plugin-add" disabled={adding} onclick={() => void add()}><Download size={14} />{fill(t.confirmAdd, { name: preview.manifest.name })}</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </section>
</div>

<style>
  .page { container-type: inline-size; }
  section { max-width: var(--settings-width); margin-bottom: 24px; }
  section > h2 { margin: 0 0 8px; }
  .hint { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; }
  .empty-note { min-height: 1.5em; }
  .bad { margin: 0; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; }

  /* One card per section, one row per plugin, like the Providers checklist. */
  .page .list { padding: 0; overflow: hidden; }
  .plugin { display: grid; gap: 8px; padding: 12px 16px; animation: rise var(--dur-3) var(--ease-out-quint); }
  .plugin + .plugin { border-top: 1px solid var(--color-border); }

  .line { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .glyph { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .who { flex: 1; min-width: 0; display: grid; gap: 2px; }
  h3 { margin: 0; display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--text-base); font-weight: 600; overflow-wrap: anywhere; }
  .version { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
  .state { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }

  /* Hue is for status only: green once installed, amber while downloading, red when refused. */
  .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.live { background: var(--color-live); }
  .dot.bad { background: var(--color-danger); }

  .act { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
  .act.end { justify-content: flex-end; }
  .act button, .pools button, .account-actions button { gap: 6px; }

  .track { height: 2px; border-radius: 999px; background: var(--color-surface-3); overflow: hidden; }
  .bar { display: block; height: 100%; background: var(--color-foreground); transition: width var(--dur-2) var(--ease-out-quint); }

  .description { margin: 0; font-size: var(--text-sm); line-height: 1.5; }
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
  .pools-head, .pool-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h4 { margin: 0; }
  h5 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .pool { display: grid; gap: 8px; }
  .saved-account { display: grid; gap: 6px; }
  .account-actions { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }

  .add { display: grid; gap: 12px; }
  form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 180px) auto; align-items: end; gap: 8px; }
  form input { width: 100%; }
  .preview { display: grid; gap: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); animation: rise var(--dur-3) var(--ease-out-quint); }
  .trust { margin: 0; display: flex; align-items: flex-start; gap: 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); line-height: 1.5; }
  .trust :global(svg) { flex: none; margin-top: 2px; color: var(--color-live); }

  /* The settings column, not the window: the page is as narrow in a split shell as on a phone. */
  @container (max-width: 560px) {
    .line { flex-wrap: wrap; }
    .line .act { width: 100%; justify-content: flex-start; padding-left: 44px; }
    form { grid-template-columns: minmax(0, 1fr); }
    form button { justify-self: start; }
    .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .facts dd + dt { margin-top: 8px; }
    .pools-head { align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { .plugin, .preview { animation: none; } }
</style>
