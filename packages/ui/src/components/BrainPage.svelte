<script lang="ts">
  import { ArrowUp, Brain, Check, ChevronRight, FileText, Folder, GitBranch, Puzzle, RefreshCw, Sparkles } from '@lucide/svelte';
  import { RpcErrorCode, type BrainConfig, type BrainStatus, type RpcResult } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let status = $state.raw<BrainStatus | null>(null);
  let path = $state('');
  let busy = $state(false);
  let error = $state('');
  let folders = $state.raw<RpcResult<'projects.browse'> | null>(null);
  let editing = $state(false);
  let selected = $state<'instructions' | 'skill' | 'plugin'>('instructions');
  let revision = 0;
  const t = strings.brain;
  const kinds = ['instructions', 'skill', 'plugin'] as const;
  const icons = { instructions: FileText, skill: Sparkles, plugin: Puzzle };
  let entries = $derived(status?.entries.filter(entry => entry.kind === selected) ?? []);
  let folderName = $derived(status?.config.path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '');
  let autoPull = $derived(status?.config.autoPull ?? { onStartup: false, intervalMinutes: 0 });
  const failure = (cause: unknown) => cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound ? t.missing : cause instanceof Error ? cause.message : String(cause);

  $effect(() => {
    const client = store.client;
    if (!client || !store.owner || store.connection !== 'ready') return;
    const current = ++revision;
    status = null; error = ''; folders = null; editing = false; busy = true;
    void client.call('brain.status', {}).then(next => {
      if (current !== revision) return;
      status = next; path = next.config.path ?? '';
    }).catch(cause => { if (current === revision) error = failure(cause); })
      .finally(() => { if (current === revision) busy = false; });
    return () => { ++revision; };
  });

  async function run(action: 'save' | 'refresh' | 'sync' | 'disconnect' | 'toggle' | 'auto' | 'global', policy?: BrainConfig['autoPull']) {
    const client = store.client;
    if (!client || busy) return;
    const current = revision;
    busy = true; error = '';
    try {
      const next = action === 'save' || action === 'disconnect' || action === 'toggle' || action === 'auto' || action === 'global'
        ? await client.call('brain.configure', {
          ...status?.config,
          path: action === 'disconnect' ? null : action === 'save' ? path.trim() : status!.config.path,
          enabled: action === 'disconnect' ? false : action === 'toggle' ? !status!.config.enabled : status?.config.path ? status.config.enabled : true,
          ...(policy ? { autoPull: policy } : {}),
          ...(action === 'global' ? { globalInstructions: !status!.config.globalInstructions } : {}),
        })
        : action === 'sync' ? await client.call('brain.sync', {}) : await client.call('brain.status', {});
      if (current !== revision) return;
      status = next;
      if (action === 'save' || action === 'disconnect' || action === 'toggle') {
        path = next.config.path ?? ''; folders = null; editing = false;
      }
    } catch (cause) { if (current === revision) error = failure(cause); }
    finally { if (current === revision) busy = false; }
  }

  async function browse(target?: string) {
    const client = store.client;
    if (!client || busy) return;
    const current = revision;
    busy = true; error = '';
    try {
      const next = await client.call('projects.browse', target ? { path: target } : {});
      if (current === revision) folders = next;
    } catch (cause) { if (current === revision) error = failure(cause); }
    finally { if (current === revision) busy = false; }
  }
</script>

<div class="page" data-testid="brain-page" aria-busy={busy}>
  <header><div><h1>{t.heading}</h1><p>{t.description}</p></div></header>
  {#if error}<p class="error" role="alert" data-testid="brain-error">{error}</p>{/if}
  {#if status && !status.config.path}
    {#each status.links ?? [] as link (link.path)}
      {#if link.error}<p class="error" role="alert">{link.error}</p>{/if}
    {/each}
  {/if}
  {#if status?.config.path}
    <section class="brain-connection" data-testid="brain-sync-card">
      <div class="connection-top">
        <div class="folder-mark"><Brain size={24} strokeWidth={1.5} /></div>
        <div class="folder-info"><h2>{folderName}</h2><code>{status.config.path}</code></div>
        <button class="primary sync-button" disabled={busy || !status.git?.upstream || status.git.dirty} onclick={() => void run('sync')} data-testid="brain-sync"><RefreshCw size={15} />{busy ? t.working : t.sync}</button>
      </div>
      <div class="sync-state" role="status" data-testid="brain-last-sync">
        {#if status.git?.dirty}<span class="warning">{t.dirty}</span>
        {:else if !status.git}<span>{t.noGit}</span>
        {:else if !status.git.upstream}<span>{t.noUpstream}</span>
        {:else if status.git.ahead || status.git.behind}<span>{t.counts.replace('{ahead}', String(status.git.ahead)).replace('{behind}', String(status.git.behind))}</span>
        {:else}<Check size={14} /><span>{status.lastSync ? `${t.lastSync} ${new Date(status.lastSync).toLocaleString()}` : t.never}</span>{/if}
      </div>
      <div class="connection-bottom">
        <label class="sharing"><input type="checkbox" role="switch" checked={status.config.enabled} onchange={event => { event.currentTarget.checked = status!.config.enabled; void run('toggle'); }} disabled={busy} data-testid="brain-enabled" /><span>{t.enabled}</span></label>
        <button class="ghost small" disabled={busy} onclick={() => { editing = !editing; path = status!.config.path!; folders = null; }} data-testid="brain-change">{editing ? t.cancel : t.change}</button>
      </div>
      <div class="global-instructions">
        <label class="sharing"><input type="checkbox" role="switch" checked={status.config.globalInstructions ?? false} disabled={busy || !status.config.enabled} data-testid="brain-global" onchange={event => { event.currentTarget.checked = status!.config.globalInstructions ?? false; void run('global'); }} /><span>{t.globalInstructions}</span></label>
        {#if status.links?.length}
          <details class="global-links" data-testid="brain-links" open={status.links.some(link => link.state === 'blocked')}>
            <summary>{t.globalDetails}<span>{status.links.filter(link => link.state !== 'blocked').length}/{status.links.length}</span></summary>
            <p>{t.globalHint}</p>
            {#each status.links as link (link.path)}
              <div class="link-row"><span>{link.name}</span><span class:error={link.state === 'blocked'}>{t[link.state]}</span><code>{link.path}</code>{#if link.error}<p class="error">{link.error}</p>{/if}</div>
            {/each}
          </details>
        {/if}
      </div>
      {#if status.git?.upstream || status.config.autoPull}
        <div class="automation">
          <h3>{t.autoPull}</h3>
          <label class="sharing"><input type="checkbox" role="switch" checked={autoPull.onStartup} disabled={busy} data-testid="brain-startup" onchange={event => { event.currentTarget.checked = autoPull.onStartup; void run('auto', { ...autoPull, onStartup: !autoPull.onStartup }); }} /><span>{t.onStartup}</span></label>
          <div class="interval-row">
            <label class="sharing"><input type="checkbox" role="switch" checked={autoPull.intervalMinutes > 0} disabled={busy} data-testid="brain-periodic" onchange={event => { event.currentTarget.checked = autoPull.intervalMinutes > 0; void run('auto', { ...autoPull, intervalMinutes: autoPull.intervalMinutes ? 0 : 15 }); }} /><span>{t.periodic}</span></label>
            {#if autoPull.intervalMinutes > 0}
              <label class="interval-value"><input type="number" min="1" max="1440" step="1" value={autoPull.intervalMinutes} aria-label={t.interval} disabled={busy} data-testid="brain-interval" onchange={event => { const input = event.currentTarget; const minutes = input.valueAsNumber; input.value = String(autoPull.intervalMinutes); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { error = t.intervalHint; return; } void run('auto', { ...autoPull, intervalMinutes: minutes }); }} /><span>{t.minutes}</span></label>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/if}
  {#if status && (!status.config.path || editing)}
    <form class="folder-form" onsubmit={event => { event.preventDefault(); void run('save'); }}>
      {#if !status.config.path}<Brain size={32} strokeWidth={1.5} /><h2>{t.empty}</h2><p>{t.emptyHint}</p>{/if}
      <label for="brain-path">{t.folder}</label>
      <div class="path-row"><input id="brain-path" data-testid="brain-path" bind:value={path} placeholder={t.pathHint} disabled={busy} /><button type="button" disabled={busy} onclick={() => void browse(path || undefined)}><Folder size={15} />{t.browse}</button></div>
      {#if folders}
        <div class="folders" data-testid="brain-folders">
          <code>{folders.path}</code>
          {#if folders.parent}<button type="button" class="ghost" disabled={busy} onclick={() => void browse(folders!.parent!)}><ArrowUp size={15} />{strings.connection.parent}</button>{/if}
          {#each folders.directories as directory (directory.path)}<button type="button" class="ghost folder" disabled={busy} onclick={() => void browse(directory.path)}><Folder size={15} />{directory.name}</button>{/each}
          <button type="button" disabled={busy} onclick={() => { path = folders!.path; folders = null; }}>{t.useFolder}</button>
        </div>
      {/if}
      <div class="form-actions"><button class="primary" type="submit" disabled={busy || !path.trim()} data-testid="brain-save">{status.config.path ? t.saveChanges : t.save}</button>{#if status.config.path}<button type="button" class="ghost" disabled={busy} onclick={() => void run('disconnect')} data-testid="brain-disconnect">{t.disconnect}</button>{/if}</div>
    </form>
  {/if}
  {#if status?.config.path}
    <section class="inventory" data-testid="brain-inventory" aria-label={t.detected}>
      <div class="catalog-nav">
        <div class="categories" role="group" aria-label={t.detected}>
          {#each kinds as kind (kind)}
            <button class="ghost category" class:active={selected === kind} aria-pressed={selected === kind} onclick={() => selected = kind} data-testid="brain-category-{kind}">{t[kind]}<span>{status.entries.filter(entry => entry.kind === kind).length}</span></button>
          {/each}
        </div>
        <button class="ghost icon" disabled={busy} onclick={() => void run('refresh')} aria-label={t.refresh} data-testid="brain-refresh"><RefreshCw size={15} /></button>
      </div>
      {#each status.problems as problem, index (`${index}:${problem}`)}<p class="error">{problem}</p>{/each}
      {#each entries as entry (entry.path)}
        {@const Icon = icons[entry.kind]}
        <details class="entry" data-testid="brain-entry">
          <summary><Icon size={17} strokeWidth={1.5} /><span>{entry.name}</span>{#if entry.error}<span class="error-indicator" aria-label={entry.error}>!</span>{/if}<ChevronRight size={14} class="chevron" /></summary>
          <div class="entry-details">{#if entry.description}<p>{entry.description}</p>{/if}<code>{entry.path}</code>{#if entry.error}<p class="error">{entry.error}</p>{/if}</div>
        </details>
      {/each}
      {#if !entries.length}<p class="empty-category">{t.noEntries}</p>{/if}
      {#if selected === 'plugin'}<p class="catalog-hint">{t.pluginHint}</p>{/if}
    </section>
    {#if status.git}<details class="git-details"><summary><GitBranch size={14} />{t.details}</summary><div><code>{status.git.branch}{#if status.git.upstream} → {status.git.upstream}{/if}</code><p>{t.counts.replace('{ahead}', String(status.git.ahead)).replace('{behind}', String(status.git.behind))}</p></div></details>{/if}
  {/if}
</div>

<style>
  /* The padding is the settings page's own (app.css), so the title lines up with every other tab. */
  .page { width: 100%; }
  .page > :is(section, form, details, .error) { max-width: var(--settings-width); }
  h1 { margin: 0; font-size: var(--text-lg); }
  h2 { margin: 0; font-size: var(--text-md); font-weight: 600; }
  header { margin-bottom: 28px; }
  p { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  header p { margin-top: 6px; }
  .brain-connection { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); overflow: hidden; }
  .connection-top { display: flex; align-items: center; gap: 14px; padding: 24px 24px 0; }
  .folder-mark { width: 44px; height: 44px; display: grid; place-items: center; border-radius: var(--radius-md); background: var(--color-surface-2); flex: none; }
  .folder-info { flex: 1; min-width: 0; }
  .folder-info h2 { overflow-wrap: anywhere; margin-bottom: 4px; }
  .sync-button { flex: none; }
  code { display: block; font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .sync-state { display: flex; gap: 6px; align-items: center; padding: 16px 24px 24px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .sync-state :global(svg) { flex: none; }
  .connection-bottom { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px 12px 24px; border-top: 1px solid var(--color-border); }
  .sharing { display: flex; align-items: center; gap: 10px; font-size: var(--text-sm); }
  .global-instructions { padding: 16px 24px; border-top: 1px solid var(--color-border); }
  .global-links { margin-top: 12px; font-size: var(--text-sm); }
  .global-links summary { display: flex; gap: 10px; align-items: center; cursor: pointer; color: var(--color-muted-foreground); }
  .global-links summary span { font-variant-numeric: tabular-nums; }
  .link-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; padding: 12px 0; border-top: 1px solid var(--color-border); }
  .link-row code, .link-row p { grid-column: 1 / -1; margin: 0; }
  .link-row > span:nth-child(2):not(.error) { color: var(--color-muted-foreground); }
  .automation { display: grid; gap: 14px; padding: 20px 24px; border-top: 1px solid var(--color-border); }
  .automation h3 { margin: 0; font-size: var(--text-sm); font-weight: 500; color: var(--color-muted-foreground); }
  .interval-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--control); }
  .interval-value { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .interval-value input { width: 78px; }
  .folder-form { padding: 24px; margin-top: 16px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  .folder-form h2 { margin-top: 16px; }
  .folder-form p { margin: 6px 0 24px; }
  .folder-form label { font-size: var(--text-sm); }
  .path-row { display: flex; gap: 8px; margin: 8px 0 16px; }
  .path-row input { flex: 1; min-width: 0; }
  .form-actions { display: flex; gap: 8px; }
  .inventory { margin-top: 28px; }
  .catalog-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--color-border); padding-bottom: 10px; }
  .categories { display: flex; gap: 4px; min-width: 0; }
  .category { gap: 8px; font-size: var(--text-sm); }
  .category span { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .category.active { color: var(--color-foreground); background: var(--color-active); }
  .entry { border-bottom: 1px solid var(--color-border); }
  .entry summary { display: flex; gap: 12px; align-items: center; min-height: 52px; padding: 12px; cursor: pointer; list-style: none; font-size: var(--text-sm); border-radius: var(--radius-md); }
  summary::-webkit-details-marker { display: none; }
  .entry summary:hover { background: var(--color-hover); }
  .entry summary > span:first-of-type { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .entry summary :global(svg) { color: var(--color-muted-foreground); flex: none; }
  .entry[open] :global(.chevron) { transform: rotate(90deg); }
  .entry-details { padding: 0 40px 16px; }
  .entry-details p { margin: 0 0 8px; }
  .empty-category { padding: 24px 12px; }
  .catalog-hint { margin: 12px 0; }
  .git-details { margin-top: 20px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .git-details summary { display: flex; align-items: center; gap: 8px; cursor: pointer; width: fit-content; list-style: none; }
  .git-details > div { padding: 12px 0; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  .error-indicator { color: var(--color-danger); font-weight: 600; }
  .warning { color: var(--color-live); }
  .folders { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; padding: 12px; margin-bottom: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .folder { justify-content: flex-start; flex-shrink: 0; }
  @media (max-width: 720px) {
    .page { padding: 20px 16px; }
    .connection-top { padding: 20px 16px 0; flex-wrap: wrap; gap: 12px; }
    .sync-button { width: 100%; }
    .sync-state { padding: 12px 16px 20px; }
    .connection-bottom { padding: 12px 16px; flex-wrap: wrap; gap: 8px; }
    .automation { padding: 16px; }
    .global-instructions { padding: 16px; }
    .folder-form { padding: 20px 16px; }
    .path-row { flex-wrap: wrap; }
    .path-row input { flex-basis: 100%; }
    .category { padding-inline: 8px; gap: 5px; }
    .catalog-nav { gap: 4px; }
  }
</style>
